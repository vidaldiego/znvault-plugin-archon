import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashManagedFiles, applyDiff } from '../src/differ.js';

describe('hashManagedFiles', () => {
  it('hashes dist files and excludes .map, is stable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-diff-'));
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'a.js'), 'console.log(1)');
    await writeFile(join(root, 'dist', 'a.js.map'), '{"x":1}');
    const m = await hashManagedFiles(root);
    const dist = m['dist'] ?? [];
    expect(dist.find((f) => f.path === 'dist/a.js')).toBeTruthy();
    expect(dist.find((f) => f.path.endsWith('.map'))).toBeUndefined();
    // stable: same content → same hash
    const m2 = await hashManagedFiles(root);
    expect(m2['dist'][0].sha256).toBe(m['dist'][0].sha256);
    await rm(root, { recursive: true, force: true });
  });
});

describe('applyDiff — path-traversal guard', () => {
  const owner = { uid: 0, gid: 0 };

  it('throws on a files[].path that escapes appRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-diff-'));
    await expect(
      applyDiff(
        root,
        { files: [{ path: '../../etc/passwd', content: Buffer.from('pwned').toString('base64') }], deletions: [] },
        owner,
      ),
    ).rejects.toThrow(/path escapes appRoot/);
    await rm(root, { recursive: true, force: true });
  });

  it('throws on a deletions entry that escapes appRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-diff-'));
    await expect(
      applyDiff(root, { files: [], deletions: ['../../etc/passwd'] }, owner),
    ).rejects.toThrow(/path escapes appRoot/);
    await rm(root, { recursive: true, force: true });
  });

  it('throws when a pre-planted symlink inside appRoot points outside it (write-loop TOCTOU)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-diff-'));
    const outside = await mkdtemp(join(tmpdir(), 'archon-outside-'));
    await mkdir(join(root, 'dist'), { recursive: true });
    // Plant a symlink INSIDE appRoot (dist/evil.js) pointing OUTSIDE it.
    // The string-based path-escape guard passes (dist/evil.js resolves
    // inside appRoot); a naive fs.writeFile would follow the link and
    // write through to `outside`.
    await symlink(join(outside, 'pwned.js'), join(root, 'dist', 'evil.js'));

    await expect(
      applyDiff(
        root,
        { files: [{ path: 'dist/evil.js', content: Buffer.from('pwned').toString('base64') }], deletions: [] },
        owner,
      ),
    ).rejects.toThrow(/symlink/i);

    // Prove nothing was actually written through the link.
    await expect(readFile(join(outside, 'pwned.js'), 'utf-8')).rejects.toThrow();

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('throws when a symlinked directory sits in place of the target parent dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-diff-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'archon-outside-dir-'));
    // dist is itself a symlink to a directory outside appRoot.
    await symlink(outsideDir, join(root, 'dist'));

    await expect(
      applyDiff(
        root,
        { files: [{ path: 'dist/evil.js', content: Buffer.from('pwned').toString('base64') }], deletions: [] },
        owner,
      ),
    ).rejects.toThrow(/symlink/i);

    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('throws when an INTERMEDIATE segment (not the immediate parent) is a symlink escaping appRoot', async () => {
    // Reviewer-demonstrated escape: `dist` is a symlink to an outside dir, and
    // we write `dist/sub/evil.js`. The IMMEDIATE parent (`dist/sub`) would be
    // freshly mkdir'd (a real dir, passing an immediate-parent-only check), but
    // `mkdir -p dist/sub` traverses THROUGH the `dist` symlink → the write would
    // land outside appRoot. The chain walk must reject the `dist` segment first.
    const root = await mkdtemp(join(tmpdir(), 'archon-diff-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'archon-outside-dir-'));
    await symlink(outsideDir, join(root, 'dist'));

    await expect(
      applyDiff(
        root,
        { files: [{ path: 'dist/sub/evil.js', content: Buffer.from('pwned').toString('base64') }], deletions: [] },
        owner,
      ),
    ).rejects.toThrow(/symlink/i);

    // And nothing was written into the outside target.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(outsideDir)).toEqual([]);

    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });
});
