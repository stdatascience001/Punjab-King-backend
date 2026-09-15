import { Request, Response, NextFunction } from 'express';
import { DashboardService } from './dashboard.service.js';

export class DashboardController {
  static async getMetrics(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      const data = await DashboardService.getDashboardMetrics(user?.roleName, user?.roleId);
      res.json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }
}
