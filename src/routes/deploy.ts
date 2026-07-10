// Deploy routes — applies a file diff (see src/differ.ts) inside a
// deployment-journal window (see src/deployment-journal.ts), then runs the
// minimal post-apply commands the change warrants:
//   - `sudo -u archon npm ci --omit=dev --ignore-scripts` iff package-lock.json changed
//   - `sudo -u archon npx prisma generate`               iff prisma/** or the lockfile changed
//
// The journal is opened BEFORE differ.apply runs and only closed after the
// whole apply-plus-post-apply sequence succeeds. This is the crash-recovery
// invariant Task 5 is scoped to: if the process dies mid-deploy (OOM, power
// loss, SIGKILL), the journal is left open on disk, and POST /reboot refuses
// to fire until an operator (or a subsequent successful /deploy) clears it —
// a partially-applied file tree must never be rebooted into blind.
//
// A deploy already in flight (journal open) refuses a concurrent /deploy
// with 409, mirroring payara's checkDeploymentInProgress.

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';
import { SessionStore, type ChunkFile } from '../session-store.js';

interface DeployFile { path: string; content: string; }
interface DeployBody { files?: DeployFile[]; deletions?: string[]; }
interface ChunkBody {
  sessionId?: string;
  files?: DeployFile[];
  deletions?: string[];
  expectedFiles?: number;
  commit?: boolean;
}


function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function validateDeployBody(body: DeployBody, reply: import('fastify').FastifyReply): boolean {
  if (!isArray(body.files)) {
    reply.code(400).send({ error: 'Invalid request', message: 'files must be an array' });
    return true;
  }
  if (!isArray(body.deletions)) {
    reply.code(400).send({ error: 'Invalid request', message: 'deletions must be an array' });
    return true;
  }
  return false;
}

function needsNpmCi(files: DeployFile[]): boolean {
  return files.some((f) => f.path === 'package-lock.json');
}

