// Path: src/cli/commands.ts
// Command handlers for `znvault archon ...`, registered by src/cli.ts.
//
// Wires @zincapp/znvault-deploy-core's target-agnostic machinery (multi-class
// executor, migration gate, config-store, ssh tunnel, host-checks,
// buildPluginUrl) together with archon-specific pieces: Task 4's
// makeArchonRunPhase (Prisma migration runner over a reused Vault lease) and
// Task 6's differ-client (local build hashing + diff against the agent's
// GET /hashes).
//
// CRITICAL: every deploy-core call that takes a `pluginNamespace` argument is
// passed 'archon' explicitly (never left to the 'payara' default) — this is
// what routes HTTP calls to /plugins/archon/* instead of /plugins/payara/*.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  type CLIPluginContext,
  type CLIPlugin,
  type DeployConfig,
  type DeployClass,
  type ConfigStoreLocation,
  type DeployToHostResult,
  loadDeployConfigs,
  saveDeployConfigs,
  getConfig,
  validateDeployConfig,
  resolveClass,
  partitionSelectedClasses,
  executeMultiClassDeployment,
  printMultiClassDryRun,
  printMultiClassSummary,
  runMigrationPhase,
  openTunnel,
  type Tunnel,
  buildPluginUrl,
  agentGet,
  agentPost,
  checkHostReachable,
  setEndpointOverride,
  clearEndpointOverride,
  type RunClassResult,
  type ResolvedClass,
  executeStrategy,
  parseDeploymentStrategy,
  drainServer,
  readyServer,
  testHAProxyConnectivity,
  getUnmappedHosts,
  performHealthCheck,
  hasActiveServerMap,
} from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../utils/error.js';
import { makeArchonRunPhase, type RunnerDeps } from './migration-runner.js';
import { computeDeployPlan, type RemoteHashManifest } from './differ-client.js';

/** Namespace archon registers its agent routes under: /plugins/archon/*. */
const PLUGIN_NAMESPACE = 'archon';

/** Default agent HTTP port (matches the agent's default plugin bind port). */
const DEFAULT_PORT = 9100;

/**
 * Where archon's saved deploy configs live on disk. Archon is a greenfield
 * plugin (no pre-v2 shared config location to migrate from), so
 * `legacyConfigFile` is omitted — see ConfigStoreLocation's doc comment.
 */
export function archonConfigStoreLocation(): ConfigStoreLocation {
  const configDir = join(homedir(), '.znvault', 'archon');
  return { configDir, configFile: join(configDir, 'configs.json') };
}

/**
 * Resolve the effective host+port a class/config's hosts should be reached
 * on, applying an active SSH-tunnel endpoint override (buildPluginUrl already
 * does this internally, but callers that need the raw agentGet/agentPost
 * URL — not the /plugins/archon prefixed one — build it via this helper).
 */
function archonPluginUrl(host: string, port: number): string {
  return buildPluginUrl(host, port, false, PLUGIN_NAMESPACE);
}

/**
 * Deps `runMigrationPhase` needs to actually run one phase — thin wrapper
 * around Task 4's makeArchonRunPhase so this module can inject fakes in
 * tests without touching a real Vault/Prisma.
 */
export interface DeployCommandDeps {
  runPhaseDeps?: Partial<RunnerDeps>;
}

/**
 * Register `znvault archon config ...` — CRUD over saved DeployConfigs at
 * ~/.znvault/archon/configs.json. Mirrors payara's config command surface,
 * trimmed to the fields archon actually uses (no warPath/haproxy authoring
 * commands — archon deploys build output via diff, not a WAR; haproxy can
 * still be set via `config set-haproxy-ref` if a config file is hand-edited).
 */
