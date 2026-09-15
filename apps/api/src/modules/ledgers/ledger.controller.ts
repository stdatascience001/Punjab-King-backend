import { Request, Response, NextFunction } from 'express';
import { LedgerService } from './ledger.service.js';
import { sendSuccess } from '../../common/response.js';

export class LedgerController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const status = req.query.status as string | undefined;
      const list = await LedgerService.listLedgers(status);
      return sendSuccess(res, list, 'Ledger list retrieved');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id as string, 10);
      const ledger = await LedgerService.getLedgerById(id);
      return sendSuccess(res, ledger, 'Ledger detail retrieved');
    } catch (err) {
      next(err);
    }
  }

  static async search(req: Request, res: Response, next: NextFunction) {
    try {
      const q = (req.query.q as string) || '';
      const list = await LedgerService.searchParties(q);
      return sendSuccess(res, list, 'Parties searched');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const created = await LedgerService.createLedger(req.body);
      return sendSuccess(res, created, 'Ledger created', 201);
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id as string, 10);
      const updated = await LedgerService.updateLedger(id, req.body);
      return sendSuccess(res, updated, 'Ledger updated');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id as string, 10);
      const deleted = await LedgerService.softDelete(id);
      return sendSuccess(res, deleted, 'Ledger soft-deleted');
    } catch (err) {
      next(err);
    }
  }
}
