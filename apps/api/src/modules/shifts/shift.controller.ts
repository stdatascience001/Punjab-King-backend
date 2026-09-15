import { Request, Response, NextFunction } from 'express';
import { ShiftService } from './shift.service.js';
import { sendSuccess } from '../../common/response.js';

export class ShiftController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const userRoleId = req.user?.roleId;
      const userRoleName = req.user?.roleName;
      const shifts = await ShiftService.listShifts(userRoleName, userRoleId);
      return sendSuccess(res, shifts, 'Shift list retrieved');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, openDate, isNextDay, roleConfigs } = req.body;
      const created = await ShiftService.createShift(name, openDate, isNextDay, roleConfigs);
      return sendSuccess(res, created, 'Shift created successfully', 201);
    } catch (err) {
      next(err);
    }
  }

  static async toggleActive(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id as string, 10);
      const updated = await ShiftService.toggleActive(id);
      return sendSuccess(res, updated, 'Shift active status updated');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id as string, 10);
      const userIdentifier = req.user?.username || 'A100';
      const updated = await ShiftService.updateShift(id, req.body, userIdentifier);
      return sendSuccess(res, updated, 'Shift updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async listOperators(req: Request, res: Response, next: NextFunction) {
    try {
      const operators = await ShiftService.listOperators();
      return sendSuccess(res, operators, 'Operators retrieved');
    } catch (err) {
      next(err);
    }
  }

  static async getOperatorPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = parseInt(req.params.userId as string, 10);
      const perms = await ShiftService.getOperatorPermissions(userId);
      return sendSuccess(res, perms, 'Permissions retrieved');
    } catch (err) {
      next(err);
    }
  }

  static async saveOperatorPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = parseInt(req.params.userId as string, 10);
      const { permissions } = req.body;
      const result = await ShiftService.saveOperatorPermissions(userId, permissions || []);
      return sendSuccess(res, result, 'Permissions saved successfully');
    } catch (err) {
      next(err);
    }
  }
}

