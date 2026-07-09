// GET /status — current systemd unit status via ArchonManager.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';

export async function registerStatusRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { mgr, logger } = ctx;

  fastify.get('/status', async (_request, reply) => {
    try {
      return await mgr.status();
    } catch (err) {
      logger.error({ err }, 'Failed to get status');
      return reply.code(500).send({ error: 'Failed to get status', message: getErrorMessage(err) });
    }
  });
}
