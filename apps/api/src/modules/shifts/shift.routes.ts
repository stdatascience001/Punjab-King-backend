import { Router } from 'express';
import { ShiftController } from './shift.controller.js';
import { authenticate, requireRoles } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { createShiftSchema } from '@pb/validation';

const router = Router();

router.use(authenticate);

router.get('/', ShiftController.list);
router.post('/', requireRoles('DEVELOPER', 'SUPER ADMIN', 'ADMIN'), validate(createShiftSchema), ShiftController.create);
router.get('/permissions/operators', ShiftController.listOperators);
router.get('/permissions/:userId', ShiftController.getOperatorPermissions);
router.post('/permissions/:userId', requireRoles('DEVELOPER', 'SUPER ADMIN', 'ADMIN'), ShiftController.saveOperatorPermissions);
router.patch('/:id/toggle-active', requireRoles('DEVELOPER', 'SUPER ADMIN', 'ADMIN'), ShiftController.toggleActive);
router.patch('/:id', requireRoles('DEVELOPER', 'SUPER ADMIN', 'ADMIN'), ShiftController.update);
router.put('/:id', requireRoles('DEVELOPER', 'SUPER ADMIN', 'ADMIN'), ShiftController.update);

export const shiftRoutes = router;

