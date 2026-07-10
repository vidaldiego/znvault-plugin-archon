import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

interface FileHash { path: string; sha256: string; }
export interface HashManifest { [set: string]: FileHash[]; }

const SETS: { key: string; dir: string; skip?: (p: string) => boolean }[] = [
  { key: 'dist', dir: 'dist', skip: (p) => p.endsWith('.map') },
  { key: 'prisma', dir: 'prisma' },              // schema.prisma + migrations/
  { key: 'archon-crypt', dir: 'scripts/archon-crypt/dist' },
];
const ROOT_FILES = ['package.json', 'package-lock.json'];

async function walk(base: string, dir: string, skip?: (p: string) => boolean): Promise<FileHash[]> {
  const out: FileHash[] = [];
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(join(base, dir), { withFileTypes: true }); }
  catch { return out; } // set absent on this node = empty
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(base, rel, skip));
    else {
      const posix = rel.split(sep).join('/');
      if (skip?.(posix)) continue;
      const buf = await fs.readFile(join(base, rel));
      out.push({ path: posix, sha256: createHash('sha256').update(buf).digest('hex') });
    }
  }
  return out;
}

export async function hashManagedFiles(appRoot: string): Promise<HashManifest> {
  const m: HashManifest = {};
  for (const s of SETS) m[s.key] = await walk(appRoot, s.dir, s.skip);
  // dist/public split out so the CLI can ship it only to the api class
  const distFiles = m['dist'] ?? [];
  m['dist/public'] = distFiles.filter((f) => f.path.startsWith('dist/public/'));
  m['dist'] = distFiles.filter((f) => !f.path.startsWith('dist/public/'));
  m['root'] = [];
  for (const rf of ROOT_FILES) {
    try { const buf = await fs.readFile(join(appRoot, rf)); m['root'].push({ path: rf, sha256: createHash('sha256').update(buf).digest('hex') }); }
    catch { /* absent */ }
  }
  return m;
}

export interface DiffInput { files: { path: string; content: string }[]; deletions: string[]; }

/**
 * The mutating side of applyDiff, abstracted so the write/delete can run either
 * directly (agent owns the tree — tests, or an agent-writable appRoot) or via
 * `sudo -u <appUser>` (the production case: /opt/archon is owned by `archon`,
 * not the agent user, so a direct fs.writeFile hits EACCES). The symlink guards
 * in applyDiff are read-only and always run as the agent BEFORE these ops.
 */
export interface FileOps {
  /**
   * Write `content` to `abs`, owned by the app user, creating parents as needed.
   * `relPath` (relative to appRoot) lets the sudo impl create each parent
   * segment individually with a symlink guard — it must NOT create parents by
   * following an existing symlink at any segment.
   */
  writeFile(appRoot: string, relPath: string, abs: string, content: Buffer): Promise<void>;
  /** Remove `abs` if present (no error if absent). */
  remove(abs: string): Promise<void>;
}

export interface RunResult { code: number; stdout: string; stderr: string; }
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

/**
 * Direct fs ops (default). Writes as the current process user and best-effort
 * chowns to `owner`; a chown failure is non-fatal (matches the original
 * behavior). Correct only when the process can write appRoot (tests, or an
 * agent-owned tree).
 */
export function makeDirectFileOps(owner: { uid: number; gid: number }): FileOps {
  return {
    async writeFile(_appRoot, _relPath, abs, content) {
      await fs.mkdir(join(abs, '..'), { recursive: true });
      await fs.writeFile(abs, content);
      await fs.chown(abs, owner.uid, owner.gid).catch(() => {});
    },
    async remove(abs) {
      await fs.rm(abs, { force: true });
    },
  };
}

/**
 * Sudo ops (production): the app tree (/opt/archon) is owned by `user`
 * (`archon`), not the agent, so a direct write EACCESes. Every mutation runs
 * through `sudo` AS ROOT — NOT `sudo -u archon` — for two reasons the review
 * of this file surfaced:
 *
 *  1. Read access to the staged temp file. The agent stages content into a
 *     temp file it owns; `sudo -u archon install <tmp>` cannot READ an
 *     agent-owned file (any mode) — different user, and 0644 still leaks it to
 *     the world. Running install as root reads the temp file fine and
 *     `-o <user> -g <user>` sets the final ownership to the app user.
 *
 *  2. Symlink safety of parent creation. `install -D` (and `mkdir -p`) TRAVERSE
 *     an existing symlink at any intermediate segment, so a symlink planted in
 *     the window after applyDiff's guard could redirect the write outside
 *     appRoot — and the mutation runs privileged. So parents are created here
 *     segment-by-segment with a per-segment symlink guard (`test ! -L` +
 *     `mkdir` one level, never `mkdir -p`), then the file is placed with
 *     `install -T` (no target-dir/parent creation). A symlink at any segment
 *     makes the guard command fail → the write throws before install runs.
 *
 * `run` is injected (spawns in prod, mocked in tests). Any non-zero exit throws
 * so the deploy fails loudly (journal left open) rather than skipping a file.
 */
