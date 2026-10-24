import { Router } from 'express';
import * as webhookController from '../controllers/webhook.controller';

const router = Router();

router.get('/callback', webhookController.checkActive);
router.post('/callback', webhookController.handleCallback);

router.get('/callback-mb', webhookController.checkActive);
router.post('/callback-mb', webhookController.handleCallback);

router.get('/callback-acb', webhookController.checkActive);
router.post('/callback-acb', webhookController.handleCallbackAcb);

export default router;
