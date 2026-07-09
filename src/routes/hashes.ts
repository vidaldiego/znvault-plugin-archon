// GET /hashes — returns the managed-file hash manifest (see src/differ.ts).
// The CLI (Task 6) diffs this against its local build to compute what to send to /deploy.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';

export async function registerHashesRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { differ, logger } = ctx;

  fastify.get('/hashes', async (_request, reply) => {
    try {
      return await differ.hash();
    } catch (err) {
      logger.error({ err }, 'Failed to compute hash manifest');
      return reply.code(500).send({ error: 'Failed to compute hash manifest', message: getErrorMessage(err) });
    }
  });
}
