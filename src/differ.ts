import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
  appRoot: string, input: DiffInput, owner: { uid: number; gid: number },
): Promise<{ written: number; deleted: number }> {
  let written = 0, deleted = 0;
  for (const f of input.files) {
    const abs = join(appRoot, f.path);
    if (relative(appRoot, abs).startsWith('..')) throw new Error(`path escapes appRoot: ${f.path}`);
    // Reject a symlink at ANY existing segment BEFORE mkdir -p can traverse
    // through it (see assertNoSymlinkInChain). Covers the immediate parent and
    // the leaf target too.
    await assertNoSymlinkInChain(appRoot, f.path);
    const parentDir = join(abs, '..');
    await fs.mkdir(parentDir, { recursive: true });
    // Re-check the leaf after mkdir: the parent now exists as a real dir, and
    // the leaf may have been created by a concurrent path — cheap belt-and-braces.
    await assertNotSymlink(abs, f.path);
    await fs.writeFile(abs, Buffer.from(f.content, 'base64'));
    await fs.chown(abs, owner.uid, owner.gid).catch(() => {});
    written++;
  }
  for (const d of input.deletions) {
    const abs = join(appRoot, d);
    if (relative(appRoot, abs).startsWith('..')) throw new Error(`path escapes appRoot: ${d}`);
    await fs.rm(abs, { force: true }); deleted++;
  }
  return { written, deleted };
}
