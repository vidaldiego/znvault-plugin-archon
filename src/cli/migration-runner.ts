import { spawn as nodeSpawn } from 'node:child_process';
import { makeDynamicSecretsClient, type Lease } from '@zincapp/znvault-migrate';
import { makeVaultHttpAdapter, makeRevokeOnce, withTimeout, REVOKE_SETTLE_MS } from '../utils/vault-http.js';

/**
 * Prisma migration runner over a reused zn-vault dynamic-secrets lease.
 *
 * Archon injects its own Prisma runner here — it does NOT go through
 * znvault-migrate's `runMigrations`/`MigrationRunner` file-discovery engine.
 * That engine plans/tracks migrations itself (checksum table, baseline
 * markers); Archon already owns that via `prisma migrate deploy` and its own
 * `_prisma_migrations` table, so only the lease lifecycle (mint → spawn →
 * revoke) is reused, via `makeDynamicSecretsClient`.
 */

const LEASE_TTL_SECONDS = 14400; // 4h — generous ceiling for a migrate deploy; revoked immediately after anyway.
const CREDENTIAL_PROBE_TTL_SECONDS = 300;
const ARCHON_SESSION_ROLE = 'archon';
const STRICT_REVOKE_DELAYS_MS = [200, 600];

/**
 * Build the direct (non-pooled) Postgres URL for an ephemeral lease.
 *
 * Lease username/password come back from Vault and may contain
 * URL-reserved bytes (Vault dynamic-secrets usernames often embed `/`,
 * e.g. `v-migrate-x/y`; generated passwords can contain `@`, `:`, `#`, ...).
 * Both MUST be percent-encoded or the URL parses incorrectly (or the
 * connection targets the wrong host/db). `sslmode=require` is pinned —
 * archon's Postgres (Patroni HA) is never reachable insecurely from a
 * migration runner. Uses the lease's own host:port (the direct :5432
 * endpoint Vault's dynamic-secrets connection resolves to), not a pooled
 * proxy — `prisma migrate deploy` needs a direct connection for advisory
 * locks / DDL.
 */
export function composeEphemeralUrl(lease: Lease, dbOverride?: string): string {
  const db = lease.database ?? dbOverride;
  if (!db) throw new Error('no database name on lease and no override provided');
  const u = encodeURIComponent(lease.username);
  const p = encodeURIComponent(lease.password);
  const database = encodeURIComponent(db);
  const options = encodeURIComponent(`-c role=${ARCHON_SESSION_ROLE}`);
  return `postgresql://${u}:${p}@${lease.host}:${lease.port}/${database}?sslmode=require&options=${options}`;
}

export interface RunnerDeps {
  client: {
    issueCredential(roleId: string, o: { ttlSeconds: number }): Promise<Lease>;
    revokeCredential(leaseId: string, o: { reason: string }): Promise<void>;
  };
  spawn: typeof nodeSpawn;
  settleMs: number;
  dbOverride?: string;
}

export interface CLIPluginContext {
  client: { post<T>(p: string, b: unknown): Promise<T> };
  output?: { info?: (m: string) => void; warn?: (m: string) => void };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function revokeCredentialStrict(
  client: RunnerDeps['client'],
  leaseId: string,
): Promise<void> {
  let lastError: unknown;
  const attempts = 1 + STRICT_REVOKE_DELAYS_MS.length;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await client.revokeCredential(leaseId, { reason: 'archon migration credential preflight' });
      return;
    } catch (error) {
      lastError = error;
      const delay = STRICT_REVOKE_DELAYS_MS[attempt];
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`credential preflight revocation failed: ${errorMessage(lastError)}`);
}

/**
 * Exercise the production migration role's complete target-side lifecycle
 * without running Prisma or printing the returned credential. This is a
 * deliberately mutating but self-cleaning pre-tag probe: Vault creates the
 * ephemeral PostgreSQL role, this process validates the lease coordinates,
 * and strict revocation must succeed before the command returns green.
 */
export async function probeArchonMigrationCredential(
  ctx: CLIPluginContext,
  roleId: string,
  deps?: { client?: RunnerDeps['client'] },
): Promise<void> {
  const client = deps?.client ?? makeDynamicSecretsClient(makeVaultHttpAdapter(ctx.client));
  const lease = await client.issueCredential(roleId, { ttlSeconds: CREDENTIAL_PROBE_TTL_SECONDS });
  let validationError: unknown;

  try {
    // Build the exact URL shape used by Prisma. Never return or log it: it
    // contains the short-lived password.
    composeEphemeralUrl(lease);
  } catch (error) {
    validationError = error;
  }

  // A green preflight requires proven cleanup. Revocation errors therefore
  // fail closed instead of using the migration runner's best-effort teardown.
  await revokeCredentialStrict(client, lease.leaseId);
  if (validationError !== undefined) throw validationError;
}

export type RunPhaseFn = (
  migration: { roleId: string; database?: string },
  phase: string,
  ctx: unknown,
) => Promise<void>;

/**
 * Build a deploy-core `RunPhaseFn` that mints a short-lived dynamic-secrets
 * lease scoped to `migration.roleId`, runs `npx prisma migrate deploy`
 * against it, and revokes the lease once the child has fully exited.
 *
 * Teardown ordering is load-bearing: the lease must stay valid for the
 * entire lifetime of the `prisma migrate deploy` child process, and must
 * be revoked only after that process has terminated (never while the
 * connection could still be in use). This is enforced by structure, not
 * by a check: the `spawn` promise resolves/rejects only from the child's
 * `close`/`error` events (which fire after the OS process has ended), and
 * the settle-then-revoke sequence lives in a `finally` wrapped around
 * that promise — so it can only run once the child promise has settled.
 *
 * On SIGINT/SIGTERM, the signal handler kills the child (not the lease);
 * the awaited spawn promise then settles via the child's own `close`
 * event, and the same `finally` performs settle+revoke. This guarantees
 * revoke-after-exit on both the happy path and the interrupted path.
 */
export function makeArchonRunPhase(
  ctx: CLIPluginContext,
  projectPath: string,
  deps?: Partial<RunnerDeps>,
): RunPhaseFn {
  return async function runPhase(migration, phase): Promise<void> {
    const client = deps?.client ?? makeDynamicSecretsClient(makeVaultHttpAdapter(ctx.client));
    const spawn = deps?.spawn ?? nodeSpawn;
    const settleMs = deps?.settleMs ?? REVOKE_SETTLE_MS;
    const log = (m: string) => ctx.output?.warn?.(m);

    const lease = await client.issueCredential(migration.roleId, { ttlSeconds: LEASE_TTL_SECONDS });
    // Never log lease.username/password — only the lease id, which is not a credential.
    ctx.output?.info?.(`[archon] ${phase} lease ${lease.leaseId} (TTL ${LEASE_TTL_SECONDS}s)`);
    const revokeOnce = makeRevokeOnce(
      () => client.revokeCredential(lease.leaseId, { reason: 'migration complete' }),
      log,
    );

    const url = composeEphemeralUrl(lease, migration.database ?? deps?.dbOverride);
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const onSignal = () => {
      if (child && !child.killed) child.kill('SIGTERM');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
      await new Promise<void>((resolve, reject) => {
        child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
          cwd: projectPath,
          env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`prisma migrate deploy exited ${code}`))));
      });
    } finally {
      // The awaited promise above only settles after the child's 'close'/'error'
      // event, i.e. after the OS process has ended. Everything in this `finally`
      // therefore runs strictly after child exit — settle, then revoke.
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      await withTimeout(revokeOnce(), 5000);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  };
}
