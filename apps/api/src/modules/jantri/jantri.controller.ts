import { Request, Response, NextFunction } from 'express';
import { JantriService } from './jantri.service.js';
import { sendSuccess } from '../../common/response.js';

export class JantriController {
  static async getShiftJantri(req: Request, res: Response, next: NextFunction) {
    try {
      const shiftId = parseInt(req.params.shiftId as string, 10);
      const data = await JantriService.getJantriView(shiftId);
      return sendSuccess(res, data, 'Jantri view data loaded');
    } catch (err) {
      next(err);
    }
  }

  static async getPrediction(req: Request, res: Response, next: NextFunction) {
    try {
      const shiftId = parseInt(req.params.shiftId as string, 10);
      const focusNumber = req.query.number as string | undefined;
      const data = await JantriService.getPredictionData(shiftId, focusNumber);
      return sendSuccess(res, data, 'Prediction data loaded');
    } catch (err) {
      next(err);
    }
  }
}
