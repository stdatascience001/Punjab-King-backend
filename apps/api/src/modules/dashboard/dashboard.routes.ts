import { Router } from 'express';
import { DashboardController } from './dashboard.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';

export const dashboardRoutes = Router();

// Allow authenticated users to fetch live dashboard metrics
dashboardRoutes.get('/metrics', authenticate, DashboardController.getMetrics);
dashboardRoutes.get('/', authenticate, DashboardController.getMetrics);
