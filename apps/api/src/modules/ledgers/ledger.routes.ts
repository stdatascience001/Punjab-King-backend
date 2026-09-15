import { Router } from 'express';
import { LedgerController } from './ledger.controller.js';
import { authenticate, requireRoles } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { createLedgerSchema } from '@pb/validation';

const router = Router();

router.use(authenticate);

router.get('/', LedgerController.list);
router.get('/search', LedgerController.search);
router.get('/:id', LedgerController.getById);
router.post('/', requireRoles('DEVELOPER', 'SUPER ADMIN', 'ADMIN'), validate(createLedgerSchema), LedgerController.create);
router.put('/:id', requireRoles('DEVELOPER', 'SUPER ADMIN', 'ADMIN'), LedgerController.update);
router.delete('/:id', requireRoles('DEVELOPER', 'SUPER ADMIN'), LedgerController.delete);

export const ledgerRoutes = router;