function needsPrismaGenerate(files: DeployFile[]): boolean {
  return files.some((f) => f.path === 'package-lock.json' || f.path.startsWith('prisma/'));
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

/**
 * Run the post-apply commands a diff warrants (npm ci, prisma generate),
 * journaling failures as part of the same open checkpoint. Throws on
 * non-zero exit so the caller's deploy handler surfaces a 500 with the
 * journal left OPEN — the tree is in a state that needs operator attention,
 * not something a route should silently swallow.
 */
async function runPostApply(cfg: RouteContext['cfg'], files: DeployFile[]): Promise<{ ranNpmCi: boolean; ranPrismaGenerate: boolean }> {
  let ranNpmCi = false;
  let ranPrismaGenerate = false;

  if (needsNpmCi(files)) {
    const r = await runCommand('sudo', ['-u', cfg.user, 'npm', 'ci', '--omit=dev', '--ignore-scripts'], cfg.appRoot);
    if (r.code !== 0) throw new Error(`npm ci failed: ${r.stderr || r.code}`);
    ranNpmCi = true;
  }
  if (needsPrismaGenerate(files)) {
    const r = await runCommand('sudo', ['-u', cfg.user, 'npx', 'prisma', 'generate'], cfg.appRoot);
    if (r.code !== 0) throw new Error(`prisma generate failed: ${r.stderr || r.code}`);
    ranPrismaGenerate = true;
  }
  return { ranNpmCi, ranPrismaGenerate };
}

/**
 * Apply a diff within a journal window: open → differ.apply → post-apply → close.
 * On any failure, the journal is deliberately left open (not closed in a
 * finally) — that's the crash-recovery signal for POST /reboot and for
 * operators inspecting journal.peek() via GET /deploy/status.
 */
async function applyWithJournal(
  ctx: RouteContext,
  files: DeployFile[],
  deletions: string[],
): Promise<{ written: number; deleted: number; ranNpmCi: boolean; ranPrismaGenerate: boolean }> {
  const { differ, journal, cfg } = ctx;
  const deploymentId = randomUUID();
  journal.open?.({ deploymentId, filesChanged: files.length, filesDeleted: deletions.length });

  // File writes/deletes run as cfg.user via sudo inside differ.apply (the app
  // tree is owned by that user, not the agent) — no uid/gid resolution needed.
  const applyResult = await differ.apply({ files, deletions });
  const postApply = await runPostApply(cfg, files);

  journal.close?.();
  return { ...applyResult, ...postApply };
}

export async function registerDeployRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { journal, logger } = ctx;
  const sessionStore = new SessionStore(logger, { maxSessions: 10, timeoutMs: 30 * 60 * 1000 });

  // 500MB octet-stream body parser — parity with payara's WAR upload limit,
  // even though archon's diffs are file-content JSON today (kept for a
  // future raw-binary upload path without another route-file churn).
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 },
    (_request, payload, done) => done(null, payload),
  );

  fastify.post<{ Body: DeployBody }>('/deploy', async (request, reply) => {
    const body = request.body ?? {};
    if (validateDeployBody(body, reply)) return;

    if (journal.isOpen()) {
      return reply.code(409).send({ error: 'Deployment in progress', message: 'A deployment journal is already open' });
    }

    try {
      const files = body.files!;
      const deletions = body.deletions!;
      logger.info({ filesChanged: files.length, filesDeleted: deletions.length }, 'Starting deploy');
      const result = await applyWithJournal(ctx, files, deletions);
      return { status: 'deployed', completedAt: Date.now(), ...result };
    } catch (err) {
      logger.error({ err }, 'Deploy failed');
      return reply.code(500).send({ error: 'Deploy failed', message: getErrorMessage(err), completedAt: Date.now() });
    }
  });

  // POST /deploy/full — same apply path with an empty deletions list and
  // "everything is a change" left to the caller (the CLI is expected to
  // send the full managed-file set as `files` when it wants a full deploy;
  // this route exists so the CLI has a distinct entrypoint to call without
  // computing a diff against remote hashes first).
  fastify.post<{ Body: DeployBody }>('/deploy/full', async (request, reply) => {
    const body = request.body ?? {};
    if (validateDeployBody(body, reply)) return;

    if (journal.isOpen()) {
      return reply.code(409).send({ error: 'Deployment in progress', message: 'A deployment journal is already open' });
    }

    try {
      const files = body.files!;
      const deletions = body.deletions!;
      logger.info({ filesChanged: files.length, filesDeleted: deletions.length }, 'Starting full deploy');
      const result = await applyWithJournal(ctx, files, deletions);
      return { status: 'deployed', completedAt: Date.now(), ...result };
    } catch (err) {
      logger.error({ err }, 'Full deploy failed');
      return reply.code(500).send({ error: 'Deploy failed', message: getErrorMessage(err), completedAt: Date.now() });
    }
  });

  fastify.post<{ Body: ChunkBody }>('/deploy/chunk', async (request, reply) => {
    const { sessionId, files, deletions, expectedFiles, commit } = request.body ?? {};
    if (!isArray(files)) {
      return reply.code(400).send({ error: 'Invalid request', message: 'files must be an array' });
    }

    let session;
    if (sessionId) {
      session = sessionStore.get(sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found', message: `Session ${sessionId} not found or expired` });
      }
      sessionStore.addFiles(sessionId, files as ChunkFile[]);
    } else {
      session = sessionStore.create(deletions ?? [], expectedFiles);
      sessionStore.addFiles(session.id, files as ChunkFile[]);
    }
    session = sessionStore.get(session.id)!;

    const response: { sessionId: string; filesReceived: number; committed: boolean; completedAt?: number; result?: unknown } = {
      sessionId: session.id,
      filesReceived: session.files.length,
      committed: false,
    };

    if (commit) {
      if (journal.isOpen()) {
        return reply.code(409).send({ error: 'Deployment in progress', message: 'A deployment journal is already open' });
      }
      try {
        logger.info({ sessionId: session.id, filesChanged: session.files.length, filesDeleted: session.deletions.length }, 'Committing chunked deploy');
        const result = await applyWithJournal(ctx, session.files, session.deletions);
        sessionStore.delete(session.id);
        response.committed = true;
        response.completedAt = Date.now();
        response.result = result;
      } catch (err) {
        sessionStore.delete(session.id);
        logger.error({ err, sessionId: session.id }, 'Chunked deploy failed');
        return reply.code(500).send({ error: 'Deploy failed', message: getErrorMessage(err), completedAt: Date.now() });
      }
    }

    return response;
  });

  fastify.get('/deploy/status', async (_request, reply) => {
    try {
      const checkpoint = journal.peek?.() ?? null;
      return {
        deploying: journal.isOpen(),
        checkpoint,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get deploy status');
      return reply.code(500).send({ error: 'Failed to get deploy status', message: getErrorMessage(err) });
    }
  });
}
