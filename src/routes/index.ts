// Agent-side HTTP routes for the archon plugin. zn-vault-agent mounts these
// under /plugins/archon/ (see @zincapp/zn-vault-agent's plugin loader).

import type { FastifyInstance } from 'fastify';
import type { ArchonPluginConfig } from '../plugin-config.js';
import type { DifferLike, JournalLike, ManagerLike, RouteContext, RouteLogger } from './types.js';
import { registerHashesRoutes } from './hashes.js';
import { registerDeployRoutes } from './deploy.js';
import { registerLifecycleRoutes } from './lifecycle.js';
import { registerStatusRoutes } from './status.js';
import { registerQuiesceRoutes } from './quiesce.js';

/**
 * Register all archon plugin HTTP routes.
 *
 * Routes:
 * - GET  /hashes          — managed-file hash manifest (differ.hash)
 * - POST /deploy          — apply a file diff (journal-wrapped)
 * - POST /deploy/full     — apply a full file set (journal-wrapped)
 * - POST /deploy/chunk    — chunked upload + optional commit
 * - GET  /deploy/status   — current journal / deploy-in-flight state
 * - POST /restart|/start|/stop — service lifecycle via ArchonManager
 * - POST /reboot          — guarded host reboot (hostname confirm + journal-closed)
 * - GET  /status           — service status via ArchonManager
 * - POST /quiesce, POST /resume, GET /quiesce/status — passthrough to the app's own health-probe port
 */
export async function registerRoutes(
  fastify: FastifyInstance,
  mgr: ManagerLike,
  differ: DifferLike,
  journal: JournalLike,
  cfg: ArchonPluginConfig,
  logger: RouteLogger,
): Promise<void> {
  const ctx: RouteContext = { mgr, differ, journal, cfg, logger };

  await registerHashesRoutes(fastify, ctx);
  await registerDeployRoutes(fastify, ctx);
  await registerLifecycleRoutes(fastify, ctx);
  await registerStatusRoutes(fastify, ctx);
  await registerQuiesceRoutes(fastify, ctx);
}

export type { RouteContext, ManagerLike, DifferLike, JournalLike, RouteLogger } from './types.js';
