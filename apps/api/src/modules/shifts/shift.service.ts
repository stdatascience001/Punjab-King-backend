import { db, shifts, shiftRoleConfig, roles, users, staff, operatorShiftPermissions } from '@pb/database';
import { eq, and, desc } from 'drizzle-orm';
import { AppError, CutoffError } from '../../common/errors.js';
import { ShiftDto, ShiftRoleConfigDto, SystemRole } from '@pb/types';

export class ShiftService {
  static async listShifts(userRoleName?: SystemRole, userRoleId?: number) {
    const shiftList = await db.select()
      .from(shifts)
      .orderBy(desc(shifts.createdAt));

    const now = new Date();
    const currentTimeStr = now.toTimeString().slice(0, 8); // "HH:mm:ss"

    const results: ShiftDto[] = [];
    for (const s of shiftList) {
      const roleConfigs = await db.select()
        .from(shiftRoleConfig)
        .where(eq(shiftRoleConfig.shiftId, s.id));

      let isEntryAllowed = s.status === 'OPEN';
      let remainingSec = 0;

      if (userRoleId) {
        const userConfig = roleConfigs.find(rc => rc.roleId === userRoleId);
        if (userConfig) {
          if (currentTimeStr > userConfig.closeTime || currentTimeStr < userConfig.openTime) {
            isEntryAllowed = false;
          }
          const [h, m, sec] = userConfig.closeTime.split(':').map(Number);
          const closeDate = new Date();
          closeDate.setHours(h, m, sec, 0);
          remainingSec = Math.max(0, Math.floor((closeDate.getTime() - now.getTime()) / 1000));
        }
      }

      results.push({
        id: s.id,
        name: s.name,
        openDate: s.openDate,
        isNextDay: s.isNextDay,
        status: s.status as any,
        declaredNumber: s.declaredNumber,
        shiftFor: s.shiftFor || 'BOTH',
        isActive: s.isActive ?? true,
        updatedBy: s.updatedBy || 'A100',
        updatedAt: s.updatedAt ? s.updatedAt.toISOString() : s.createdAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
        roleConfigs: roleConfigs.map(rc => ({
          id: rc.id,
          shiftId: rc.shiftId,
          roleId: rc.roleId,
          openTime: rc.openTime,
          closeTime: rc.closeTime,
          isActive: rc.isActive,
        })),
        isEntryAllowedForRole: isEntryAllowed,
        timeRemainingSeconds: remainingSec,
      });
    }

    return results;
  }

  static async toggleActive(id: number) {
    const [existing] = await db.select().from(shifts).where(eq(shifts.id, id));
    if (!existing) throw new AppError('Shift not found', 404);

    const [updated] = await db.update(shifts)
      .set({ isActive: !existing.isActive, updatedAt: new Date() })
      .where(eq(shifts.id, id))
      .returning();

    return updated;
  }

