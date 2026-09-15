import { pgTable, serial, varchar, timestamp, boolean, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { roles, users } from './auth.js';

export const shifts = pgTable('shifts', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  openDate: varchar('open_date', { length: 10 }).notNull(), // YYYY-MM-DD
  isNextDay: boolean('is_next_day').default(false).notNull(),
  status: varchar('status', { length: 20 }).default('OPEN').notNull(), // OPEN, CLOSED, DECLARED, AUDITED
  declaredNumber: varchar('declared_number', { length: 10 }),
  shiftFor: varchar('shift_for', { length: 20 }).default('BOTH').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  updatedBy: varchar('updated_by', { length: 100 }).default('A100').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  shiftDateIdx: index('shifts_date_idx').on(t.openDate, t.status),
}));

export const shiftRoleConfig = pgTable('shift_role_config', {
  id: serial('id').primaryKey(),
  shiftId: integer('shift_id').references(() => shifts.id, { onDelete: 'cascade' }).notNull(),
  roleId: integer('role_id').references(() => roles.id).notNull(),
  openTime: varchar('open_time', { length: 8 }).notNull(), // HH:mm:ss
  closeTime: varchar('close_time', { length: 8 }).notNull(), // HH:mm:ss
  isActive: boolean('is_active').default(true).notNull(),
}, (t) => ({
  uniqueShiftRole: uniqueIndex('unique_shift_role').on(t.shiftId, t.roleId),
}));

export const operatorShiftPermissions = pgTable('operator_shift_permissions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  shiftId: integer('shift_id').references(() => shifts.id).notNull(),
  shiftDate: varchar('shift_date', { length: 10 }).notNull(),
  canAllow: boolean('can_allow').default(true).notNull(),
  canAdd: boolean('can_add').default(true).notNull(),
  canEdit: boolean('can_edit').default(false).notNull(),
  canDelete: boolean('can_delete').default(false).notNull(),
  canExport: boolean('can_export').default(false).notNull(),
  dataScope: varchar('data_scope', { length: 10 }).default('SELF').notNull(), // ALL or SELF
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
