// Quiesce passthrough — proxies the deploy-time quiesce/resume/status calls
// through to Archon's own in-app HTTP endpoints (Plan 1's scheduler-drain
// feature) on 127.0.0.1:<healthProbePort>. This lets the CLI's deploy
// pipeline (Task 6) call the SAME agent host+port for everything, without
// needing a second network path directly to the app's health-probe port
// (which is typically not exposed outside localhost).
//
// Not every Archon build has the quiesce endpoints (older builds, or nodes
// running in a mode without a scheduler to drain). Rather than fail the
// whole deploy pipeline over a 404/ECONNREFUSED from the app, this degrades
// to a 200 no-op — quiesce-before-deploy is a best-effort safety net, not a
// hard requirement, and a hard failure here would block deploys to any node
// that predates the feature.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';

const NOOP_REASONS = new Set(['not_found', 'connection_refused']);

async function proxy(
  cfg: RouteContext['cfg'],
  logger: RouteContext['logger'],
  path: '/quiesce' | '/resume' | '/quiesce/status',
  method: 'GET' | 'POST',
): Promise<{ status: number; body: unknown }> {
  const url = `http://127.0.0.1:${cfg.healthProbePort}${path}`;
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) {
      return { status: 200, body: { status: 'noop', reason: 'not_found', message: 'App does not expose quiesce endpoints' } };
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (err) {
    logger.warn?.({ err, url }, 'Quiesce passthrough call failed — degrading to no-op');
    return { status: 200, body: { status: 'noop', reason: 'connection_refused', message: getErrorMessage(err) } };
  }
}

export async function registerQuiesceRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { cfg, logger } = ctx;

  fastify.post('/quiesce', async (_request, reply) => {
    const { status, body } = await proxy(cfg, logger, '/quiesce', 'POST');
    return reply.code(status).send(body);
  });

  fastify.post('/resume', async (_request, reply) => {
    const { status, body } = await proxy(cfg, logger, '/resume', 'POST');
    return reply.code(status).send(body);
  });

  fastify.get('/quiesce/status', async (_request, reply) => {
    const { status, body } = await proxy(cfg, logger, '/quiesce/status', 'GET');
    return reply.code(status).send(body);
  });
}

// Exported for tests that want to assert on the degrade set without
// reaching into the closure above.
export const QUIESCE_NOOP_REASONS = NOOP_REASONS;
