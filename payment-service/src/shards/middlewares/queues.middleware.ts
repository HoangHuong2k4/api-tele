import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { ConnectionOptions, Queue } from 'bullmq';

export function queueUIMiddleware(connection: ConnectionOptions) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  const queues = [`bot-TELEGRAM`, `bot-DISCORD`, 'webhook'].map(
    (queueName) =>
      new BullMQAdapter(
        new Queue(queueName, {
          connection,
        }),
      ),
  );
  createBullBoard({
    queues,
    serverAdapter,
  });

  const router = serverAdapter.getRouter();
  return (req, res, next) => {
    const token = process.env.PAYMENT_SERVICE_ADMIN_TOKEN;
    const providedToken =
      req.headers['x-admin-token'] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || providedToken !== token) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    return router(req, res, next);
  };
}
