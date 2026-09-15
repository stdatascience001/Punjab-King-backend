export type ShiftStatus = 'PENDING' | 'OPEN' | 'CLOSED' | 'DECLARED' | 'AUDITED';

export interface ShiftRoleConfigDto {
  id?: number;
  shiftId: number;
  roleId: number;
  roleName?: string;
  openTime: string; // HH:mm:ss
  closeTime: string; // HH:mm:ss
  isActive: boolean;
}

export interface ShiftDto {
  id: number;
  name: string;
  openDate: string; // YYYY-MM-DD
  isNextDay: boolean;
  status: ShiftStatus;
  declaredNumber?: string | null;
  createdAt: string;
  roleConfigs?: ShiftRoleConfigDto[];
  timeRemainingSeconds?: number;
  isEntryAllowedForRole?: boolean;
  shiftFor?: string;
  isActive?: boolean;
  updatedBy?: string;
  updatedAt?: string;
}
