import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
});