export function makeSudoFileOps(user: string, run: RunFn): FileOps {
  const check = async (r: RunResult, what: string): Promise<void> => {
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim() || 'unknown error'}`);
  };
  return {
    async writeFile(appRoot, relPath, abs, content) {
      // 1. Create each parent segment individually, guarding every segment
      //    against a symlink BEFORE creating the next — never `mkdir -p`, which
      //    would traverse a symlinked segment. Runs as root; dirs owned by user.
      const segments = relPath.split(/[/\\]+/).filter((s) => s.length > 0);
      segments.pop(); // drop the leaf file; we only create its ancestor dirs
      let current = appRoot;
      for (const seg of segments) {
        current = join(current, seg);
        // Refuse if this segment already exists AS A SYMLINK; else create it as
        // a real dir owned by the app user. `install -d` is idempotent for an
        // existing real dir and creates it (mode 0755) if absent.
        await check(await run('sudo', ['test', '!', '-L', current]), `symlink-guard ${current}`);
        await check(await run('sudo', ['install', '-d', '-o', user, '-g', user, '-m', '755', current]), `mkdir ${current}`);
      }
      // 2. Stage content into an agent-owned temp file (0644 so nothing sensitive
      //    lingers world-readable is moot — content is public build output — but
      //    root reads it regardless), then install it to the exact target with
      //    -T (no parent creation) and app-user ownership.
      const tmp = join(tmpdir(), `archon-deploy-${process.pid}-${stagingId()}`);
      await fs.writeFile(tmp, content, { mode: 0o644 });
      try {
        await check(
          await run('sudo', ['install', '-T', '-o', user, '-g', user, '-m', '644', tmp, abs]),
          `install ${abs}`,
        );
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    },
    async remove(abs) {
      await check(await run('sudo', ['rm', '-f', abs]), `rm ${abs}`);
    },
  };
}

// Per-file staging-path suffix. Uses randomUUID (collision-free even under a
// hypothetical concurrent caller) plus a monotonic counter for readability.
let stagingCounter = 0;
function stagingId(): string {
  stagingCounter += 1;
  return `${stagingCounter}-${randomUUID()}`;
}

/**
 * Refuse to write through a symlink.
 *
 * The path-escape guard above (`relative(appRoot, abs).startsWith('..')`)
 * only checks the *string* path — it does not protect against a symlink
 * planted INSIDE appRoot that points OUTSIDE it (e.g. `dist/evil ->
 * /etc/passwd`). Such a symlink resolves to a path inside appRoot under the
 * string check, but `fs.writeFile` follows it and writes through to the
 * external target. Since `/deploy` exposes this function to network input
 * (a compromised or buggy CLI client, or a MITM'd tunnel), harden the write
 * path: before writing, `lstat` the target's parent directory (and the
 * target itself, if it already exists) and refuse if either is a symlink.
 * Deletion uses `fs.rm(force: true)`, which does not follow symlinks into
 * their targets (it removes the link itself), so the delete loop is not
 * subject to the same class of attack and is left as-is.
 */
async function assertNotSymlink(path: string, label: string): Promise<void> {
  let st;
  try {
    st = await fs.lstat(path);
  } catch {
    return; // doesn't exist yet — nothing to guard against
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${label}`);
  }
}

/**
 * Reject if ANY existing path segment between appRoot (exclusive) and the
 * leaf target (inclusive) is a symlink. Checking only the immediate parent is
 * insufficient: `fs.mkdir(parent, {recursive:true})` follows a pre-existing
 * symlink at any intermediate segment (Node's `mkdir -p` traverses through
 * an existing symlinked dir), so a symlink like `appRoot/dist -> /outside`
 * would let a write to `dist/sub/x` land outside appRoot while the immediate
 * parent (`dist/sub`, freshly mkdir'd, hence a real dir) passes the check.
 * Walking every segment BEFORE the mkdir closes that gap.
 */
async function assertNoSymlinkInChain(appRoot: string, relPath: string): Promise<void> {
  const segments = relPath.split(/[/\\]+/).filter((s) => s.length > 0);
  let current = appRoot;
  for (const seg of segments) {
    current = join(current, seg);
    await assertNotSymlink(current, relPath);
  }
}

export async function applyDiff(
  appRoot: string, input: DiffInput, ops: FileOps,
): Promise<{ written: number; deleted: number }> {
  let written = 0, deleted = 0;
  for (const f of input.files) {
    const abs = join(appRoot, f.path);
    if (relative(appRoot, abs).startsWith('..')) throw new Error(`path escapes appRoot: ${f.path}`);
    // Reject a symlink at ANY existing segment BEFORE any mutation can traverse
    // through it (see assertNoSymlinkInChain). Covers the immediate parent and
    // the leaf target too. These lstat checks are read-only and run as the agent
    // regardless of how `ops` performs the write — so a symlink can never be
    // followed even when the privileged (sudo) write would otherwise honor it.
    await assertNoSymlinkInChain(appRoot, f.path);
    await assertNotSymlink(abs, f.path);
    await ops.writeFile(appRoot, f.path, abs, Buffer.from(f.content, 'base64'));
    written++;
  }
  for (const d of input.deletions) {
    const abs = join(appRoot, d);
    if (relative(appRoot, abs).startsWith('..')) throw new Error(`path escapes appRoot: ${d}`);
    await ops.remove(abs); deleted++;
  }
  return { written, deleted };
}
