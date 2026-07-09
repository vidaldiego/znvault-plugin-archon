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
export async function applyDiff(
  appRoot: string, input: DiffInput, owner: { uid: number; gid: number },
): Promise<{ written: number; deleted: number }> {
  let written = 0, deleted = 0;
  for (const f of input.files) {
    const abs = join(appRoot, f.path);
    if (relative(appRoot, abs).startsWith('..')) throw new Error(`path escapes appRoot: ${f.path}`);
    await fs.mkdir(join(abs, '..'), { recursive: true });
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
