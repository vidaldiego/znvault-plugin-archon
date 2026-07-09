// Lifecycle routes — service restart/start/stop, plus the guarded reboot.
//
// POST /reboot is the load-bearing safety route: it delegates entirely to
// ArchonManager.reboot's guard (hostname confirmation + "no deploy journal
// open"), which is unit-tested in test/archon-manager.test.ts. This route's
// only job is reading {confirm} from the body, resolving the two guard
// inputs (journal.hostname(), journal.isOpen()) at request time, and mapping
// the guard's accepted/rejected outcome onto HTTP status codes.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';

interface RebootBody { confirm?: string; }

export async function registerLifecycleRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { mgr, journal, logger } = ctx;

  fastify.post('/restart', async (_request, reply) => {
    try {
      logger.info({}, 'Restarting archon service');
      await mgr.restart();
      return { status: 'restarted' };
    } catch (err) {
      logger.error({ err }, 'Restart failed');
      return reply.code(500).send({ error: 'Restart failed', message: getErrorMessage(err) });
    }
  });

  fastify.post('/start', async (_request, reply) => {
    try {
      logger.info({}, 'Starting archon service');
      await mgr.start();
      return { status: 'started' };
    } catch (err) {
      logger.error({ err }, 'Start failed');
      return reply.code(500).send({ error: 'Start failed', message: getErrorMessage(err) });
    }
  });

  fastify.post('/stop', async (_request, reply) => {
    try {
      logger.info({}, 'Stopping archon service');
      await mgr.stop();
      return { status: 'stopped' };
    } catch (err) {
      logger.error({ err }, 'Stop failed');
      return reply.code(500).send({ error: 'Stop failed', message: getErrorMessage(err) });
    }
  });

  fastify.post<{ Body: RebootBody }>('/reboot', async (request, reply) => {
    const confirm = request.body?.confirm;
    if (typeof confirm !== 'string' || confirm.length === 0) {
      return reply.code(400).send({ error: 'Invalid request', message: 'confirm (hostname) is required' });
    }
    try {
      const result = await mgr.reboot(confirm, journal.hostname(), journal.isOpen());
      if (!result.accepted) {
        return reply.code(409).send({ error: 'Reboot refused', message: result.reason ?? 'reboot guard refused the request' });
      }
      return reply.code(202).send({ status: 'reboot accepted' });
    } catch (err) {
      logger.error({ err }, 'Reboot failed');
      return reply.code(500).send({ error: 'Reboot failed', message: getErrorMessage(err) });
    }
  });
}
