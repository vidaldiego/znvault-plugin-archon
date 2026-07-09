// Path: src/cli.ts
// CLI-side entry point: registers the `znvault archon …` command group with
// the znvault CLI plugin host. Mirrors znvault-plugin-payara's src/cli.ts
// structure — a top-level per-deployer group as a peer of `payara`, `deploy`
// as a verb group with `run`/`hashes` subcommands, `config` as a peer
// command group, and lifecycle (`restart`/`reboot`)/`quiesce` as further
// peers on the `archon` group.

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CLIPluginContext, CLIPlugin } from '@zincapp/znvault-deploy-core';
import { registerArchonCommands, type DeployCommandDeps } from './cli/commands.js';

// Read version from package.json at module load time (same pattern as payara).
let pluginVersion = '0.0.0';
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
  pluginVersion = pkg.version ?? '0.0.0';
} catch {
  pluginVersion = '0.0.0';
}

// Re-export CLIPlugin for consumers.
export type { CLIPlugin } from '@zincapp/znvault-deploy-core';

/**
 * Archon CLI plugin.
 *
 * Adds `znvault archon deploy/config/restart/reboot/quiesce` commands.
 * `deps` is test-only injection for the deploy command's migration-runner
 * wiring (never used by production callers, who rely on the real Vault
 * client + `npx prisma migrate deploy`).
 */
export function createArchonCLIPlugin(deps?: DeployCommandDeps): CLIPlugin {
  return {
    name: 'archon',
    version: pluginVersion,
    description: 'Archon deployment commands (diff deploy, Prisma migrations, service/reboot control)',

    registerCommands(program: Command, ctx: CLIPluginContext): void {
      // Top-level per-deployer group — a peer of `payara` and any future
      // deployer plugin's own top-level group.
      const archon = program
        .command('archon')
        .description('Archon deployment & management');

      registerArchonCommands(archon, ctx, deps);
    },
  };
}

// Default export for CLI plugin.
export default createArchonCLIPlugin;
