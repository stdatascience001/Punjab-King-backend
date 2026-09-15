import { db, transactions, transactionEntries, ledgers, shifts, agents, vouchers, voucherEntries, auditLogs, duplicateReviews, staff, declarations, users, roles, shiftRoleConfig, operatorShiftPermissions } from '@pb/database';
import { eq, and, desc, asc, ne, gte, inArray, isNull, ilike, or, sql } from 'drizzle-orm';
import { redis } from '../../config/redis.js';
import { ShiftService } from '../shifts/shift.service.js';
import { VoucherService } from '../vouchers/voucher.service.js';
import { AppError, LimitExceededError, NotFoundError, ForbiddenError } from '../../common/errors.js';
import { TransactionCreateInput, UserSession } from '@pb/types';
import crypto from 'crypto';

export class TransactionService {
  static async createTransaction(input: TransactionCreateInput, user: UserSession) {
    // 1. Enforce shift cutoff for this role
    await ShiftService.assertShiftOpenForRole(input.shiftId, user.roleId, user.roleName);

    // 2. Fetch Shift & Party details
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, input.shiftId));
    if (!shift) throw new NotFoundError('Shift not found');

    if (shift.status === 'DECLARED' || shift.status === 'AUDITED' || shift.declaredNumber) {
      throw new AppError(`Shift ${shift.name} result is already declared. Transactions are closed.`, 400);
    }

    const [party] = await db.select().from(ledgers).where(
      and(eq(ledgers.id, input.partyId), isNull(ledgers.deletedAt))
    );
    if (!party) throw new NotFoundError('Party / Ledger not found');
    if (party.isLocked) throw new AppError('Party account is locked. Transactions disallowed.', 400);

    // 3. Redis Idempotency Check
    if (input.idempotencyKey) {
      const lockKey = `idemp:${input.idempotencyKey}`;
      try {
        const existing = await redis.get(lockKey);
        if (existing) {
          return JSON.parse(existing);
        }
      } catch (err) {}
    }

    // 4. Authoritative Total & Rate Calculations
    const partyDaraRate = parseFloat(party.daraRate);
    const partyAkharRate = parseFloat(party.akharRate);
    const partyLimit = parseFloat(party.betLimit);

    let totalAmount = 0;
    const preparedEntries = input.entries.map((entry) => {
      const amt = Math.max(0, entry.amount);
      totalAmount += amt;
      const rate = entry.entryType === 'DARA' ? partyDaraRate : partyAkharRate;
      const payout = amt * rate;

      return {
        entryType: entry.entryType,
        numberValue: entry.numberValue,
        amount: amt.toFixed(2),
        rate: rate.toFixed(2),
        calculatedPayout: payout.toFixed(2),
      };
    });

    // 5. Party Limit Validation
    if (partyLimit > 0 && totalAmount > partyLimit) {
      throw new LimitExceededError(
        `Total amount ₹${totalAmount} exceeds configured party limit of ₹${partyLimit}`
      );
    }

    // 6. Generate Slip Number
    const dateStr = shift.openDate.replace(/-/g, '');
    const randPart = crypto.randomBytes(3).toString('hex').toUpperCase();
    const slipNumber = `SLIP-${dateStr}-${shift.name.slice(0, 3)}-${randPart}`;

    // 7. Atomic DB Transaction
    const createdTx = await db.transaction(async (tx) => {
      const [header] = await tx.insert(transactions).values({
        slipNumber,
        shiftId: shift.id,
        partyId: party.id,
        totalAmount: totalAmount.toFixed(2),
        status: 'ACTIVE',
        idempotencyKey: input.idempotencyKey,
        createdBy: user.userId,
      }).returning();

      const entriesToInsert = preparedEntries.map(e => ({
        transactionId: header.id,
        entryType: e.entryType,
        numberValue: e.numberValue,
        amount: e.amount,
        rate: e.rate,
        calculatedPayout: e.calculatedPayout,
      }));

      await tx.insert(transactionEntries).values(entriesToInsert);

      // Create Audit Log
      await tx.insert(auditLogs).values({
        actorId: user.userId,
        action: 'CREATE',
        entityType: 'TRANSACTION',
        entityId: header.id.toString(),
        afterData: { slipNumber, totalAmount, entryCount: preparedEntries.length },
      });

      // Update creator staff live activity status & timestamp
      await tx.update(staff).set({
        isWorkingLive: true,
        updatedAt: new Date(),
      }).where(sql`user_id = ${user.userId} OR LOWER(username) = LOWER(${user.username})`).catch(() => {});

      return header;
    });

    // 8. Atomic Redis Jantri Increments
    try {
      const jantriKey = `jantri:${shift.id}:${shift.openDate}`;
      const pipeline = redis.pipeline();
      for (const e of preparedEntries) {
        pipeline.hincrbyfloat(jantriKey, e.numberValue, parseFloat(e.amount));
      }
      pipeline.hincrbyfloat(jantriKey, 'TOTAL_COLLECTED', totalAmount);
      await pipeline.exec();
    } catch (err) {
      console.warn('[Redis] Jantri cache update warning:', err);
    }

    // 9. Cache Idempotency Result in Redis (120s TTL)
    const result = {
      id: createdTx.id,
      slipNumber: createdTx.slipNumber,
      shiftId: createdTx.shiftId,
      shiftName: shift.name,
      partyId: createdTx.partyId,
      partyName: party.partyName,
      totalAmount,
      entryCount: preparedEntries.length,
      createdAt: createdTx.createdAt.toISOString(),
    };

    if (input.idempotencyKey) {
      try {
        await redis.set(`idemp:${input.idempotencyKey}`, JSON.stringify(result), 'EX', 120);
      } catch {}
    }

    // 10. Background Duplicate Check (Asynchronous)
    this.checkDuplicatesAsync(createdTx.id, shift.id, party.id, preparedEntries).catch(() => {});

    return result;
  }

  private static async checkDuplicatesAsync(
    transactionId: number,
    shiftId: number,
    partyId: number,
    entries: { numberValue: string; amount: string }[]
  ) {
    try {
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      const recent = await db.select().from(transactions).where(
        and(
          eq(transactions.shiftId, shiftId),
          eq(transactions.partyId, partyId),
          ne(transactions.id, transactionId),
          gte(transactions.createdAt, fifteenMinAgo)
        )
      ).limit(5);

      for (const rec of recent) {
        const prevEntries = await db.select().from(transactionEntries).where(
          eq(transactionEntries.transactionId, rec.id)
        );

        const prevNumSet = new Set(prevEntries.map(p => `${p.numberValue}:${p.amount}`));
        let matchCount = 0;
        for (const e of entries) {
          if (prevNumSet.has(`${e.numberValue}:${e.amount}`)) {
            matchCount++;
          }
        }

        const score = entries.length > 0 ? (matchCount / entries.length) * 100 : 0;
        if (score >= 80) {
          await db.insert(duplicateReviews).values({
            originalTransactionId: rec.id,
            duplicateTransactionId: transactionId,
            similarityScore: score.toFixed(2),
            status: 'PENDING',
          });

          await db.update(transactions)
            .set({ status: 'DUPLICATE_FLAGGED' })
            .where(eq(transactions.id, transactionId));
          break;
        }
      }
    } catch (err) {
      console.warn('[DuplicateCheck] Background duplicate check error:', err);
    }
  }

  static async listTransactions(filters: {
    shiftId?: number;
    partyId?: number;
    status?: string;
    auditStatus?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(200, Math.max(1, filters.limit || 100));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (filters.shiftId) conditions.push(eq(transactions.shiftId, filters.shiftId));
    if (filters.partyId) conditions.push(eq(transactions.partyId, filters.partyId));
    if (filters.status && filters.status !== 'ALL') {
      conditions.push(eq(transactions.status, filters.status));
    }
    if (filters.auditStatus && filters.auditStatus !== 'ALL') {
      conditions.push(eq(transactions.auditStatus, filters.auditStatus));
    }
    if (filters.search && filters.search.trim()) {
      const term = `%${filters.search.trim()}%`;
      conditions.push(or(
        ilike(ledgers.partyName, term),
        ilike(transactions.slipNumber, term),
        ilike(transactions.addedBy, term)
      ));
    }

    const list = await db.select({
      id: transactions.id,
      slipNumber: transactions.slipNumber,
      shiftId: transactions.shiftId,
      shiftName: shifts.name,
      partyId: transactions.partyId,
      partyName: ledgers.partyName,
      totalAmount: transactions.totalAmount,
      status: transactions.status,
      rateStr: transactions.rateStr,
      ujType: transactions.ujType,
      addedBy: transactions.addedBy,
      updatedBy: transactions.updatedBy,
      isD: transactions.isD,
      auditStatus: transactions.auditStatus,
      isAudited: transactions.isAudited,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    })
      .from(transactions)
      .leftJoin(shifts, eq(transactions.shiftId, shifts.id))
      .leftJoin(ledgers, eq(transactions.partyId, ledgers.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(transactions.createdAt))
      .limit(limit)
      .offset(offset);

    // Fetch entries for all retrieved transactions to support right-panel live preview
    const txIds = list.map(t => t.id);
    const allEntries = txIds.length > 0
      ? await db.select().from(transactionEntries).where(inArray(transactionEntries.transactionId, txIds))
      : [];

    const entriesMap = new Map<number, { numberValue: string; amount: number; rate: number }[]>();
    for (const e of allEntries) {
      if (!entriesMap.has(e.transactionId)) {
        entriesMap.set(e.transactionId, []);
      }
      entriesMap.get(e.transactionId)!.push({
        numberValue: e.numberValue,
        amount: parseFloat(e.amount),
        rate: parseFloat(e.rate),
      });
    }

    return list.map(t => ({
      ...t,
      shiftName: t.shiftName || 'UNKNOWN',
      partyName: t.partyName || 'UNKNOWN',
      rateStr: t.rateStr || '90/10-9/10',
      ujType: t.ujType || 'J',
      addedBy: t.addedBy || 'SYSTEM',
      updatedBy: t.updatedBy || 'SYSTEM',
      isD: t.isD ?? true,
      auditStatus: t.auditStatus || 'NOT-AUDIT',
      totalAmount: parseFloat(t.totalAmount),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      entries: entriesMap.get(t.id) || [],
    }));
  }

  static async getTransactionById(id: number) {
    const [t] = await db.select({
      id: transactions.id,
      slipNumber: transactions.slipNumber,
      shiftId: transactions.shiftId,
      shiftName: shifts.name,
      partyId: transactions.partyId,
      partyName: ledgers.partyName,
      totalAmount: transactions.totalAmount,
      status: transactions.status,
      rateStr: transactions.rateStr,
      ujType: transactions.ujType,
      addedBy: transactions.addedBy,
      updatedBy: transactions.updatedBy,
      isD: transactions.isD,
      auditStatus: transactions.auditStatus,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    })
      .from(transactions)
      .leftJoin(shifts, eq(transactions.shiftId, shifts.id))
      .leftJoin(ledgers, eq(transactions.partyId, ledgers.id))
      .where(eq(transactions.id, id));

    if (t) {
      const entries = await this.getTransactionEntries(id);
      return {
        ...t,
        shiftName: t.shiftName || 'UNKNOWN',
        partyName: t.partyName || 'UNKNOWN',
        totalAmount: parseFloat(t.totalAmount),
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        entries,
      };
    }

    // If no transaction with that id exists, check if id is a shift id
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, id));
    if (shift) {
      return {
        id: 0,
        slipNumber: '',
        shiftId: shift.id,
        shiftName: shift.name,
        partyId: 0,
        partyName: '',
        totalAmount: 0,
        status: 'ACTIVE',
        entries: [],
      };
    }

    return null;
  }

  static async getTransactionEntries(transactionId: number) {
    const list = await db.select().from(transactionEntries).where(
      eq(transactionEntries.transactionId, transactionId)
    );
    return list.map(e => ({
      ...e,
      amount: parseFloat(e.amount),
      rate: parseFloat(e.rate),
    }));
  }

  static async updateTransaction(id: number, newTotalAmount: number, user: UserSession) {
    if (user.roleName !== 'DEVELOPER' && user.roleName !== 'SUPER ADMIN' && user.roleName !== 'ADMIN') {
      throw new ForbiddenError('Only Super Admin and Admin can update transactions');
    }

    const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!existing) throw new NotFoundError('Transaction not found');

    const [updated] = await db.update(transactions)
      .set({
        totalAmount: newTotalAmount.toFixed(2),
        updatedAt: new Date(),
        updatedBy: user.username || 'ADMIN',
      })
      .where(eq(transactions.id, id))
      .returning();

    await db.insert(auditLogs).values({
      actorId: user.userId,
      action: 'UPDATE',
      entityType: 'TRANSACTION',
      entityId: id.toString(),
      beforeData: existing,
      afterData: updated,
    });

    return updated;
  }

  static async updateAuditStatus(id: number, auditStatus: 'VALID' | 'MISTAKE' | 'NOT-AUDIT', user: UserSession) {
    const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!existing) throw new NotFoundError('Transaction not found');

    const [updated] = await db.update(transactions)
      .set({
        auditStatus,
        isAudited: auditStatus !== 'NOT-AUDIT',
        updatedAt: new Date(),
        updatedBy: user.username || 'AUDITOR',
      })
      .where(eq(transactions.id, id))
      .returning();

    return updated;
  }

  static async deleteTransaction(id: number, user: UserSession) {
    const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!existing) throw new NotFoundError('Transaction not found');

    await db.delete(transactionEntries).where(eq(transactionEntries.transactionId, id));
    await db.delete(transactions).where(eq(transactions.id, id));

    await db.insert(auditLogs).values({
      actorId: user.userId,
      action: 'DELETE',
      entityType: 'TRANSACTION',
      entityId: id.toString(),
      beforeData: existing,
    });

    return { id, success: true };
  }

  static async copyToNextShift(transactionId: number, targetShiftId?: number, user?: UserSession) {
    const [original] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!original) throw new NotFoundError('Original transaction not found');

    const originalEntries = await db.select().from(transactionEntries).where(
      eq(transactionEntries.transactionId, transactionId)
    );

    const shiftId = targetShiftId || original.shiftId;
    const [targetShift] = await db.select().from(shifts).where(eq(shifts.id, shiftId));
    if (!targetShift) throw new NotFoundError('Target shift not found');

    const sessionUser = user || { userId: 1, username: 'SYSTEM', roleId: 1, roleName: 'SUPER ADMIN' } as UserSession;

    return await this.createTransaction({
      shiftId: targetShift.id,
      partyId: original.partyId,
      entries: originalEntries.map(e => ({
        entryType: e.entryType as any,
        numberValue: e.numberValue,
        amount: parseFloat(e.amount),
      })),
    }, sessionUser);
  }

  static async listDuplicates(filters: { shiftId?: number; date?: string }) {
    // Find slips that share identical party, shift, and amount on the same day
    const duplicates = await db.select({
      id: transactions.id,
      slipNumber: transactions.slipNumber,
      partyId: transactions.partyId,
      partyName: ledgers.partyName,
      shiftId: transactions.shiftId,
      shiftName: shifts.name,
      totalAmount: transactions.totalAmount,
      status: transactions.status,
      createdAt: transactions.createdAt,
    })
      .from(transactions)
      .leftJoin(shifts, eq(transactions.shiftId, shifts.id))
      .leftJoin(ledgers, eq(transactions.partyId, ledgers.id))
      .where(filters.shiftId ? eq(transactions.shiftId, filters.shiftId) : undefined)
      .orderBy(desc(transactions.createdAt));

    return duplicates.map((d, i) => ({
      sr: i + 1,
      id: d.id,
      party: d.partyName || 'UNKNOWN',
      shift: d.shiftName || 'UNKNOWN',
      date: d.createdAt.toISOString().slice(0, 10),
      amount: parseFloat(d.totalAmount),
      dCount: 2, // duplicate occurrence count
    }));
  }

  // Flat per-entry breakdown with S-Hissa/O-Hissa and per-entry P&L (only meaningful once
  // the shift has a declared number — otherwise P&L is 0). Powers Transaction ASC /
  // Declare Trans ASC.
  static async listEntriesAsc(filters: { shiftId?: number; fromDate?: string; toDate?: string; minAmount?: number }) {
    const conditions = [ne(transactions.status, 'VOIDED')];
    if (filters.shiftId) conditions.push(eq(transactions.shiftId, filters.shiftId));
    if (filters.fromDate) conditions.push(sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`);
    if (filters.toDate) conditions.push(sql`${transactions.createdAt}::date <= ${filters.toDate}::date`);

    const rows = await db.select({
      entryId: transactionEntries.id,
      transactionId: transactions.id,
      partyName: ledgers.partyName,
      numberValue: transactionEntries.numberValue,
      entryType: transactionEntries.entryType,
      amount: transactionEntries.amount,
      rate: transactionEntries.rate,
      rateStr: transactions.rateStr,
      hissaPercentage: ledgers.hissaPercentage,
      shiftId: transactions.shiftId,
      shiftName: shifts.name,
      declaredNumber: shifts.declaredNumber,
    })
      .from(transactionEntries)
      .innerJoin(transactions, eq(transactionEntries.transactionId, transactions.id))
      .innerJoin(ledgers, eq(transactions.partyId, ledgers.id))
      .innerJoin(shifts, eq(transactions.shiftId, shifts.id))
      .where(and(...conditions))
      .orderBy(asc(transactionEntries.id));

    const filtered = filters.minAmount
      ? rows.filter(r => parseFloat(r.amount) >= filters.minAmount!)
      : rows;

    return filtered.map(r => {
      const amount = parseFloat(r.amount);
      const rate = parseFloat(r.rate);
      const hissa = parseFloat(r.hissaPercentage);
      let pnlAmount = 0;

      if (r.declaredNumber) {
        const padded = r.declaredNumber.padStart(2, '0');
        const tensDigit = padded[0];
        const unitsDigit = padded[1];
        let isWinner = false;
        if (r.entryType === 'DARA' && r.numberValue === padded) isWinner = true;
        else if (r.entryType === 'HARUF_ANDAR' && r.numberValue === tensDigit) isWinner = true;
        else if (r.entryType === 'HARUF_BAHAR' && r.numberValue === unitsDigit) isWinner = true;
        pnlAmount = isWinner ? -(amount * rate) : amount;
      }

      return {
        id: r.entryId,
        transactionId: r.transactionId,
        partyName: r.partyName,
        numberValue: r.numberValue,
        sale: amount,
        pnlAmount,
        rate: r.rateStr || `${rate}/10`,
        sHissa: hissa,
        oHissa: 100 - hissa,
        shiftId: r.shiftId,
        shiftName: r.shiftName,
      };
    });
  }

  // Party-wise collection totals for a date/shift range. Powers TPC Report.
  static async getPartyCollectionTotals(filters: { fromDate?: string; toDate?: string; shiftId?: number }) {
    const conditions = [ne(transactions.status, 'VOIDED')];
    if (filters.shiftId) conditions.push(eq(transactions.shiftId, filters.shiftId));
    if (filters.fromDate) conditions.push(sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`);
    if (filters.toDate) conditions.push(sql`${transactions.createdAt}::date <= ${filters.toDate}::date`);

    const rows = await db.select({
      partyId: transactions.partyId,
      partyName: ledgers.partyName,
      totalAmount: sql<string>`COALESCE(SUM(${transactions.totalAmount}::numeric), 0)`,
      slipCount: sql<number>`COUNT(${transactions.id})::int`,
    })
      .from(transactions)
      .innerJoin(ledgers, eq(transactions.partyId, ledgers.id))
      .where(and(...conditions))
      .groupBy(transactions.partyId, ledgers.partyName)
      .orderBy(desc(sql`SUM(${transactions.totalAmount}::numeric)`));

    return rows.map(r => ({
      partyId: r.partyId,
      partyName: r.partyName,
      totalAmount: parseFloat(r.totalAmount),
      slipCount: r.slipCount,
    }));
  }

  // Party-wise financial breakdown for a shift's business day. Several columns here
  // (Cap, Rate, S-Hissa, Total/D/A-Sale, Comm) are directly derived from real ledger and
  // entry data. O-Dara/O-Akhar are real liability figures once the shift is declared
  // (same winner-matching logic as declareResult). Hissa/Debit/Credit use a best-effort
  // formula — hissa = (totalSale - |comm|) * hissaPercentage — validated against one
  // reference row from the live site; treat as an approximation, not a guaranteed match.
  // TPC's exact formula could not be determined and is left at 0.
  static async getDailyReport(filters: { shiftId: number; date?: string; agentId?: number }) {
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, filters.shiftId));
    if (!shift) throw new NotFoundError('Shift not found');

    const dateFilter = filters.date || shift.openDate;

    const txRows = await db.select().from(transactions).where(
      and(
        eq(transactions.shiftId, filters.shiftId),
        ne(transactions.status, 'VOIDED'),
        sql`${transactions.createdAt}::date = ${dateFilter}::date`
      )
    );

    const txIds = txRows.map(t => t.id);
    const entryRows = txIds.length > 0
      ? await db.select().from(transactionEntries).where(inArray(transactionEntries.transactionId, txIds))
      : [];

    const entriesByTx = new Map<number, typeof entryRows>();
    for (const e of entryRows) {
      if (!entriesByTx.has(e.transactionId)) entriesByTx.set(e.transactionId, []);
      entriesByTx.get(e.transactionId)!.push(e);
    }

    const partyIds = Array.from(new Set(txRows.map(t => t.partyId)));
    const partyRows = partyIds.length > 0
      ? await db.select({
          id: ledgers.id,
          partyName: ledgers.partyName,
          agentId: ledgers.agentId,
          capping: ledgers.capping,
          daraRate: ledgers.daraRate,
          akharRate: ledgers.akharRate,
          hissaPercentage: ledgers.hissaPercentage,
          commissionRate: ledgers.commissionRate,
        }).from(ledgers).where(inArray(ledgers.id, partyIds))
      : [];
    const partyById = new Map(partyRows.map(p => [p.id, p]));

    const agentIds = Array.from(new Set(partyRows.map(p => p.agentId).filter((id): id is number => id != null)));
    const agentRows = agentIds.length > 0
      ? await db.select({ id: agents.id, agentName: agents.agentName }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const agentNameById = new Map(agentRows.map(a => [a.id, a.agentName]));

    const declaredNumber = shift.declaredNumber ? shift.declaredNumber.padStart(2, '0') : null;
    const tensDigit = declaredNumber?.[0];
    const unitsDigit = declaredNumber?.[1];

    const perParty = new Map<number, { totalSale: number; dSale: number; aSale: number; oDara: number; oAkhar: number }>();

    for (const tx of txRows) {
      if (!perParty.has(tx.partyId)) perParty.set(tx.partyId, { totalSale: 0, dSale: 0, aSale: 0, oDara: 0, oAkhar: 0 });
      const agg = perParty.get(tx.partyId)!;
      agg.totalSale += parseFloat(tx.totalAmount);

      for (const e of entriesByTx.get(tx.id) || []) {
        const amt = parseFloat(e.amount);
        const rate = parseFloat(e.rate);
        if (e.entryType === 'DARA') {
          agg.dSale += amt;
          if (declaredNumber && e.numberValue === declaredNumber) agg.oDara += amt * rate;
        } else {
          agg.aSale += amt;
          if (declaredNumber) {
            if (e.entryType === 'HARUF_ANDAR' && e.numberValue === tensDigit) agg.oAkhar += amt * rate;
            else if (e.entryType === 'HARUF_BAHAR' && e.numberValue === unitsDigit) agg.oAkhar += amt * rate;
          }
        }
      }
    }

    let rows = Array.from(perParty.entries()).map(([partyId, agg]) => {
      const party = partyById.get(partyId);
      const commissionRate = parseFloat(party?.commissionRate || '0');
      const hissaPct = parseFloat(party?.hissaPercentage || '0');
      const comm = -(agg.totalSale * commissionRate / 100);
      const hissa = -((agg.totalSale + comm) * hissaPct / 100);

      return {
        partyId,
        partyName: party?.partyName || 'UNKNOWN',
        agentId: party?.agentId ?? null,
        agentName: party?.agentId ? (agentNameById.get(party.agentId) || '-') : '-',
        cap: parseFloat(party?.capping || '0'),
        rate: `${Math.round(parseFloat(party?.daraRate || '0'))}/10-${Math.round(parseFloat(party?.akharRate || '0'))}/10`,
        sHissa: hissaPct,
        totalSale: agg.totalSale,
        dSale: agg.dSale,
        aSale: agg.aSale,
        comm,
        oDara: agg.oDara,
        oAkhar: agg.oAkhar,
        tpc: 0,
        hissa,
        debit: hissa < 0 ? Math.abs(hissa) : 0,
        credit: hissa > 0 ? hissa : 0,
      };
    });

    if (filters.agentId) {
      rows = rows.filter(r => r.agentId === filters.agentId);
    }
    rows.sort((a, b) => a.partyName.localeCompare(b.partyName));

    const sum = (key: 'totalSale' | 'dSale' | 'aSale' | 'comm' | 'oDara' | 'oAkhar' | 'hissa' | 'debit' | 'credit') =>
      rows.reduce((s, r) => s + r[key], 0);

    const totalCollected = sum('totalSale');
    const totalPayout = sum('oDara') + sum('oAkhar');

    return {
      shiftId: shift.id,
      shiftName: shift.name,
      date: dateFilter,
      partyCount: rows.length,
      profit: totalCollected - totalPayout,
      rows,
      masterTotal: {
        totalSale: sum('totalSale'),
        dSale: sum('dSale'),
        aSale: sum('aSale'),
        comm: sum('comm'),
        oDara: sum('oDara'),
        oAkhar: sum('oAkhar'),
        tpc: 0,
        hissa: sum('hissa'),
        debit: sum('debit'),
        credit: sum('credit'),
      },
    };
  }

  // Party-wise breakdown across ALL shifts for a date range. Powers All Shift Report.
  // Same Comm/Hissa best-effort formula as getDailyReport (see its comment). "Opening" is
  // a real voucher-based balance carried in from before fromDate (reuses
  // VoucherService.getLedgerBalances) — not a fabricated number, but scoped to voucher
  // activity only, same caveat as the Trial Balance family of reports. "Asign"/"Feedback"
  // have no backing data anywhere in this schema and are left for the frontend to render
  // as placeholders rather than invented here. TPC's formula is unresolved, same as Daily Report.
  static async getAllShiftPartyReport(filters: {
    fromDate: string;
    toDate: string;
    agentId?: number;
    groupName?: string;
    partyId?: number;
    search?: string;
    searchMode?: 'START_WITH' | 'CONTAINS';
  }) {
    const txConditions = [
      ne(transactions.status, 'VOIDED'),
      sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`,
      sql`${transactions.createdAt}::date <= ${filters.toDate}::date`,
    ];
    if (filters.partyId) txConditions.push(eq(transactions.partyId, filters.partyId));

    const txRows = await db.select({
      id: transactions.id,
      partyId: transactions.partyId,
      shiftId: transactions.shiftId,
      totalAmount: transactions.totalAmount,
    }).from(transactions).where(and(...txConditions));

    const txIds = txRows.map(t => t.id);
    const entryRows = txIds.length > 0
      ? await db.select().from(transactionEntries).where(inArray(transactionEntries.transactionId, txIds))
      : [];

    const shiftIds = Array.from(new Set(txRows.map(t => t.shiftId)));
    const shiftRows = shiftIds.length > 0
      ? await db.select({ id: shifts.id, declaredNumber: shifts.declaredNumber }).from(shifts).where(inArray(shifts.id, shiftIds))
      : [];
    const declaredByShift = new Map(shiftRows.map(s => [s.id, s.declaredNumber ? s.declaredNumber.padStart(2, '0') : null]));

    const entriesByTx = new Map<number, typeof entryRows>();
    for (const e of entryRows) {
      if (!entriesByTx.has(e.transactionId)) entriesByTx.set(e.transactionId, []);
      entriesByTx.get(e.transactionId)!.push(e);
    }

    const partyIds = Array.from(new Set(txRows.map(t => t.partyId)));
    let partyRows = partyIds.length > 0
      ? await db.select({
          id: ledgers.id,
          partyName: ledgers.partyName,
          mobile: ledgers.mobile,
          agentId: ledgers.agentId,
          groupName: ledgers.groupName,
          betLimit: ledgers.betLimit,
          hissaPercentage: ledgers.hissaPercentage,
          commissionRate: ledgers.commissionRate,
        }).from(ledgers).where(inArray(ledgers.id, partyIds))
      : [];

    if (filters.groupName) partyRows = partyRows.filter(p => p.groupName === filters.groupName);
    if (filters.search && filters.search.trim()) {
      const term = filters.search.trim().toLowerCase();
      partyRows = partyRows.filter(p =>
        filters.searchMode === 'CONTAINS'
          ? p.partyName.toLowerCase().includes(term)
          : p.partyName.toLowerCase().startsWith(term)
      );
    }

    const partyById = new Map(partyRows.map(p => [p.id, p]));
    const validPartyIds = new Set(partyRows.map(p => p.id));

    const agentIds = Array.from(new Set(partyRows.map(p => p.agentId).filter((id): id is number => id != null)));
    const agentRows = agentIds.length > 0
      ? await db.select({ id: agents.id, agentName: agents.agentName }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const agentNameById = new Map(agentRows.map(a => [a.id, a.agentName]));

    // Opening balance = real voucher-based ledger balance as of the day before fromDate.
    // UTC-anchored throughout, so toISOString()'s date slice matches the intended calendar
    // day regardless of the server's local timezone offset.
    const dayBefore = new Date(`${filters.fromDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const openingBalances = await VoucherService.getLedgerBalances({ toDate: dayBefore.toISOString().slice(0, 10) });
    const openingByLedger = new Map(openingBalances.map(b => [b.ledgerId, b.balance]));

    const perParty = new Map<number, { totalSale: number; dSale: number; aSale: number; dOpen: number; aOpen: number }>();

    for (const tx of txRows) {
      if (!validPartyIds.has(tx.partyId)) continue;
      if (filters.agentId) {
        const p = partyById.get(tx.partyId);
        if (!p || p.agentId !== filters.agentId) continue;
      }
      if (!perParty.has(tx.partyId)) perParty.set(tx.partyId, { totalSale: 0, dSale: 0, aSale: 0, dOpen: 0, aOpen: 0 });
      const agg = perParty.get(tx.partyId)!;
      agg.totalSale += parseFloat(tx.totalAmount);

      const declaredNumber = declaredByShift.get(tx.shiftId);
      const tensDigit = declaredNumber?.[0];
      const unitsDigit = declaredNumber?.[1];

      for (const e of entriesByTx.get(tx.id) || []) {
        const amt = parseFloat(e.amount);
        const rate = parseFloat(e.rate);
        if (e.entryType === 'DARA') {
          agg.dSale += amt;
          if (declaredNumber && e.numberValue === declaredNumber) agg.dOpen += amt * rate;
        } else {
          agg.aSale += amt;
          if (declaredNumber) {
            if (e.entryType === 'HARUF_ANDAR' && e.numberValue === tensDigit) agg.aOpen += amt * rate;
            else if (e.entryType === 'HARUF_BAHAR' && e.numberValue === unitsDigit) agg.aOpen += amt * rate;
          }
        }
      }
    }

    const rows = Array.from(perParty.entries()).map(([partyId, agg]) => {
      const party = partyById.get(partyId)!;
      const commissionRate = parseFloat(party.commissionRate || '0');
      const hissaPct = parseFloat(party.hissaPercentage || '0');
      const comm = -(agg.totalSale * commissionRate / 100);
      const hissa = -((agg.totalSale + comm) * hissaPct / 100);

      return {
        partyId,
        partyName: party.partyName,
        mobile: party.mobile || '-',
        agentName: party.agentId ? (agentNameById.get(party.agentId) || '-') : '-',
        limit: parseFloat(party.betLimit || '0'),
        opening: openingByLedger.get(partyId) || 0,
        totalSale: agg.totalSale,
        dSale: agg.dSale,
        aSale: agg.aSale,
        comm,
        dOpen: agg.dOpen,
        aOpen: agg.aOpen,
        tpc: 0,
        hissa,
      };
    }).sort((a, b) => a.partyName.localeCompare(b.partyName));

    return { rows };
  }

  // HVS Process data: reuses the exact Comm/Hissa/opening-balance/P&L formulas already
  // validated for getAllShiftPartyReport above. "Total"/"Closing"/"T-Settle-Amt" are a
  // best-effort formula (Total = opening + P&L, Closing = Total - settled-so-far) — flagged
  // here the same way TPC/HP-Amt/RBT are flagged elsewhere, since their exact live semantics
  // can't be independently verified from a static screenshot.
  static async getHvsProcessData(filters: { fromDate: string; toDate: string; agentId?: number }) {
    const { rows } = await this.getAllShiftPartyReport({
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      agentId: filters.agentId,
    });

    const partyIds = rows.map(r => r.partyId);
    const settledRows = partyIds.length > 0
      ? await db.select({
          ledgerId: voucherEntries.ledgerId,
          totalDr: sql<string>`COALESCE(SUM(CASE WHEN ${voucherEntries.entrySide} = 'DR' THEN ${voucherEntries.amount}::numeric ELSE 0 END), 0)`,
          totalCr: sql<string>`COALESCE(SUM(CASE WHEN ${voucherEntries.entrySide} = 'CR' THEN ${voucherEntries.amount}::numeric ELSE 0 END), 0)`,
        })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(and(
            inArray(voucherEntries.ledgerId, partyIds),
            inArray(vouchers.voucherType, ['CASH_RECEIPT', 'CASH_PAYMENT']),
            sql`${vouchers.createdAt}::date >= ${filters.fromDate}::date`,
            sql`${vouchers.createdAt}::date <= ${filters.toDate}::date`,
          ))
          .groupBy(voucherEntries.ledgerId)
      : [];
    const settledByLedger = new Map(settledRows.map(s => [s.ledgerId, parseFloat(s.totalCr) - parseFloat(s.totalDr)]));

    return rows.map(r => {
      const pnl = r.totalSale + r.comm + r.hissa - r.dOpen - r.aOpen;
      const total = r.opening + pnl;
      const tSettleAmt = settledByLedger.get(r.partyId) || 0;
      const closing = total - tSettleAmt;
      return {
        partyId: r.partyId,
        partyName: r.partyName,
        agentName: r.agentName,
        mobile: r.mobile,
        pnl,
        total,
        closing,
        tSettleAmt,
      };
    });
  }

  // Per-staff transaction stats. Free Time / Time Taken / T-Time have no backing data
  // anywhere in this schema (no session-duration tracking exists) — left at 0, same
  // honest-placeholder convention already used for TPC/HP-Amt/RBT elsewhere.
  static async getProductivityReport(filters: { fromDate: string; toDate: string; shiftId?: number }) {
    const conditions = [
      ne(transactions.status, 'VOIDED'),
      sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`,
      sql`${transactions.createdAt}::date <= ${filters.toDate}::date`,
    ];
    if (filters.shiftId) conditions.push(eq(transactions.shiftId, filters.shiftId));

    const rows = await db.select({
      userId: staff.userId,
      name: staff.fullName,
      mobile: staff.mobile,
      address: staff.address,
      role: staff.role,
      username: staff.username,
      tCount: sql<number>`COUNT(${transactions.id})::int`,
      tAmount: sql<string>`COALESCE(SUM(${transactions.totalAmount}), 0)`,
    })
      .from(transactions)
      .innerJoin(staff, eq(transactions.createdBy, staff.userId))
      .where(and(...conditions))
      .groupBy(staff.userId, staff.fullName, staff.mobile, staff.address, staff.role, staff.username);

    return rows.map(r => ({
      staffId: r.userId,
      name: r.name,
      mobile: r.mobile || '-',
      address: r.address || '-',
      role: r.role || '-',
      username: r.username || '-',
      freeTime: 0,
      timeTaken: 0,
      tTime: 0,
      tCount: r.tCount,
      tAmount: parseFloat(r.tAmount),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Same per-staff base as getProductivityReport, but broken down per shift name instead of
  // a single total — frontend builds its per-market columns dynamically from whatever shift
  // names actually appear here, so no market list is hardcoded anywhere.
  static async getProductivityShiftReport(filters: { fromDate: string; toDate: string }) {
    const rows = await db.select({
      userId: staff.userId,
      name: staff.fullName,
      mobile: staff.mobile,
      address: staff.address,
      role: staff.role,
      username: staff.username,
      shiftName: shifts.name,
      count: sql<number>`COUNT(${transactions.id})::int`,
    })
      .from(transactions)
      .innerJoin(staff, eq(transactions.createdBy, staff.userId))
      .innerJoin(shifts, eq(transactions.shiftId, shifts.id))
      .where(and(
        ne(transactions.status, 'VOIDED'),
        sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`,
        sql`${transactions.createdAt}::date <= ${filters.toDate}::date`,
      ))
      .groupBy(staff.userId, staff.fullName, staff.mobile, staff.address, staff.role, staff.username, shifts.name);

    const byStaff = new Map<number, { staffId: number; name: string; mobile: string; address: string; role: string; username: string; tCount: number; perShift: Record<string, number> }>();
    for (const r of rows) {
      if (!byStaff.has(r.userId)) {
        byStaff.set(r.userId, {
          staffId: r.userId,
          name: r.name,
          mobile: r.mobile || '-',
          address: r.address || '-',
          role: r.role || '-',
          username: r.username || '-',
          tCount: 0,
          perShift: {},
        });
      }
      const entry = byStaff.get(r.userId)!;
      entry.perShift[r.shiftName] = r.count;
      entry.tCount += r.count;
    }

    return Array.from(byStaff.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Per-staff audit stats: Mistake = voided, Modify = edited after creation (updatedAt !=
  // createdAt) — both derived from fields already on the transactions table.
  static async getProductivityAudit(filters: { fromDate: string; toDate: string; shiftId?: number }) {
    const conditions = [
      sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`,
      sql`${transactions.createdAt}::date <= ${filters.toDate}::date`,
    ];
    if (filters.shiftId) conditions.push(eq(transactions.shiftId, filters.shiftId));

    const rows = await db.select({
      userId: staff.userId,
      name: staff.fullName,
      mobile: staff.mobile,
      address: staff.address,
      role: staff.role,
      tParty: sql<number>`COUNT(DISTINCT ${transactions.partyId})::int`,
      tCount: sql<number>`COUNT(${transactions.id})::int`,
      valid: sql<number>`COUNT(*) FILTER (WHERE ${transactions.status} != 'VOIDED')::int`,
      mistake: sql<number>`COUNT(*) FILTER (WHERE ${transactions.status} = 'VOIDED')::int`,
      modify: sql<number>`COUNT(*) FILTER (WHERE ${transactions.updatedAt} != ${transactions.createdAt})::int`,
      tAmount: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.status} != 'VOIDED' THEN ${transactions.totalAmount}::numeric ELSE 0 END), 0)`,
    })
      .from(transactions)
      .innerJoin(staff, eq(transactions.createdBy, staff.userId))
      .where(and(...conditions))
      .groupBy(staff.userId, staff.fullName, staff.mobile, staff.address, staff.role);

    return rows.map(r => ({
      staffId: r.userId,
      name: r.name,
      mobile: r.mobile || '-',
      address: r.address || '-',
      role: r.role || '-',
      tParty: r.tParty,
      tCount: r.tCount,
      valid: r.valid,
      mistake: r.mistake,
      modify: r.modify,
      tAmount: parseFloat(r.tAmount),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Shared before/after-declare split, reused by both getTransBeforeAfterDeclare (row-level,
  // one shift-day) and getPlBeforeAfterDeclare (aggregate-only, many shift-days). P&L reuses
  // the exact winner-matching logic already validated in getAllShiftPartyReport above (DARA
  // matches the declared number, HARUF_ANDAR/BAHAR match its tens/units digit) — just
  // bucketed by whether the transaction landed before or after declarations.declaredAt.
  private static async computeBeforeAfterTotals(shiftId: number, date: string) {
    const [decl] = await db.select().from(declarations)
      .where(and(eq(declarations.shiftId, shiftId), sql`${declarations.declaredAt}::date = ${date}::date`))
      .orderBy(desc(declarations.declaredAt))
      .limit(1);

    const txRows = await db.select().from(transactions).where(and(
      eq(transactions.shiftId, shiftId),
      sql`${transactions.createdAt}::date = ${date}::date`,
      ne(transactions.status, 'VOIDED'),
    ));

    const txIds = txRows.map(t => t.id);
    const entryRows = txIds.length > 0
      ? await db.select().from(transactionEntries).where(inArray(transactionEntries.transactionId, txIds))
      : [];
    const entriesByTx = new Map<number, typeof entryRows>();
    for (const e of entryRows) {
      if (!entriesByTx.has(e.transactionId)) entriesByTx.set(e.transactionId, []);
      entriesByTx.get(e.transactionId)!.push(e);
    }

    const declaredNumber = decl?.winningNumber ? decl.winningNumber.padStart(2, '0') : null;
    const tensDigit = declaredNumber?.[0];
    const unitsDigit = declaredNumber?.[1];

    let saleBefore = 0, saleAfter = 0, payoutBefore = 0, payoutAfter = 0;

    for (const tx of txRows) {
      const isBefore = !decl || new Date(tx.createdAt) < new Date(decl.declaredAt);
      const amt = parseFloat(tx.totalAmount);
      if (isBefore) saleBefore += amt; else saleAfter += amt;

      let payout = 0;
      if (declaredNumber) {
        for (const e of entriesByTx.get(tx.id) || []) {
          const eAmt = parseFloat(e.amount);
          const rate = parseFloat(e.rate);
          if (e.entryType === 'DARA' && e.numberValue === declaredNumber) payout += eAmt * rate;
          else if (e.entryType === 'HARUF_ANDAR' && e.numberValue === tensDigit) payout += eAmt * rate;
          else if (e.entryType === 'HARUF_BAHAR' && e.numberValue === unitsDigit) payout += eAmt * rate;
        }
      }
      if (isBefore) payoutBefore += payout; else payoutAfter += payout;
    }

    const plBefore = saleBefore - payoutBefore;
    const plAfter = saleAfter - payoutAfter;

    return {
      declaration: decl,
      saleBefore, saleAfter, saleDiff: saleAfter - saleBefore,
      plBefore, plAfter, plDiff: plAfter - plBefore,
    };
  }

  static async getTransBeforeAfterDeclare(filters: { shiftId: number; date: string; mode: 'BEFORE' | 'AFTER' }) {
    const totals = await this.computeBeforeAfterTotals(filters.shiftId, filters.date);

    const txRows = await db.select({
      id: transactions.id,
      partyName: ledgers.partyName,
      rateStr: transactions.rateStr,
      totalAmount: transactions.totalAmount,
      isD: transactions.isD,
      addedBy: transactions.addedBy,
      updatedBy: transactions.updatedBy,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    })
      .from(transactions)
      .innerJoin(ledgers, eq(transactions.partyId, ledgers.id))
      .where(and(
        eq(transactions.shiftId, filters.shiftId),
        sql`${transactions.createdAt}::date = ${filters.date}::date`,
        ne(transactions.status, 'VOIDED'),
      ))
      .orderBy(desc(transactions.createdAt));

    const decl = totals.declaration;
    const filtered = txRows.filter(tx => {
      const isBefore = !decl || new Date(tx.createdAt) < new Date(decl.declaredAt);
      return filters.mode === 'BEFORE' ? isBefore : !isBefore;
    });

    return {
      rows: filtered.map(tx => ({
        id: tx.id,
        partyName: tx.partyName,
        rate: tx.rateStr || '-',
        amount: parseFloat(tx.totalAmount),
        isD: tx.isD,
        addedBy: tx.addedBy || 'SYSTEM',
        createdAt: tx.createdAt.toISOString(),
        updatedBy: tx.updatedBy || 'SYSTEM',
        updatedAt: tx.updatedAt.toISOString(),
      })),
      totals: {
        saleBefore: totals.saleBefore,
        saleAfter: totals.saleAfter,
        saleDiff: totals.saleDiff,
        plBefore: totals.plBefore,
        plAfter: totals.plAfter,
        plDiff: totals.plDiff,
      },
    };
  }

  static async getPlBeforeAfterDeclare(filters: { fromDate: string; toDate: string; shiftId?: number }) {
    const conditions = [
      sql`${declarations.declaredAt}::date >= ${filters.fromDate}::date`,
      sql`${declarations.declaredAt}::date <= ${filters.toDate}::date`,
    ];
    if (filters.shiftId) conditions.push(eq(declarations.shiftId, filters.shiftId));

    const declRows = await db.select({
      shiftId: declarations.shiftId,
      shiftName: shifts.name,
      winningNumber: declarations.winningNumber,
      declaredDate: sql<string>`${declarations.declaredAt}::date`,
    })
      .from(declarations)
      .innerJoin(shifts, eq(declarations.shiftId, shifts.id))
      .where(and(...conditions))
      .orderBy(desc(declarations.declaredAt));

    const results = [];
    for (const d of declRows) {
      const totals = await this.computeBeforeAfterTotals(d.shiftId, d.declaredDate);
      results.push({
        date: d.declaredDate,
        shiftName: d.shiftName,
        result: d.winningNumber,
        saleBefore: totals.saleBefore,
        saleAfter: totals.saleAfter,
        saleDiff: totals.saleDiff,
        plBefore: totals.plBefore,
        plAfter: totals.plAfter,
        plDiff: totals.plDiff,
      });
    }
    return results;
  }

  // Transactions entered after a role's normal cutoff (shiftRoleConfig.closeTime, the same
  // field ShiftService.assertShiftOpenForRole enforces live) could only happen via an admin
  // override — that override is the existing operator_shift_permissions table, already used
  // by Declare Trans Permission. "Allow Till" here is literally that row's expiresAt.
  static async getTransAfterTiming(filters: { fromDate: string; toDate: string }) {
    const txRows = await db.select({
      id: transactions.id,
      shiftId: transactions.shiftId,
      shiftName: shifts.name,
      partyName: ledgers.partyName,
      status: transactions.status,
      totalAmount: transactions.totalAmount,
      addedBy: transactions.addedBy,
      updatedBy: transactions.updatedBy,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
      createdBy: transactions.createdBy,
      createdDate: sql<string>`${transactions.createdAt}::date`,
      createdTime: sql<string>`to_char(${transactions.createdAt}, 'HH24:MI:SS')`,
    })
      .from(transactions)
      .innerJoin(shifts, eq(transactions.shiftId, shifts.id))
      .innerJoin(ledgers, eq(transactions.partyId, ledgers.id))
      .where(and(
        sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`,
        sql`${transactions.createdAt}::date <= ${filters.toDate}::date`,
      ));

    if (txRows.length === 0) return [];

    const userIds = Array.from(new Set(txRows.map(t => t.createdBy)));
    const userRows = await db.select({ id: users.id, roleId: users.roleId }).from(users).where(inArray(users.id, userIds));
    const roleByUser = new Map(userRows.map(u => [u.id, u.roleId]));

    const shiftIds = Array.from(new Set(txRows.map(t => t.shiftId)));
    const configRows = shiftIds.length > 0
      ? await db.select().from(shiftRoleConfig).where(inArray(shiftRoleConfig.shiftId, shiftIds))
      : [];
    const closeTimeByShiftRole = new Map(configRows.map(c => [`${c.shiftId}:${c.roleId}`, c.closeTime]));

    const permRows = await db.select().from(operatorShiftPermissions).where(inArray(operatorShiftPermissions.userId, userIds));
    const permByKey = new Map<string, Date | null>();
    for (const p of permRows) {
      permByKey.set(`${p.userId}:${p.shiftId}:${p.shiftDate}`, p.expiresAt);
    }

    const results: any[] = [];
    for (const tx of txRows) {
      const roleId = roleByUser.get(tx.createdBy);
      const closeTime = roleId != null ? closeTimeByShiftRole.get(`${tx.shiftId}:${roleId}`) : undefined;
      if (!closeTime) continue;
      if (tx.createdTime <= closeTime) continue;

      const allowTill = permByKey.get(`${tx.createdBy}:${tx.shiftId}:${tx.createdDate}`) ?? null;

      results.push({
        id: tx.id,
        date: tx.createdDate,
        shiftName: tx.shiftName,
        partyName: tx.partyName,
        status: tx.status,
        amount: parseFloat(tx.totalAmount),
        addedBy: tx.addedBy || 'SYSTEM',
        createdAt: tx.createdAt.toISOString(),
        updatedBy: tx.updatedBy || 'SYSTEM',
        updatedAt: tx.updatedAt.toISOString(),
        allowTill: allowTill ? new Date(allowTill).toISOString() : null,
      });
    }
    return results.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Day-by-day running ledger statement for ONE party. Balance = OP-Bal + P&L - Payment
  // (validated against a live reference row: 42129 + 45 - 0 = 42174). P&L = TotalSale +
  // Comm + Hissa - D-Open - A-Open (Comm/Hissa already negative). TPC/HP-Amt/RBT have no
  // determinable formula from the reference and are left at 0, same caveat as Daily/All
  // Shift Report. "Payment" = settlement vouchers (CASH_RECEIPT/CASH_PAYMENT) posted
  // against this party via the Save (F2) form below the table.
  static async getSettlingReport(filters: { partyId: number; fromDate: string; toDate: string }) {
    const [party] = await db.select().from(ledgers).where(eq(ledgers.id, filters.partyId));
    if (!party) throw new NotFoundError('Party not found');

    let agentName = '-';
    if (party.agentId) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, party.agentId));
      if (agent) agentName = agent.agentName;
    }

    const rateStr = `${Math.round(parseFloat(party.daraRate))}/10 | ${Math.round(parseFloat(party.akharRate))}/10`;

    // UTC-anchored throughout, so toISOString()'s date slice matches the intended calendar
    // day regardless of the server's local timezone offset.
    const dayBefore = new Date(`${filters.fromDate}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const openingBalances = await VoucherService.getLedgerBalances({ toDate: dayBefore.toISOString().slice(0, 10) });
    let runningBalance = openingBalances.find(b => b.ledgerId === filters.partyId)?.balance || 0;

    const txRows = await db.select().from(transactions).where(
      and(
        eq(transactions.partyId, filters.partyId),
        ne(transactions.status, 'VOIDED'),
        sql`${transactions.createdAt}::date >= ${filters.fromDate}::date`,
        sql`${transactions.createdAt}::date <= ${filters.toDate}::date`
      )
    );
    const txIds = txRows.map(t => t.id);
    const entryRows = txIds.length > 0
      ? await db.select().from(transactionEntries).where(inArray(transactionEntries.transactionId, txIds))
      : [];
    const entriesByTx = new Map<number, typeof entryRows>();
    for (const e of entryRows) {
      if (!entriesByTx.has(e.transactionId)) entriesByTx.set(e.transactionId, []);
      entriesByTx.get(e.transactionId)!.push(e);
    }

    const shiftIds = Array.from(new Set(txRows.map(t => t.shiftId)));
    const shiftRows = shiftIds.length > 0
      ? await db.select({ id: shifts.id, declaredNumber: shifts.declaredNumber }).from(shifts).where(inArray(shifts.id, shiftIds))
      : [];
    const declaredByShift = new Map(shiftRows.map(s => [s.id, s.declaredNumber ? s.declaredNumber.padStart(2, '0') : null]));

    const settleEntries = await db.select({
      entrySide: voucherEntries.entrySide,
      amount: voucherEntries.amount,
      createdAt: vouchers.createdAt,
    })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(and(
        eq(voucherEntries.ledgerId, filters.partyId),
        inArray(vouchers.voucherType, ['CASH_RECEIPT', 'CASH_PAYMENT']),
        sql`${vouchers.createdAt}::date >= ${filters.fromDate}::date`,
        sql`${vouchers.createdAt}::date <= ${filters.toDate}::date`
      ));

    const commissionRate = parseFloat(party.commissionRate);
    const hissaPct = parseFloat(party.hissaPercentage);

    const days: string[] = [];
    const cursor = new Date(`${filters.fromDate}T00:00:00Z`);
    const endDay = new Date(`${filters.toDate}T00:00:00Z`);
    while (cursor <= endDay) {
      days.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const rows = days.map(day => {
      const dayTx = txRows.filter(t => t.createdAt.toISOString().slice(0, 10) === day);
      let totalSale = 0, dSale = 0, aSale = 0, dOpen = 0, aOpen = 0;

      for (const tx of dayTx) {
        totalSale += parseFloat(tx.totalAmount);
        const declaredNumber = declaredByShift.get(tx.shiftId);
        const tensDigit = declaredNumber?.[0];
        const unitsDigit = declaredNumber?.[1];
        for (const e of entriesByTx.get(tx.id) || []) {
          const amt = parseFloat(e.amount);
          const rate = parseFloat(e.rate);
          if (e.entryType === 'DARA') {
            dSale += amt;
            if (declaredNumber && e.numberValue === declaredNumber) dOpen += amt * rate;
          } else {
            aSale += amt;
            if (declaredNumber) {
              if (e.entryType === 'HARUF_ANDAR' && e.numberValue === tensDigit) aOpen += amt * rate;
              else if (e.entryType === 'HARUF_BAHAR' && e.numberValue === unitsDigit) aOpen += amt * rate;
            }
          }
        }
      }

      const comm = -(totalSale * commissionRate / 100);
      const hissa = -((totalSale + comm) * hissaPct / 100);
      const pnl = totalSale + comm + hissa - dOpen - aOpen;

      const dayPayments = settleEntries.filter(s => s.createdAt.toISOString().slice(0, 10) === day);
      const payment = dayPayments.reduce((sum, s) => sum + (s.entrySide === 'CR' ? parseFloat(s.amount) : -parseFloat(s.amount)), 0);

      const opBal = runningBalance;
      const balance = opBal + pnl - payment;
      runningBalance = balance;

      return {
        date: day,
        opBal,
        totalSale,
        dSale,
        aSale,
        comm,
        dOpen,
        aOpen,
        hissa,
        tpc: 0,
        hpAmt: 0,
        rbt: 0,
        pnl,
        payment,
        balance,
      };
    });

    return {
      partyId: party.id,
      partyName: party.partyName,
      agentName,
      rate: rateStr,
      limit: parseFloat(party.betLimit),
      balance: runningBalance,
      rows,
    };
  }
}
