/**
 * Agent-side entry point: mounts the Fastify routes zn-vault-agent loads
 * to drive Archon deployments (diff deploy, migrations, service/reboot control).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { ArchonManager } from './archon-manager.js';
import { hashManagedFiles, applyDiff, makeSudoFileOps, type DiffInput, type RunResult } from './differ.js';
import { DeploymentJournal } from './deployment-journal.js';
import { registerRoutes } from './routes/index.js';
import type { ArchonPluginConfig } from './plugin-config.js';

/** Spawn a process and collect its exit code + output — the production `run`
 *  for the sudo file ops (mocked in tests). */
function spawnRun(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

// The zn-vault-agent plugin loader rejects any plugin without a non-empty
// `version` string (loader.js validatePlugin). Read it from our own
// package.json at module load, with a fallback so a packaging quirk degrades
// to a valid-but-unknown version rather than a hard load failure.
export const PLUGIN_VERSION: string = (() => {
  try {
    // dist/index.js → package.json is one level up (../package.json).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Structural — matches @zincapp/zn-vault-agent/plugins' AgentPlugin, but not
// imported directly so this package doesn't hard-depend on the agent's
// concrete types at compile time (peerDependency, optional at runtime).
export interface AgentPlugin {
  name: string;
  version: string;
  routes(fastify: FastifyInstance, ctx: { logger: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void } }): Promise<void>;
}

export default function createArchonPlugin(config: ArchonPluginConfig): AgentPlugin {
  const mgr = new ArchonManager(config);
  const journal = new DeploymentJournal(config.appRoot);
  // Writes run as the app user (config.user) via sudo — the app tree is owned
  // by that user, not the agent, so a direct fs.writeFile hits EACCES.
  const fileOps = makeSudoFileOps(config.user, spawnRun);
  const differ = {
    hash: () => hashManagedFiles(config.appRoot),
    apply: (input: DiffInput) => applyDiff(config.appRoot, input, fileOps),
  };
  return {
    name: 'archon',
    version: PLUGIN_VERSION,
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
