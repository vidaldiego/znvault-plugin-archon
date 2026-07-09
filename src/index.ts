/**
 * Agent-side entry point: mounts the Fastify routes zn-vault-agent loads
 * to drive Archon deployments (diff deploy, migrations, service/reboot control).
 */
import type { FastifyInstance } from 'fastify';
import { ArchonManager } from './archon-manager.js';
import { hashManagedFiles, applyDiff, type DiffInput } from './differ.js';
import { DeploymentJournal } from './deployment-journal.js';
import { registerRoutes } from './routes/index.js';
import type { ArchonPluginConfig } from './plugin-config.js';

// Structural — matches @zincapp/zn-vault-agent/plugins' AgentPlugin, but not
// imported directly so this package doesn't hard-depend on the agent's
// concrete types at compile time (peerDependency, optional at runtime).
export interface AgentPlugin {
  name: string;
  routes(fastify: FastifyInstance, ctx: { logger: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void } }): Promise<void>;
}

export default function createArchonPlugin(config: ArchonPluginConfig): AgentPlugin {
  const mgr = new ArchonManager(config);
  const journal = new DeploymentJournal(config.appRoot);
  const differ = {
    hash: () => hashManagedFiles(config.appRoot),
    apply: (input: DiffInput, owner: { uid: number; gid: number }) => applyDiff(config.appRoot, input, owner),
  };
  return {
    name: 'archon',
    async routes(fastify: FastifyInstance, ctx: { logger: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void } }): Promise<void> {
      await registerRoutes(fastify, mgr, differ, journal, config, ctx.logger);
      ctx.logger.info({}, 'Archon routes registered');
    },
  };
}

export { ArchonManager } from './archon-manager.js';
export { hashManagedFiles, applyDiff } from './differ.js';
export { DeploymentJournal } from './deployment-journal.js';
export { registerRoutes } from './routes/index.js';
export type { ArchonPluginConfig } from './plugin-config.js';
export type { HashManifest, DiffInput } from './differ.js';
export type { DeploymentCheckpoint } from './deployment-journal.js';