  static async assertShiftOpenForRole(shiftId: number, roleId: number, roleName: SystemRole) {
    if (roleName === 'DEVELOPER' || roleName === 'SUPER ADMIN') {
      return;
    }

    const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId));

    if (!shift) {
      throw new AppError('Shift not found', 404);
    }

    if (shift.status !== 'OPEN') {
      throw new CutoffError(`Shift ${shift.name} is currently ${shift.status}`);
    }

    const [config] = await db.select().from(shiftRoleConfig).where(
      and(eq(shiftRoleConfig.shiftId, shiftId), eq(shiftRoleConfig.roleId, roleId))
    );

    if (!config || !config.isActive) {
      throw new CutoffError('No active shift timing configured for your role');
    }

    const currentTimeStr = new Date().toTimeString().slice(0, 8);
    if (currentTimeStr < config.openTime || currentTimeStr > config.closeTime) {
      throw new CutoffError(
        `Entry window closed for ${roleName}. Allowed: ${config.openTime} - ${config.closeTime}, Current Server Time: ${currentTimeStr}`
      );
    }
  }

  static async createShift(name: string, openDate: string, isNextDay = false, roleConfigs?: any[]) {
    const [created] = await db.insert(shifts).values({
      name: name.toUpperCase(),
      openDate,
      isNextDay,
      status: 'OPEN',
    }).returning();

    if (roleConfigs && roleConfigs.length > 0) {
      for (const rc of roleConfigs) {
        await db.insert(shiftRoleConfig).values({
          shiftId: created.id,
          roleId: rc.roleId,
          openTime: rc.openTime,
          closeTime: rc.closeTime,
          isActive: rc.isActive ?? true,
        });
      }
    } else {
      const allRoles = await db.select().from(roles);
      for (const r of allRoles) {
        await db.insert(shiftRoleConfig).values({
          shiftId: created.id,
          roleId: r.id,
          openTime: '09:00:00',
          closeTime: '20:00:00',
          isActive: true,
        });
      }
    }

    return created;
  }

  static async updateShift(
    id: number,
    data: {
      name?: string;
      openDate?: string;
      isNextDay?: boolean;
      shiftFor?: string;
      roleConfigs?: any[];
    },
    updatedBy = 'A100'
  ) {
    const [existing] = await db.select().from(shifts).where(eq(shifts.id, id));
    if (!existing) throw new AppError('Shift not found', 404);

    const updatePayload: any = {
      updatedAt: new Date(),
      updatedBy,
    };

    if (data.name !== undefined && data.name.trim() !== '') {
      updatePayload.name = data.name.trim().toUpperCase();
    }
    if (data.openDate !== undefined && data.openDate.trim() !== '') {
      let formattedDate = data.openDate.trim();
      if (formattedDate.includes('-')) {
        const parts = formattedDate.split('-');
        if (parts.length === 3 && parts[0].length === 2) {
          formattedDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
      }
      updatePayload.openDate = formattedDate;
    }
    if (data.isNextDay !== undefined) {
      updatePayload.isNextDay = data.isNextDay;
    }
    if (data.shiftFor !== undefined && data.shiftFor.trim() !== '') {
      updatePayload.shiftFor = data.shiftFor.trim().toUpperCase();
    }

    const [updated] = await db
      .update(shifts)
      .set(updatePayload)
      .where(eq(shifts.id, id))
      .returning();

    if (data.roleConfigs && data.roleConfigs.length > 0) {
      for (const rc of data.roleConfigs) {
        const [existingRc] = await db
          .select()
          .from(shiftRoleConfig)
          .where(and(eq(shiftRoleConfig.shiftId, id), eq(shiftRoleConfig.roleId, rc.roleId)));

        if (existingRc) {
          await db
            .update(shiftRoleConfig)
            .set({
              closeTime: rc.closeTime,
              openTime: rc.openTime || existingRc.openTime,
              isActive: rc.isActive !== undefined ? rc.isActive : existingRc.isActive,
            })
            .where(eq(shiftRoleConfig.id, existingRc.id));
        } else {
          await db.insert(shiftRoleConfig).values({
            shiftId: id,
            roleId: rc.roleId,
            openTime: rc.openTime || '09:00:00',
            closeTime: rc.closeTime || '20:44:00',
            isActive: rc.isActive ?? true,
          });
        }
      }
    }

    return updated;
  }

  static async listOperators() {
    return await db.select({
      userId: users.id,
      username: users.username,
      fullName: staff.fullName,
      designation: staff.designation,
      roleName: roles.name,
    })
    .from(users)
    .leftJoin(staff, eq(users.id, staff.userId))
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.isActive, true))
    .orderBy(users.username);
  }

  static async getOperatorPermissions(userId: number) {
    return await db.select()
      .from(operatorShiftPermissions)
      .where(eq(operatorShiftPermissions.userId, userId));
  }

  static async saveOperatorPermissions(userId: number, permissions: Array<{
    shiftId: number;
    shiftDate: string;
    canAllow: boolean;
    canAdd: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canExport: boolean;
    dataScope: string;
    expiresAt?: string | null;
  }>) {
    for (const p of permissions) {
      const [existing] = await db.select()
        .from(operatorShiftPermissions)
        .where(and(eq(operatorShiftPermissions.userId, userId), eq(operatorShiftPermissions.shiftId, p.shiftId)));

      const expDate = p.expiresAt ? new Date(p.expiresAt) : null;

      if (existing) {
        await db.update(operatorShiftPermissions).set({
          shiftDate: p.shiftDate,
          canAllow: p.canAllow,
          canAdd: p.canAdd,
          canEdit: p.canEdit,
          canDelete: p.canDelete,
          canExport: p.canExport,
          dataScope: p.dataScope || 'SELF',
          expiresAt: expDate,
        }).where(eq(operatorShiftPermissions.id, existing.id));
      } else {
        await db.insert(operatorShiftPermissions).values({
          userId,
          shiftId: p.shiftId,
          shiftDate: p.shiftDate,
          canAllow: p.canAllow,
          canAdd: p.canAdd,
          canEdit: p.canEdit,
          canDelete: p.canDelete,
          canExport: p.canExport,
          dataScope: p.dataScope || 'SELF',
          expiresAt: expDate,
        });
      }
    }
    return { message: 'Operator permissions saved successfully' };
  }
}

