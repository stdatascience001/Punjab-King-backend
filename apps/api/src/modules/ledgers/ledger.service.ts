import { db, ledgers, agents } from '@pb/database';
import { eq, ilike, or, and, isNull, isNotNull, asc, inArray } from 'drizzle-orm';
import { AppError, NotFoundError } from '../../common/errors.js';

export class LedgerService {
  // Full detail for the Ledger Update popup's Info tab, with self-referencing
  // distributor/retailer/ref-ledger/HP-ledger ids resolved to their party names.
  static async getLedgerById(id: number) {
    const [ledger] = await db.select().from(ledgers).where(eq(ledgers.id, id));
    if (!ledger) throw new NotFoundError('Ledger not found');

    const refIds = [ledger.distributorId, ledger.retailerId, ledger.refLedgerId, ledger.hpLedgerId]
      .filter((v): v is number => v != null);
    const uniqueRefIds = Array.from(new Set(refIds));
    const refRows = uniqueRefIds.length > 0
      ? await db.select({ id: ledgers.id, partyName: ledgers.partyName }).from(ledgers).where(inArray(ledgers.id, uniqueRefIds))
      : [];
    const nameById = new Map(refRows.map(r => [r.id, r.partyName]));

    let agentName: string | null = null;
    if (ledger.agentId) {
      const [agent] = await db.select({ agentName: agents.agentName }).from(agents).where(eq(agents.id, ledger.agentId));
      agentName = agent?.agentName || null;
    }

    return {
      ...ledger,
      daraRate: parseFloat(ledger.daraRate),
      akharRate: parseFloat(ledger.akharRate),
      commissionRate: parseFloat(ledger.commissionRate),
      hissaPercentage: parseFloat(ledger.hissaPercentage),
      betLimit: parseFloat(ledger.betLimit),
      capping: parseFloat(ledger.capping),
      rebate: parseFloat(ledger.rebate),
      dAmt: parseFloat(ledger.dAmt),
      agentName,
      distributorName: ledger.distributorId ? nameById.get(ledger.distributorId) || null : null,
      retailerName: ledger.retailerId ? nameById.get(ledger.retailerId) || null : null,
      refLedgerName: ledger.refLedgerId ? nameById.get(ledger.refLedgerId) || null : null,
      hpLedgerName: ledger.hpLedgerId ? nameById.get(ledger.hpLedgerId) || null : null,
      updatedAt: ledger.updatedAt ? ledger.updatedAt.toISOString() : ledger.createdAt.toISOString(),
      createdAt: ledger.createdAt.toISOString(),
    };
  }

  static async searchParties(query: string) {
    const list = await db.select({
      id: ledgers.id,
      partyName: ledgers.partyName,
      realName: ledgers.realName,
      userName: ledgers.userName,
      groupName: ledgers.groupName,
      agentId: ledgers.agentId,
      agentName: agents.agentName,
      daraRate: ledgers.daraRate,
      akharRate: ledgers.akharRate,
      commissionRate: ledgers.commissionRate,
      hissaPercentage: ledgers.hissaPercentage,
      betLimit: ledgers.betLimit,
      capping: ledgers.capping,
      hasLimit: ledgers.hasLimit,
      vapsiTpr: ledgers.vapsiTpr,
      isLocked: ledgers.isLocked,
      isRisky: ledgers.isRisky,
    })
    .from(ledgers)
    .leftJoin(agents, eq(ledgers.agentId, agents.id))
    .where(
      and(
        isNull(ledgers.deletedAt),
        or(
          ilike(ledgers.partyName, `%${query}%`),
          ilike(ledgers.realName, `%${query}%`),
          ilike(ledgers.userName, `%${query}%`),
          ilike(ledgers.telegram, `%${query}%`)
        )
      )
    )
    .limit(20);

    return list.map(l => ({
      ...l,
      daraRate: parseFloat(l.daraRate),
      akharRate: parseFloat(l.akharRate),
      commissionRate: parseFloat(l.commissionRate),
      hissaPercentage: parseFloat(l.hissaPercentage),
      betLimit: parseFloat(l.betLimit),
      capping: parseFloat(l.capping),
    }));
  }

  static async listLedgers(status?: string) {
    let whereClause = isNull(ledgers.deletedAt);
    if (status === 'Deleted') {
      whereClause = isNotNull(ledgers.deletedAt);
    } else if (status === 'ALL') {
      whereClause = undefined as any;
    }

    const query = db.select({
      id: ledgers.id,
      partyName: ledgers.partyName,
      realName: ledgers.realName,
      userName: ledgers.userName,
      groupName: ledgers.groupName,
      agentId: ledgers.agentId,
      agentName: agents.agentName,
      telegram: ledgers.telegram,
      mobile: ledgers.mobile,
      daraRate: ledgers.daraRate,
      akharRate: ledgers.akharRate,
      commissionRate: ledgers.commissionRate,
      hissaPercentage: ledgers.hissaPercentage,
      betLimit: ledgers.betLimit,
      capping: ledgers.capping,
      hasLimit: ledgers.hasLimit,
      vapsiTpr: ledgers.vapsiTpr,
      isLocked: ledgers.isLocked,
      isRisky: ledgers.isRisky,
      updatedBy: ledgers.updatedBy,
      updatedAt: ledgers.updatedAt,
      createdAt: ledgers.createdAt,
    })
    .from(ledgers)
    .leftJoin(agents, eq(ledgers.agentId, agents.id));

    const list = whereClause 
      ? await query.where(whereClause).orderBy(asc(ledgers.id))
      : await query.orderBy(asc(ledgers.id));

    return list.map(l => ({
      ...l,
      agentName: l.agentName || '-NA-',
      userName: l.userName || l.partyName.slice(0, 8),
      groupName: l.groupName || 'Fanter',
      vapsiTpr: l.vapsiTpr || '10 | NO',
      updatedBy: l.updatedBy || 'A100',
      daraRate: parseFloat(l.daraRate),
      akharRate: parseFloat(l.akharRate),
      commissionRate: parseFloat(l.commissionRate),
      hissaPercentage: parseFloat(l.hissaPercentage),
      betLimit: parseFloat(l.betLimit),
      capping: parseFloat(l.capping),
      updatedAt: l.updatedAt ? l.updatedAt.toISOString() : l.createdAt.toISOString(),
      createdAt: l.createdAt.toISOString(),
    }));
  }

