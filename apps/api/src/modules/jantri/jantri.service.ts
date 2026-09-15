import { db, shifts, transactions, transactionEntries, ledgers, agents } from '@pb/database';
import { eq, and, inArray, sql as dsql } from 'drizzle-orm';
import { redis } from '../../config/redis.js';
import { NotFoundError } from '../../common/errors.js';
import { JantriViewDto, JantriCell, HarufCell } from '@pb/types';

export class JantriService {
  static async getJantriView(shiftId: number): Promise<JantriViewDto> {
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId));
    if (!shift) throw new NotFoundError('Shift not found');

    const jantriKey = `jantri:${shift.id}:${shift.openDate}`;
    let cachedHash: Record<string, string> = {};

    try {
      cachedHash = await redis.hgetall(jantriKey);
    } catch (err) {
      console.warn('[Jantri] Redis read failed, falling back to SQL:', err);
    }

    if (!cachedHash || Object.keys(cachedHash).length === 0) {
      cachedHash = await this.rebuildJantriFromSql(shift.id, shift.openDate);
    }

    const grid: JantriCell[] = [];
    let maxLiability = 0;
    const totalCollected = parseFloat(cachedHash['TOTAL_COLLECTED'] || '0');

    for (let i = 0; i < 100; i++) {
      const numStr = i.toString().padStart(2, '0');
      const amount = parseFloat(cachedHash[numStr] || '0');
      const liability = amount * 90;
      if (liability > maxLiability) maxLiability = liability;

      grid.push({
        number: numStr,
        totalAmount: amount,
        liability,
        isMaxRisk: false,
      });
    }

    if (maxLiability > 0) {
      for (const cell of grid) {
        if (cell.liability === maxLiability) {
          cell.isMaxRisk = true;
        }
      }
    }

    const haruf: HarufCell[] = [];
    for (let d = 0; d < 10; d++) {
      const dStr = d.toString();
      const andarAmt = parseFloat(cachedHash[`A_${dStr}`] || '0');
      const baharAmt = parseFloat(cachedHash[`B_${dStr}`] || '0');
      haruf.push({
        digit: dStr,
        andarAmount: andarAmt,
        baharAmount: baharAmt,
      });
    }

    return {
      shiftId: shift.id,
      shiftName: shift.name,
      shiftDate: shift.openDate,
      totalCollected,
      totalRisk: maxLiability,
      grid,
      haruf,
    };
  }

  private static async rebuildJantriFromSql(shiftId: number, openDate: string): Promise<Record<string, string>> {
    const hash: Record<string, string> = {};
    let totalCollected = 0;

    // Scoped to the current cycle (openDate) — shift rows are reused day-to-day by the
    // rollover worker, so an unscoped query here would pull in every past cycle's slips too.
    const activeSlips = await db.select().from(transactions).where(
      and(
        eq(transactions.shiftId, shiftId),
        eq(transactions.status, 'ACTIVE'),
        dsql`${transactions.createdAt}::date = ${openDate}::date`
      )
    );

    const slipIds = activeSlips.map(s => s.id);
    if (slipIds.length > 0) {
      const entries = await db.select().from(transactionEntries).where(
        inArray(transactionEntries.transactionId, slipIds)
      );

      for (const e of entries) {
        const amt = parseFloat(e.amount);
        totalCollected += amt;
        const key = e.entryType === 'HARUF_ANDAR'
          ? `A_${e.numberValue}`
          : e.entryType === 'HARUF_BAHAR'
          ? `B_${e.numberValue}`
          : e.numberValue;

        const cur = parseFloat(hash[key] || '0');
        hash[key] = (cur + amt).toString();
      }
    }

    hash['TOTAL_COLLECTED'] = totalCollected.toString();

    try {
      const jantriKey = `jantri:${shiftId}:${openDate}`;
      if (Object.keys(hash).length > 0) {
        await redis.hset(jantriKey, hash);
      }
    } catch {}

    return hash;
  }

  // Powers Live/Declare Prediction: per-candidate-number liability preview (same flat *90
  // rate convention already used by the Jantri grid's "liability" field, for consistency),
  // plus a party-wise Sale/P&L breakdown for whichever number is currently focused, and
  // an Agent Groups rollup of the same party rows.
  static async getPredictionData(shiftId: number, focusNumber?: string) {
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId));
    if (!shift) throw new NotFoundError('Shift not found');

    const activeSlips = await db.select().from(transactions).where(
      and(eq(transactions.shiftId, shiftId), eq(transactions.status, 'ACTIVE'))
    );
    const slipIds = activeSlips.map(s => s.id);
    const txById = new Map(activeSlips.map(s => [s.id, s]));

    const entries = slipIds.length > 0
      ? await db.select().from(transactionEntries).where(inArray(transactionEntries.transactionId, slipIds))
      : [];

    const liabilityByNumber: Record<string, number> = {};
    let totalCollected = 0;
    for (const e of entries) {
      const amt = parseFloat(e.amount);
      totalCollected += amt;
      if (e.entryType === 'DARA') {
        liabilityByNumber[e.numberValue] = (liabilityByNumber[e.numberValue] || 0) + amt * 90;
      }
    }

    const numberPreview = Array.from({ length: 100 }, (_, i) => {
      const n = i.toString().padStart(2, '0');
      const liability = liabilityByNumber[n] || 0;
      return { number: n, liability, profitLoss: totalCollected - liability };
    });

    const partyIds = Array.from(new Set(activeSlips.map(s => s.partyId)));
    const partyRows = partyIds.length > 0
      ? await db.select({ id: ledgers.id, partyName: ledgers.partyName, agentId: ledgers.agentId })
          .from(ledgers).where(inArray(ledgers.id, partyIds))
      : [];
    const partyById = new Map(partyRows.map(p => [p.id, p]));

    const saleByParty = new Map<number, number>();
    const entriesByParty = new Map<number, typeof entries>();
    for (const slip of activeSlips) {
      saleByParty.set(slip.partyId, (saleByParty.get(slip.partyId) || 0) + parseFloat(slip.totalAmount));
    }
    for (const e of entries) {
      const tx = txById.get(e.transactionId);
      if (!tx) continue;
      if (!entriesByParty.has(tx.partyId)) entriesByParty.set(tx.partyId, []);
      entriesByParty.get(tx.partyId)!.push(e);
    }

    const focusPadded = focusNumber ? focusNumber.padStart(2, '0') : undefined;

    const partyRowsOut = Array.from(saleByParty.entries()).map(([partyId, sale]) => {
      const party = partyById.get(partyId);
      let pnl = sale;

      if (focusPadded) {
        const tensDigit = focusPadded[0];
        const unitsDigit = focusPadded[1];
        let payout = 0;
        for (const e of entriesByParty.get(partyId) || []) {
          let isWinner = false;
          if (e.entryType === 'DARA' && e.numberValue === focusPadded) isWinner = true;
          else if (e.entryType === 'HARUF_ANDAR' && e.numberValue === tensDigit) isWinner = true;
          else if (e.entryType === 'HARUF_BAHAR' && e.numberValue === unitsDigit) isWinner = true;
          if (isWinner) payout += parseFloat(e.amount) * parseFloat(e.rate);
        }
        pnl = sale - payout;
      }

      return {
        partyId,
        partyName: party?.partyName || 'UNKNOWN',
        agentId: party?.agentId ?? null,
        sale,
        pnl,
      };
    }).sort((a, b) => b.sale - a.sale);

    const agentIds = Array.from(new Set(partyRowsOut.map(p => p.agentId).filter((id): id is number => id != null)));
    const agentRows = agentIds.length > 0
      ? await db.select({ id: agents.id, agentName: agents.agentName }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const agentNameById = new Map(agentRows.map(a => [a.id, a.agentName]));

    const agentGroupMap = new Map<string, number>();
    for (const p of partyRowsOut) {
      const name = p.agentId ? (agentNameById.get(p.agentId) || 'UNKNOWN') : 'UNASSIGNED';
      agentGroupMap.set(name, (agentGroupMap.get(name) || 0) + p.sale);
    }
    const agentGroups = Array.from(agentGroupMap.entries())
      .map(([agentName, sale]) => ({ agentName, sale }))
      .sort((a, b) => b.sale - a.sale);

    return {
      shiftId: shift.id,
      shiftName: shift.name,
      totalCollected,
      focusNumber: focusPadded || null,
      numberPreview,
      parties: partyRowsOut,
      agentGroups,
    };
  }
}