function registerConfigCommands(configCmd: Command, ctx: CLIPluginContext): void {
  const loc = archonConfigStoreLocation();

  configCmd
    .command('create <name>')
    .description('Create a new archon deployment configuration')
    .option('-h, --hosts <hosts>', 'Comma-separated list of hosts')
    .option('-p, --port <port>', `Agent port (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .option('--root <dir>', 'Project root (built output lives here) — required for deploy/migrations')
    .option('-d, --description <desc>', 'Configuration description')
    .action(async (name: string, options: { hosts?: string; port: string; root?: string; description?: string }) => {
      const configs = await loadDeployConfigs(loc);
      if (configs[name]) {
        ctx.output.error(`Config '${name}' already exists`);
        process.exit(1);
      }
      const port = Number.parseInt(options.port, 10);
      const config: DeployConfig = {
        name,
        hosts: options.hosts ? options.hosts.split(',').map((h) => h.trim()) : [],
        port,
        // deploy-core's DeployConfig requires a resolvable warPath for
        // validateDeployConfig; archon has no WAR file, so this is used only
        // as the "artifact root" marker — the actual deploy artifact is the
        // hash-diffed build tree at rootDir.
        warPath: options.root ?? '.',
        rootDir: options.root,
        description: options.description,
      };
      configs[name] = config;
      await saveDeployConfigs(loc, configs);
      ctx.output.success(`Created archon deployment config: ${name}`);
      if ((config.hosts ?? []).length > 0) ctx.output.info(`  Hosts: ${(config.hosts ?? []).join(', ')}`);
    });

  configCmd
    .command('list')
    .alias('ls')
    .description('List all archon deployment configurations')
    .action(async () => {
      const configs = await loadDeployConfigs(loc);
      const names = Object.keys(configs);
      if (names.length === 0) {
        ctx.output.info('No archon deployment configurations found.');
        ctx.output.info('Create one with: znvault archon config create <name>');
        return;
      }
      ctx.output.table(
        ['Name', 'Hosts', 'Root'],
        names.map((n) => {
          const c = configs[n]!;
          return [c.name, (c.hosts ?? []).join(', ') || '(none)', c.rootDir ?? '(not set)'];
        }),
      );
    });

  configCmd
    .command('show <name>')
    .description('Show archon deployment configuration details')
    .action(async (name: string) => {
      const config = await getConfig(loc, name);
      if (!config) {
        ctx.output.error(`Config '${name}' not found`);
        process.exit(1);
      }
      ctx.output.keyValue({
        name: config.name,
        hosts: (config.hosts ?? []).join(', ') || '(none)',
        port: config.port ?? DEFAULT_PORT,
        rootDir: config.rootDir ?? '(not set)',
        tunnel: config.tunnel ? 'yes (SSH-CA)' : 'no (direct)',
        migration: config.migration ? `role ${config.migration.roleId}` : '(not configured)',
        postMigration: config.postMigration ? `role ${config.postMigration.roleId}` : '(not configured)',
        classes: config.classes ? config.classes.map((c) => c.name).join(', ') : '(flat — no classes)',
      });
    });

  configCmd
    .command('delete <name>')
    .alias('rm')
    .description('Delete an archon deployment configuration')
    .action(async (name: string) => {
      const configs = await loadDeployConfigs(loc);
      if (!configs[name]) {
        ctx.output.error(`Config '${name}' not found`);
        process.exit(1);
      }
      delete configs[name];
      await saveDeployConfigs(loc, configs);
      ctx.output.success(`Deleted config: ${name}`);
    });

  configCmd
    .command('set-migration <name>')
    .description('Set (or clear) the migration config for an archon deployment configuration')
    .option('--role <roleId>', 'Dynamic-secrets role ID for the migration DB user (write role)')
    .option('--database <db>', 'DB name override (normally the Vault connection provides it)')
    .option('--phase <pre|post>', 'Which migration phase to set or clear (pre = before rollout, post = after)', 'pre')
    .option('--clear', 'Remove the migration config for the selected --phase')
    .action(async (
      name: string,
      options: { role?: string; database?: string; phase?: string; clear?: boolean },
    ) => {
      const configs = await loadDeployConfigs(loc);
      const config = configs[name];
      if (!config) {
        ctx.output.error(`Config '${name}' not found`);
        process.exit(1);
      }
      const phase = (options.phase ?? 'pre').toLowerCase();
      if (phase !== 'pre' && phase !== 'post') {
        ctx.output.error(`--phase must be 'pre' or 'post' (got '${options.phase}')`);
        process.exit(1);
      }
      const key: 'migration' | 'postMigration' = phase === 'post' ? 'postMigration' : 'migration';

      if (options.clear) {
        delete config[key];
        await saveDeployConfigs(loc, configs);
        ctx.output.success(`Cleared ${phase}-deploy migration config for '${name}'`);
        return;
      }
      if (!options.role) {
        ctx.output.error('--role <roleId> is required');
        process.exit(1);
      }
      // Archon has no migrationsDir — the Prisma runner uses the config's
      // rootDir (the project checkout with prisma/schema.prisma) directly.
      // migrationsDir is set to rootDir purely to satisfy deploy-core's
      // MigrationConfig shape / validateDeployConfig's non-empty check.
      config[key] = {
        roleId: options.role,
        migrationsDir: config.rootDir ?? '.',
        ...(options.database ? { database: options.database } : {}),
      };
      await saveDeployConfigs(loc, configs);
      ctx.output.success(`Set ${phase}-deploy migration config for '${name}' (role ${options.role})`);
    });

  configCmd
    .command('validate <name>')
    .description('Validate an archon deployment config (flat or multi-class)')
    .action(async (name: string) => {
      const config = await getConfig(loc, name);
      if (!config) {
        ctx.output.error(`Config '${name}' not found`);
        process.exit(1);
      }
      const report = validateDeployConfig(config);
      for (const i of report.info) ctx.output.info(i);
      for (const w of report.warnings) ctx.output.warn(w);
      for (const e of report.errors) ctx.output.error(e);
      if (report.errors.length > 0) {
        ctx.output.error(`Config '${name}' has ${report.errors.length} error(s).`);
        process.exit(1);
      }
      ctx.output.success(`Config '${name}' is valid${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ''}.`);
    });
}

/**
 * Run archon's migration-gate wrapper — thin adapter over deploy-core's
 * runMigrationPhase binding `runPhase` to Task 4's makeArchonRunPhase and
 * `dryRunRender` to a line that prints `role '<roleId>'` (archon has no
 * migrationsDir to display — the Prisma runner resolves everything it needs
 * from projectPath). Labels are archon-flavored ('build' artifact, 'archon
 * deploy run ... --post-only' recovery hint) so skip/gate messages read
 * correctly instead of inheriting payara's WAR/payara wording.
 */
async function runArchonMigrationPhase(
  config: DeployConfig,
  phase: 'pre-deploy' | 'post-deploy',
  configName: string,
  ctx: CLIPluginContext,
  projectPath: string,
  opts: { dryRun?: boolean; run?: boolean },
  deps?: DeployCommandDeps,
): Promise<void> {
  const migration = phase === 'pre-deploy' ? config.migration : config.postMigration;
  await runMigrationPhase(
    migration,
    phase,
    configName,
    ctx,
    async (m, p, c) => {
      // deploy-core's CLIPluginContext structurally satisfies migration-runner's
      // narrower local CLIPluginContext (client.post + optional output.info/warn),
      // so no cast is needed — c is passed through as-is.
      const runPhase = makeArchonRunPhase(c, projectPath, deps?.runPhaseDeps);
      await runPhase(m, p, c);
    },
    (m, p) => `[deploy] [dry-run] would run ${p} schema migrations (role '${m.roleId}')`,
    {
      ...opts,
      labels: { artifact: 'build', postOnlyRecoveryHint: `archon deploy run ${configName} --post-only` },
    },
  );
}

/**
 * Register `znvault archon deploy ...` — run <configName> deploys the diffed
 * build tree to every class/host in a saved config; hashes <configName>
 * previews the diff without applying it.
 */
function registerDeployCommands(deployCmd: Command, ctx: CLIPluginContext, deps?: DeployCommandDeps): void {
  const loc = archonConfigStoreLocation();

  deployCmd
    .command('run <configName>')
    .description('Deploy the built project to all hosts in a saved archon configuration')
    .option('--dry-run', 'Show what would be deployed without deploying')
    .option('--class <name>', 'Deploy only this node class (repeatable)', collect, [] as string[])
    .option('--skip-migrations', 'Deploy without running any schema migrations')
    .option('--pre-only', 'Run only the pre-deploy migration phase, then stop (no rollout)')
    .option('--post-only', 'Run only the post-deploy migration phase, then stop — recovery')
    .option('--skip-drain', 'Deploy without draining/readying hosts on HAProxy (serving classes only)')
    .action(async (configName: string, options: {
      dryRun?: boolean;
      class: string[];
      skipMigrations?: boolean;
      preOnly?: boolean;
      postOnly?: boolean;
      skipDrain?: boolean;
    }) => {
      const config = await getConfig(loc, configName);
      if (!config) {
        ctx.output.error(`Deployment config '${configName}' not found`);
        ctx.output.info('Use "znvault archon config list" to see available configs');
        process.exit(1);
      }

      const report = validateDeployConfig(config);
      for (const w of report.warnings) ctx.output.warn(w);
      if (report.errors.length > 0) {
        for (const e of report.errors) ctx.output.error(e);
        process.exit(1);
      }

      const projectPath = config.rootDir ?? '.';
      const openTunnels: Tunnel[] = [];

      try {
        // ── no-rollout shape: --pre-only / --post-only ──
        if (options.preOnly || options.postOnly) {
          if (options.preOnly && !config.migration) {
            ctx.output.error(`--pre-only requires a pre-deploy migration config; none set on '${configName}'.`);
            process.exit(1);
          }
          if (options.postOnly && !config.postMigration) {
            ctx.output.error(`--post-only requires a post-deploy migration config; none set on '${configName}'.`);
            process.exit(1);
          }
          await runArchonMigrationPhase(config, 'pre-deploy', configName, ctx, projectPath,
            { dryRun: options.dryRun, run: !!options.preOnly }, deps);
          await runArchonMigrationPhase(config, 'post-deploy', configName, ctx, projectPath,
            { dryRun: options.dryRun, run: !!options.postOnly }, deps);
          ctx.output.success(`[deploy] migrations complete (${options.preOnly ? 'pre' : 'post'}); no rollout.`);
          return;
        }

        // ── pre-deploy migration phase (before any host is touched) ──
        await runArchonMigrationPhase(config, 'pre-deploy', configName, ctx, projectPath,
          { dryRun: options.dryRun, run: !options.skipMigrations }, deps);

        const classes: DeployClass[] = Array.isArray(config.classes) && config.classes.length > 0
          ? config.classes
          : [{ name: 'api', hosts: config.hosts ?? [] }];

        const { selected } = partitionSelectedClasses(classes, options.class.length > 0 ? options.class : undefined);
        const resolved: ResolvedClass[] = selected.map((c) => resolveClass(config, c));

        if (options.dryRun) {
          printMultiClassDryRun(resolved, resolved.map((r) => r.strategy ?? 'sequential'), ctx.isPlainMode());
          await runArchonMigrationPhase(config, 'post-deploy', configName, ctx, projectPath,
            { dryRun: true, run: !options.skipMigrations }, deps);
          return;
        }

        // ── preflight: HAProxy connectivity + coverage, once, before any class rolls ──
        // Only serving classes (haproxy present with a non-empty serverMap) are
        // checked. Skipped entirely under --skip-drain, since drain won't be
        // attempted this run.
        if (!options.skipDrain) {
          const servingClasses = resolved.filter((rc) => hasActiveServerMap(rc.haproxy));
          for (const rc of servingClasses) {
            try {
              const connResult = await testHAProxyConnectivity(rc.haproxy!);
              if (!connResult.success) {
                const failedHosts = connResult.results.filter((r) => !r.success).map((r) => `${r.host}: ${r.error}`);
                ctx.output.warn(`  [${rc.name}] HAProxy connectivity check failed: ${failedHosts.join('; ')}`);
              }
            } catch (err) {
              ctx.output.warn(`  [${rc.name}] HAProxy connectivity check failed: ${getErrorMessage(err)}`);
            }
            const unmapped = getUnmappedHosts(rc.haproxy!, rc.hosts);
            if (unmapped.length > 0) {
              ctx.output.warn(`  [${rc.name}] host(s) not mapped in haproxy.serverMap (will deploy without drain): ${unmapped.join(', ')}`);
            }
          }
        }

        const runClass = async (rc: ResolvedClass): Promise<RunClassResult> => {
          const port = rc.port ?? DEFAULT_PORT;
          const classTunnels: Tunnel[] = [];
          try {
            if (config.tunnel) {
              for (const host of rc.hosts) {
                try {
                  const t = await openTunnel(host, { user: config.ssh?.user, remotePort: port, readinessTimeoutMs: config.ssh?.readinessTimeoutMs });
                  setEndpointOverride(host, '127.0.0.1', t.localPort);
                  openTunnels.push(t);
                  classTunnels.push(t);
                } catch (err) {
                  ctx.output.warn(`  [${rc.name}] ${host}: tunnel failed (${getErrorMessage(err)})`);
                }
              }
            }

            // Deploy body for exactly one host: computes the diff plan and
            // applies it. Shared by both the serving (drain-wrapped) and
            // worker (bare) lifecycles below.
            const deployOneHost = async (host: string): Promise<DeployToHostResult> => {
              try {
                const pluginUrl = archonPluginUrl(host, port);
                const getJson = (url: string) => agentGet<RemoteHashManifest>(url);
                const { payload } = await computeDeployPlan(projectPath, rc.name, pluginUrl, getJson);
                if (payload.files.length === 0 && payload.deletions.length === 0) {
                  ctx.output.info(`  [${rc.name}] ${host}: up to date`);
                  return { success: true, result: { success: true, filesChanged: 0, filesDeleted: 0, message: 'No changes', deploymentTime: 0, appName: rc.name } };
                }
                await agentPost(`${pluginUrl}/deploy`, payload);
                ctx.output.success(`  [${rc.name}] ${host}: deployed (+${payload.files.length} -${payload.deletions.length})`);
                return {
                  success: true,
                  result: { success: true, filesChanged: payload.files.length, filesDeleted: payload.deletions.length, message: 'Deployed', deploymentTime: 0, appName: rc.name },
                };
              } catch (err) {
                const message = getErrorMessage(err);
                ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                return { success: false, error: message };
              }
            };

            const isServing = hasActiveServerMap(rc.haproxy) && !options.skipDrain;
            const failed = 0;
            let successful = 0, healthCheckFailed = 0;
            const results = new Map<string, DeployToHostResult>();

            if (isServing) {
              // ── serving class: drain → deploy → health-gate → ready (finally re-readies on failure) ──
              const lifecycle = async (host: string): Promise<DeployToHostResult> => {
                let drained = false;
                try {
                  try {
                    await drainServer(rc.haproxy!, host);
                    drained = true;
                  } catch (err) {
                    const message = `drain failed: ${getErrorMessage(err)}`;
                    ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                    return { success: false, error: message };
                  }

                  const deployResult = await deployOneHost(host);
                  if (!deployResult.success) return deployResult;

                  if (rc.healthCheck) {
                    const healthResult = await performHealthCheck(host, rc.healthCheck, (attempt, maxAttempts, status, error) => {
                      if (error) {
                        ctx.output.info(`  [${rc.name}] ${host}: health check ${attempt}/${maxAttempts}: ${error}`);
                      } else if (status !== undefined) {
                        ctx.output.info(`  [${rc.name}] ${host}: health check ${attempt}/${maxAttempts}: HTTP ${status}`);
                      }
                    });
                    if (!healthResult.success) {
                      const message = `health check failed: ${healthResult.error ?? `HTTP ${healthResult.status}`}`;
                      ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                      healthCheckFailed++;
                      return { success: false, error: message };
                    }
                  }

                  await readyServer(rc.haproxy!, host);
                  drained = false;
                  return deployResult;
                } finally {
                  if (drained) {
                    try {
                      await readyServer(rc.haproxy!, host);
                    } catch {
                      /* don't mask the original error */
                    }
                  }
                }
              };

              // deploy-vs-health failure disambiguation for reporting: a host that
              // fails its health check still lands in strategyResult.failed (its
              // lifecycle fn returned success:false), so healthCheckFailed is
              // reported as an additional (not additive-to-total) signal — the
              // §3.3 gate is `failed>0 || aborted || healthCheckFailed>0`, an OR,
              // not a partition, so double-flagging the same host is correct.
              const strategy = parseDeploymentStrategy(rc.strategy ?? 'sequential');
              const strategyResult = await executeStrategy(strategy, rc.hosts, lifecycle, { abortOnFailure: rc.blocking });
              for (const [host, r] of strategyResult.results) results.set(host, r);

              return {
                ctx: {
                  results,
                  aborted: strategyResult.aborted,
                  failedBatch: strategyResult.failedBatch,
                  skipped: strategyResult.skipped,
                  successful: strategyResult.successful,
                  failed: strategyResult.failed,
                  healthCheckFailed,
                  workerFailed: 0,
                },
                coverageOk: strategyResult.failed === 0 && !strategyResult.aborted,
              };
            }

            // ── worker class (no active haproxy, or --skip-drain): sequential, no drain ──
            // Worker failures (deploy or health) are NON-BLOCKING: recorded in
            // workerFailed, never in failed/healthCheckFailed, so they never trip
            // the multi-class blocking gate (§3.3 — gate excludes workerFailed).
            let workerFailed = 0;
            for (const host of rc.hosts) {
              const deployResult = await deployOneHost(host);
              results.set(host, deployResult);
              if (!deployResult.success) {
                workerFailed++;
                continue;
              }
              if (rc.healthCheck) {
                const healthResult = await performHealthCheck(host, rc.healthCheck, (attempt, maxAttempts, status, error) => {
                  if (error) {
                    ctx.output.info(`  [${rc.name}] ${host}: health check ${attempt}/${maxAttempts}: ${error}`);
                  } else if (status !== undefined) {
                    ctx.output.info(`  [${rc.name}] ${host}: health check ${attempt}/${maxAttempts}: HTTP ${status}`);
                  }
                });
                if (!healthResult.success) {
                  ctx.output.warn(`  [${rc.name}] ${host}: worker unhealthy (non-blocking): ${healthResult.error ?? `HTTP ${healthResult.status}`}`);
                  workerFailed++;
                  continue;
                }
              }
              successful++;
            }

            return {
              ctx: { results, aborted: false, skipped: 0, successful, failed, healthCheckFailed, workerFailed },
              coverageOk: workerFailed === 0,
            };
          } finally {
            for (const host of rc.hosts) clearEndpointOverride(host);
            await Promise.all(classTunnels.map((t) => t.close().catch(() => undefined)));
          }
        };

        const result = await executeMultiClassDeployment(resolved, runClass, ctx.output);
        printMultiClassSummary(result, ctx.isPlainMode());

        const noFailures = !result.abortedAt && result.classes.every(
          (c) => !c.ctx || (c.ctx.failed === 0 && c.ctx.healthCheckFailed === 0 && c.ctx.workerFailed === 0 && !c.ctx.aborted),
        );
        const fullCoverage = result.classes.every((c) => !c.ran || c.coverageOk === true);

        await runArchonMigrationPhase(config, 'post-deploy', configName, ctx, projectPath,
          { dryRun: false, run: !options.skipMigrations && noFailures && fullCoverage }, deps);

        if (result.abortedAt) process.exit(1);
      } finally {
        if (config.tunnel) {
          await Promise.all(openTunnels.map((t) => t.close().catch(() => undefined)));
        }
      }
    });

  deployCmd
    .command('hashes <configName>')
    .description('Preview the diff between the local build and a saved config\'s hosts (no changes applied)')
    .option('--class <name>', 'Scope to this node class', collect, [] as string[])
    .action(async (configName: string, options: { class: string[] }) => {
      const config = await getConfig(loc, configName);
      if (!config) {
        ctx.output.error(`Deployment config '${configName}' not found`);
        process.exit(1);
      }
      const projectPath = config.rootDir ?? '.';
      const classes: DeployClass[] = Array.isArray(config.classes) && config.classes.length > 0
        ? config.classes
        : [{ name: 'api', hosts: config.hosts ?? [] }];
      const { selected } = partitionSelectedClasses(classes, options.class.length > 0 ? options.class : undefined);

      for (const cls of selected) {
        const rc = resolveClass(config, cls);
        const port = rc.port ?? DEFAULT_PORT;
        for (const host of rc.hosts) {
          const pluginUrl = archonPluginUrl(host, port);
          const getJson = (url: string) => agentGet<RemoteHashManifest>(url);
          try {
            const { plan } = await computeDeployPlan(projectPath, rc.name, pluginUrl, getJson);
            ctx.output.info(`[${rc.name}] ${host}: +${plan.changed.length} changed, -${plan.deleted.length} deleted`);
          } catch (err) {
            ctx.output.error(`[${rc.name}] ${host}: ${getErrorMessage(err)}`);
          }
        }
      }
    });
}

/**
 * Register `znvault archon restart` and `znvault archon reboot`.
 * Single-host, direct-target commands (the plugin doesn't run a fleet-wide
 * rolling restart the way payara's canary rollout does — archon service
 * restarts are typically part of `deploy run`'s per-host apply, this is the
 * standalone escape hatch).
 */
function registerLifecycleCommands(archon: Command, ctx: CLIPluginContext): void {
  archon
    .command('restart')
    .description('Restart the archon service on a host')
    .requiredOption('-t, --target <host>', 'Target host')
    .option('-p, --port <port>', `Agent port (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .action(async (options: { target: string; port: string }) => {
      const pluginUrl = archonPluginUrl(options.target, Number.parseInt(options.port, 10));
      try {
        await agentPost(`${pluginUrl}/restart`, {});
        ctx.output.success(`${options.target}: archon service restarted`);
      } catch (err) {
        ctx.output.error(`Restart failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  archon
    .command('reboot')
    .description('Reboot a host running archon (guarded: refuses if a deploy is in progress)')
    .requiredOption('-t, --target <host>', 'Target host')
    .requiredOption('--confirm <hostname>', 'Must exactly match the target host\'s own hostname (safety confirmation)')
    .option('-p, --port <port>', `Agent port (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .action(async (options: { target: string; confirm: string; port: string }) => {
      const pluginUrl = archonPluginUrl(options.target, Number.parseInt(options.port, 10));
      try {
        await agentPost(`${pluginUrl}/reboot`, { confirm: options.confirm });
        ctx.output.success(`${options.target}: reboot accepted`);
      } catch (err) {
        ctx.output.error(`Reboot refused or failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * Register `znvault archon quiesce` — quiesce / resume / status against a
 * single host's in-app scheduler-drain endpoints, proxied through the agent's
 * /plugins/archon/quiesce* routes (see src/routes/quiesce.ts). Degrades to a
 * no-op 200 on older Archon builds without the endpoints — this command just
 * surfaces whatever the agent reports.
 */
function registerQuiesceCommands(quiesceCmd: Command, ctx: CLIPluginContext): void {
  quiesceCmd
    .command('start')
    .description('Quiesce the scheduler on a host before a manual deploy')
    .requiredOption('-t, --target <host>', 'Target host')
    .option('-p, --port <port>', `Agent port (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .action(async (options: { target: string; port: string }) => {
      const pluginUrl = archonPluginUrl(options.target, Number.parseInt(options.port, 10));
      try {
        const body = await agentPost<{ status?: string; reason?: string; inFlightUnits?: number }>(`${pluginUrl}/quiesce`, {});
        if (body.status === 'noop') {
          ctx.output.warn(`${options.target}: quiesce not available (${body.reason})`);
        } else {
          ctx.output.success(`${options.target}: quiesced (in-flight: ${body.inFlightUnits ?? 'unknown'})`);
        }
      } catch (err) {
        ctx.output.error(`Quiesce failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  quiesceCmd
    .command('resume')
    .description('Resume the scheduler on a host after a manual deploy')
    .requiredOption('-t, --target <host>', 'Target host')
    .option('-p, --port <port>', `Agent port (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .action(async (options: { target: string; port: string }) => {
      const pluginUrl = archonPluginUrl(options.target, Number.parseInt(options.port, 10));
      try {
        await agentPost(`${pluginUrl}/resume`, {});
        ctx.output.success(`${options.target}: resumed`);
      } catch (err) {
        ctx.output.error(`Resume failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  quiesceCmd
    .command('status')
    .description('Check scheduler quiesce status on a host')
    .requiredOption('-t, --target <host>', 'Target host')
    .option('-p, --port <port>', `Agent port (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .action(async (options: { target: string; port: string }) => {
      const pluginUrl = archonPluginUrl(options.target, Number.parseInt(options.port, 10));
      try {
        const body = await agentGet<{ status?: string; quiesced?: boolean; inFlightUnits?: number; reason?: string }>(`${pluginUrl}/quiesce/status`);
        if (body.status === 'noop') {
          ctx.output.warn(`${options.target}: status not available (${body.reason})`);
        } else {
          ctx.output.keyValue({ quiesced: body.quiesced ?? false, inFlightUnits: body.inFlightUnits ?? 'unknown' });
        }
      } catch (err) {
        ctx.output.error(`Status check failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/** Collector for repeatable --class options. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value.trim()]);
}

// Re-exported so a future preflight-checks caller (not part of Task 6's
// scope) can reach checkHostReachable pre-namespaced to 'archon' without
// re-threading the pluginNamespace argument itself.
export function archonCheckHostReachable(host: string, port: number) {
  return checkHostReachable(host, port, undefined, false, PLUGIN_NAMESPACE);
}

/**
 * Register all `znvault archon ...` command groups on the given `archon`
 * top-level command. Called from src/cli.ts's registerCommands.
 */
export function registerArchonCommands(archon: Command, ctx: CLIPluginContext, deps?: DeployCommandDeps): void {
  const deployCmd = archon.command('deploy').description('Deploy built project output to archon hosts');
  registerDeployCommands(deployCmd, ctx, deps);

  const configCmd = archon.command('config').description('Manage archon deployment configurations');
  registerConfigCommands(configCmd, ctx);

  registerLifecycleCommands(archon, ctx);

  const quiesceCmd = archon.command('quiesce').description('Quiesce/resume/status the scheduler on an archon host before/after a manual deploy');
  registerQuiesceCommands(quiesceCmd, ctx);
}

export type { CLIPlugin };
