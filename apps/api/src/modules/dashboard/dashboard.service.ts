import { db, shifts, shiftRoleConfig, shiftCycles, sql } from '@pb/database';
import { eq, and, lt, ne } from 'drizzle-orm';

function parseToDate(val: any): Date {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  const str = String(val).trim();
  if (str.includes(' ') && !str.includes('Z') && !str.includes('+')) {
    return new Date(str.replace(' ', 'T') + 'Z');
  }
  if (!str.includes('Z') && !str.includes('+') && str.includes('-')) {
    return new Date(str + 'Z');
  }
  return new Date(str);
}

function formatStaffDate(val: any): string {
  const d = parseToDate(val);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  return `${day}-${month}-${year} ${hours}:${minutes} ${ampm}`;
}

const MARKET_DISPLAY_ORDER = [
  'DELHI BAZAAR',
  'SHRI GANESH',
  'JAI LUXMI',
  'PUNJAB DAY',
  'HYDERABAD',
  'HIMALAYA',
  'FARIDABAD',
  'NEW FARIDABAD',
  'GHAZIABAD',
  'GALI',
  'DESHAWER',
];

export class DashboardService {
  static async getDashboardMetrics(userRoleName?: string, userRoleId?: number) {
    // 1. Fetch only active shifts from database for the dashboard
    const shiftList = await db.select().from(shifts).where(eq(shifts.isActive, true));

    // Sort according to market operational order
    shiftList.sort((a, b) => {
      const idxA = MARKET_DISPLAY_ORDER.indexOf(a.name.toUpperCase());
      const idxB = MARKET_DISPLAY_ORDER.indexOf(b.name.toUpperCase());
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.id - b.id;
    });

    // 2. Fetch dynamic aggregate metrics from transactions table
    // Scoped to the CURRENT cycle only (t.created_at matches the shift's live open_date) —
    // shift rows are reused day-to-day (see the daily rollover worker), so an unscoped
    // sum here would accumulate all-time history instead of resetting each cycle.
    const txAggregates = await sql<Array<{
      shift_id: number;
      total_amount: string;
      total_count: number;
      total_entries: number;
      total_payout: string;
    }>>`
      SELECT
        t.shift_id,
        COALESCE(SUM(t.total_amount), 0)::numeric AS total_amount,
        COUNT(t.id)::int AS total_count,
        COALESCE((
          SELECT COUNT(te.id)
          FROM transaction_entries te
          JOIN transactions t2 ON te.transaction_id = t2.id
          WHERE t2.shift_id = t.shift_id AND t2.status != 'VOIDED' AND t2.created_at::date = s.open_date::date
        ), 0)::int AS total_entries,
        COALESCE((
          SELECT SUM(te.calculated_payout)
          FROM transaction_entries te
          JOIN transactions t2 ON te.transaction_id = t2.id
          WHERE t2.shift_id = t.shift_id AND t2.status != 'VOIDED' AND t2.created_at::date = s.open_date::date
        ), 0)::numeric AS total_payout
      FROM transactions t
      JOIN shifts s ON s.id = t.shift_id
      WHERE t.status != 'VOIDED' AND t.created_at::date = s.open_date::date
      GROUP BY t.shift_id, s.open_date
    `;

    const txMap = new Map<number, { totalAmount: number; totalCount: number; totalEntries: number; totalPayout: number }>();
    for (const row of txAggregates) {
      txMap.set(row.shift_id, {
        totalAmount: parseFloat(row.total_amount),
        totalCount: row.total_count,
        totalEntries: row.total_entries || row.total_count,
        totalPayout: parseFloat(row.total_payout),
      });
    }

    const now = new Date();
    const currentTimeStr = now.toTimeString().slice(0, 8);

    const shiftsWithMetrics: any[] = [];
    const declareNeeded: any[] = [];
    const unverifiedShifts: any[] = [];

    for (const s of shiftList) {
      const metrics = txMap.get(s.id) || { totalAmount: 0, totalCount: 0, totalEntries: 0, totalPayout: 0 };

      const roleConfigs = await db.select()
        .from(shiftRoleConfig)
        .where(eq(shiftRoleConfig.shiftId, s.id));

      let cutoffPassed = false;
      let remainingSec = 0;

      if (userRoleId) {
        const userConfig = roleConfigs.find(rc => rc.roleId === userRoleId);
        if (userConfig) {
          if (currentTimeStr > userConfig.closeTime || currentTimeStr < userConfig.openTime) {
            cutoffPassed = true;
          }
          const [h, m, sec] = userConfig.closeTime.split(':').map(Number);
          const closeDate = new Date();
          closeDate.setHours(h, m, sec, 0);
          remainingSec = Math.max(0, Math.floor((closeDate.getTime() - now.getTime()) / 1000));
        }
      }

      // Format date as "DD / MM / YYYY"
      let formattedDate = s.openDate;
      if (s.openDate.includes('-')) {
        const parts = s.openDate.split('-');
        if (parts.length === 3) {
          formattedDate = `${parts[2]} / ${parts[1]} / ${parts[0]}`;
        }
      }

      const shiftData = {
        id: s.id,
        name: s.name,
        openDate: formattedDate,
        rawOpenDate: s.openDate,
        status: s.status,
        declaredNumber: s.declaredNumber,
        totalAmount: metrics.totalAmount,
        totalCount: metrics.totalEntries || metrics.totalCount,
        totalPayout: metrics.totalPayout,
        cutoffPassed,
        timeRemainingSeconds: remainingSec,
        isActive: s.isActive ?? true,
      };

      shiftsWithMetrics.push(shiftData);

      // Shifts needing declaration: NOT declared yet, and closed or cutoff passed
      const isDeclared = !!s.declaredNumber || s.status === 'DECLARED' || s.status === 'AUDITED';
      if (!isDeclared && (s.status === 'CLOSED' || cutoffPassed || remainingSec === 0)) {
        // Declare Needed panel uses "DD-MM-YYYY" (distinct from the "DD / MM / YYYY" card format above)
        const declareDateStr = s.openDate.includes('-')
          ? (() => {
              const parts = s.openDate.split('-');
              return parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : s.openDate;
            })()
          : s.openDate;

        declareNeeded.push({
          ...shiftData,
          openDate: declareDateStr,
          isDeclared: false,
          terminal: 'T1',
          timestamp: formatStaffDate(new Date(s.updatedAt || s.createdAt || Date.now())),
        });
      }

      // Un-verified shifts: declared shifts awaiting audit
      if (s.status === 'DECLARED' || (s.declaredNumber && s.status !== 'AUDITED')) {
        unverifiedShifts.push(shiftData);
      }
    }

    // 2b. Historical undeclared cycles: previous days that were rolled over (by the shift
    // rollover worker) before ever being declared. The live shift row only tracks the
    // CURRENT cycle, so these are pulled from shift_cycles instead — this is what lets a
    // shift like "GHAZIABAD | 10-09-2026" keep showing here even after today's row has
    // already moved on to "11-09-2026".
    const todayStr = now.toISOString().slice(0, 10);
    const historicalUndeclared = await db.select({
      shiftId: shiftCycles.shiftId,
      shiftName: shifts.name,
      cycleDate: shiftCycles.cycleDate,
      status: shiftCycles.status,
      updatedAt: shiftCycles.updatedAt,
    })
      .from(shiftCycles)
      .innerJoin(shifts, eq(shiftCycles.shiftId, shifts.id))
      .where(and(
        ne(shiftCycles.status, 'DECLARED'),
        ne(shiftCycles.status, 'AUDITED'),
        lt(shiftCycles.cycleDate, todayStr),
        eq(shifts.isActive, true)
      ));

    for (const cyc of historicalUndeclared) {
      const parts = cyc.cycleDate.split('-');
      const declareDateStr = parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : cyc.cycleDate;

      declareNeeded.push({
        id: cyc.shiftId,
        name: cyc.shiftName,
        openDate: declareDateStr,
        rawOpenDate: cyc.cycleDate,
        status: cyc.status,
        declaredNumber: null,
        totalAmount: 0,
        totalCount: 0,
        cutoffPassed: true,
        timeRemainingSeconds: 0,
        isDeclared: false,
        terminal: 'T1',
        timestamp: formatStaffDate(new Date(cyc.updatedAt || Date.now())),
      });
    }

    // 2c. "Last Day X%" badge (MANAGER-only in the UI) — best-effort metric: % of active
    // shifts that were fully declared (DECLARED/AUDITED) for the previous calendar day.
    // Checks shift_cycles for yesterday's cycle first (shifts that already rolled over),
    // falling back to the live shifts row when a shift's cycle hasn't rolled past yesterday
    // yet. No live reference formula exists for this badge — flagged here as best-effort,
    // same honest convention used for TPC/HP-Amt/RBT elsewhere.
    const yesterday = new Date(`${todayStr}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const yesterdayCycles = await db.select().from(shiftCycles).where(eq(shiftCycles.cycleDate, yesterdayStr));
    const cycleStatusByShift = new Map(yesterdayCycles.map(c => [c.shiftId, c.status]));

    let lastDayTotal = 0;
    let lastDayDeclared = 0;
    for (const s of shiftList) {
      const status = cycleStatusByShift.get(s.id) || (s.openDate === yesterdayStr ? s.status : undefined);
      if (!status) continue;
      lastDayTotal++;
      if (status === 'DECLARED' || status === 'AUDITED') lastDayDeclared++;
    }
    const lastDayDeclaredPercent = lastDayTotal > 0 ? Math.round((lastDayDeclared / lastDayTotal) * 100) : 100;

    // 3. Fetch active staff working (both live working and idle matching pbmax1.com)
    const staffRows = await sql<Array<{
      id: number;
      full_name: string;
      role: string | null;
      designation: string;
      username: string | null;
      assigned_station: string | null;
      is_working_live: boolean;
      updated_at: Date | null;
      created_at: Date;
    }>>`
      SELECT 
        s.id,
        s.full_name,
        s.role,
        s.designation,
        s.username,
        s.assigned_station,
        s.is_working_live,
        s.updated_at,
        s.created_at
      FROM staff s
      WHERE s.is_active = true
      ORDER BY COALESCE(s.updated_at, s.created_at) DESC, s.id ASC
    `;

    const nowMs = Date.now();
    const staffWorking = staffRows.map((st) => {
      const partyName = st.assigned_station || st.full_name;
      const username = (st.username && st.username !== 'NONE') ? st.username : st.full_name;

      const lastActiveDate = parseToDate(st.updated_at || st.created_at);
      const lastActiveMs = lastActiveDate.getTime();
      const diffMinutes = (nowMs - lastActiveMs) / (1000 * 60);

      // Live Server Flow:
      // An operator is WORKING if is_working_live is true and they have had activity in the active session (<= 30 mins)
      // Otherwise they transition to IDLE
      const isWorking = Boolean(st.is_working_live && diffMinutes <= 30);

      return {
        id: st.id,
        partyName,
        username,
        code: `${partyName} | ${username}`,
        fullName: st.full_name,
        role: st.role || st.designation || 'DATA ENTRY OPERATOR',
        designation: st.designation || st.role || 'DATA ENTRY OPERATOR',
        isWorkingLive: isWorking,
        status: isWorking ? 'WORKING' : 'IDLE',
        timestamp: formatStaffDate(lastActiveDate),
      };
    });


    // ADMIN sees the live shift tiles but none of the three operational panels below them —
    // matches the live pbmax1.com ADMIN session exactly (Declare Needed / Un-Verified Shifts /
    // Staff Working all render empty there). MANAGER, DATA ENTRY OPERATOR and TALLY OPERATOR
    // keep the Staff Working panel's container visible but with no actual entries either
    // (confirmed live — the panel box renders, just always empty for these roles); Declare
    // Needed and Un-Verified Shifts are hidden entirely by the frontend for them, zeroed here
    // too as defense-in-depth. SUPER ADMIN/DEVELOPER and every other role keep seeing the
    // real data, unchanged.
    const isAdminRole = userRoleName === 'ADMIN';
    const hasReducedDeclarePanels = userRoleName === 'MANAGER' || userRoleName === 'DATA ENTRY OPERATOR' || userRoleName === 'TALLY OPERATOR';

    return {
      shifts: shiftsWithMetrics,
      declareNeeded: (isAdminRole || hasReducedDeclarePanels) ? [] : declareNeeded,
      unverifiedShifts: (isAdminRole || hasReducedDeclarePanels) ? [] : unverifiedShifts,
      staffWorking: (isAdminRole || hasReducedDeclarePanels) ? [] : staffWorking,
      lastDayDeclaredPercent,
    };
  }
}
