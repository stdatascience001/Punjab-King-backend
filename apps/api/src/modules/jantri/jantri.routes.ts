import { Router } from 'express';
import { JantriController } from './jantri.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/:shiftId/prediction', JantriController.getPrediction);
router.get('/:shiftId', JantriController.getShiftJantri);

export const jantriRoutes = router;