  static async createLedger(data: any) {
    const [existing] = await db.select().from(ledgers).where(
      and(eq(ledgers.partyName, data.partyName), isNull(ledgers.deletedAt))
    );

    if (existing) {
      throw new AppError('Party name already exists', 400);
    }

    let agentId = data.agentId ? parseInt(data.agentId, 10) : null;
    if (!agentId && data.agentName && data.agentName.trim()) {
      const cleanName = data.agentName.trim().toUpperCase();
      const [matchedAgent] = await db.select().from(agents).where(eq(agents.agentName, cleanName)).limit(1);
      if (matchedAgent) {
        agentId = matchedAgent.id;
      }
    }

    const [created] = await db.insert(ledgers).values({
      partyName: data.partyName.trim().toUpperCase(),
      realName: data.realName,
      userName: data.userName || Math.floor(10000000 + Math.random() * 90000000).toString(),
      groupName: data.groupName || 'Fanter',
      agentId,
      distributorId: data.distributorId ? parseInt(data.distributorId, 10) : null,
      telegram: data.telegram,
      mobile: data.mobile,
      daraRate: (data.daraRate ?? 90).toString(),
      akharRate: (data.akharRate ?? 9).toString(),
      commissionRate: (data.commissionRate ?? 0).toString(),
      hissaPercentage: (data.hissaPercentage ?? 0).toString(),
      betLimit: (data.betLimit ?? 0).toString(),
      capping: (data.capping ?? 0).toString(),
      hasLimit: data.hasLimit ?? false,
      vapsiTpr: data.vapsiTpr || '10 | NO',
      isLocked: data.isLocked ?? false,
      isRisky: data.isRisky ?? false,
      updatedBy: data.updatedBy || 'A100',
    }).returning();

    return created;
  }

  static async updateLedger(id: number, data: any) {
    const updatePayload: any = {
      updatedAt: new Date(),
    };

    if (data.partyName) updatePayload.partyName = data.partyName.trim().toUpperCase();
    if (data.realName !== undefined) updatePayload.realName = data.realName;
    if (data.userName !== undefined) updatePayload.userName = data.userName;
    if (data.groupName !== undefined) updatePayload.groupName = data.groupName;
    if (data.agentId !== undefined) updatePayload.agentId = data.agentId ? parseInt(data.agentId, 10) : null;
    if (data.distributorId !== undefined) updatePayload.distributorId = data.distributorId ? parseInt(data.distributorId, 10) : null;
    if (data.retailerId !== undefined) updatePayload.retailerId = data.retailerId ? parseInt(data.retailerId, 10) : null;
    if (data.refLedgerId !== undefined) updatePayload.refLedgerId = data.refLedgerId ? parseInt(data.refLedgerId, 10) : null;
    if (data.hpLedgerId !== undefined) updatePayload.hpLedgerId = data.hpLedgerId ? parseInt(data.hpLedgerId, 10) : null;
    if (data.telegram !== undefined) updatePayload.telegram = data.telegram;
    if (data.mobile !== undefined) updatePayload.mobile = data.mobile;
    if (data.address !== undefined) updatePayload.address = data.address;
    if (data.grantor !== undefined) updatePayload.grantor = data.grantor;
    if (data.dealing !== undefined) updatePayload.dealing = data.dealing;
    if (data.daraRate !== undefined) updatePayload.daraRate = data.daraRate.toString();
    if (data.akharRate !== undefined) updatePayload.akharRate = data.akharRate.toString();
    if (data.commissionRate !== undefined) updatePayload.commissionRate = data.commissionRate.toString();
    if (data.hissaPercentage !== undefined) updatePayload.hissaPercentage = data.hissaPercentage.toString();
    if (data.betLimit !== undefined) updatePayload.betLimit = data.betLimit.toString();
    if (data.rebate !== undefined) updatePayload.rebate = data.rebate.toString();
    if (data.dAmt !== undefined) updatePayload.dAmt = data.dAmt.toString();
    if (data.dibba !== undefined) updatePayload.dibba = data.dibba;
    if (data.hasLimit !== undefined) updatePayload.hasLimit = data.hasLimit;
    if (data.vapsiTpr !== undefined) updatePayload.vapsiTpr = data.vapsiTpr;
    if (data.capping !== undefined) updatePayload.capping = data.capping.toString();
    if (data.isLocked !== undefined) updatePayload.isLocked = data.isLocked;
    if (data.isRisky !== undefined) updatePayload.isRisky = data.isRisky;
    if (data.updatedBy !== undefined) updatePayload.updatedBy = data.updatedBy;

    const [updated] = await db.update(ledgers)
      .set(updatePayload)
      .where(eq(ledgers.id, id))
      .returning();

    if (!updated) throw new AppError('Ledger not found', 404);
    return updated;
  }

  static async softDelete(id: number) {
    const [updated] = await db.update(ledgers)
      .set({ deletedAt: new Date() })
      .where(eq(ledgers.id, id))
      .returning();
    return updated;
  }
}
