import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDiff, makeSudoFileOps } from '../src/differ.js';

// The production write path runs mutations as ROOT via sudo (NOT `sudo -u
// archon`), because: (1) root can read the agent-owned staged temp file that
// `sudo -u archon` could not, and (2) parents are created segment-by-segment
// with a per-segment symlink guard (`sudo test ! -L`), never `mkdir -p` /
// `install -D` which traverse a symlinked segment. Final ownership is set via
// `install -o archon -g archon`. These tests pin that argv and that the guards
// run before any mutation.

const ok = { code: 0, stdout: '', stderr: '' };

describe('applyDiff with sudo (root) file ops', () => {
  it('creates each parent as root with a per-segment symlink guard, then installs the file with app-user ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ad-sudo-'));
    const run = vi.fn().mockResolvedValue(ok);
    const ops = makeSudoFileOps('archon', run);

    const res = await applyDiff(
      root,
      { files: [{ path: 'dist/src/app.module.js', content: Buffer.from('X').toString('base64') }], deletions: [] },
      ops,
    );
    expect(res.written).toBe(1);

    const calls = run.mock.calls.map(([cmd, args]) => [cmd, ...(args as string[])].join(' '));
    // symlink guard for each parent segment (dist, dist/src) via `sudo test ! -L <seg>`
    expect(calls.some((c) => c.startsWith('sudo test ! -L ') && c.endsWith(join(root, 'dist')))).toBe(true);
    expect(calls.some((c) => c.startsWith('sudo test ! -L ') && c.endsWith(join(root, 'dist/src')))).toBe(true);
    // mkdir each segment as archon-owned (`sudo install -d -o archon -g archon ...`)
    expect(calls.some((c) => c.includes('install -d -o archon -g archon') && c.endsWith(join(root, 'dist/src')))).toBe(true);
    // final file install: root, exact target (-T), app-user ownership, mode 644
    const inst = run.mock.calls.find(([cmd, args]) =>
      cmd === 'sudo' && (args as string[])[0] === 'install' && (args as string[]).includes('-T'));
    expect(inst, 'expected `sudo install -T -o archon -g archon -m 644 <tmp> <dest>`').toBeTruthy();
    const iargs = inst![1] as string[];
    expect(iargs).toEqual(expect.arrayContaining(['-T', '-o', 'archon', '-g', 'archon', '-m', '644']));
    expect(iargs[iargs.length - 1]).toBe(join(root, 'dist/src/app.module.js'));
    // it is NEVER `sudo -u archon` (root reads the temp file; -u archon can't)
    expect(calls.some((c) => c.includes('sudo -u archon'))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('deletes via `sudo rm -f <target>`', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ad-sudo-'));
    const run = vi.fn().mockResolvedValue(ok);
    const ops = makeSudoFileOps('archon', run);
    const res = await applyDiff(root, { files: [], deletions: ['dist/old.js'] }, ops);
    expect(res.deleted).toBe(1);
    const rmCall = run.mock.calls.find(([cmd, args]) => cmd === 'sudo' && (args as string[])[0] === 'rm');
    expect(rmCall).toBeTruthy();
    expect((rmCall![1] as string[])).toEqual(['rm', '-f', join(root, 'dist/old.js')]);
    await rm(root, { recursive: true, force: true });
  });

  it('throws (NO sudo op at all) when a write target parent is a symlink — applyDiff guard runs before ops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ad-sudo-'));
    const outside = await mkdtemp(join(tmpdir(), 'ad-out-'));
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, join(root, 'dist')); // dist -> outside dir
    const run = vi.fn().mockResolvedValue(ok);
    const ops = makeSudoFileOps('archon', run);

    await expect(
      applyDiff(root, { files: [{ path: 'dist/x.js', content: Buffer.from('Y').toString('base64') }], deletions: [] }, ops),
    ).rejects.toThrow(/symlink/i);
    expect(run).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('the per-segment sudo symlink guard fails the write if a parent segment is a symlink at ops time', async () => {
    // Even past applyDiff's agent-side guard, the ops re-guards each segment via
    // `sudo test ! -L`; a non-zero from that guard must throw before install.
    const root = await mkdtemp(join(tmpdir(), 'ad-sudo-'));
    const run = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      // simulate: `test ! -L <dist>` returns non-zero (dist IS a symlink)
      if (args[0] === 'test' && args.includes('-L')) return Promise.resolve({ code: 1, stdout: '', stderr: '' });
      return Promise.resolve(ok);
    });
    const ops = makeSudoFileOps('archon', run);
    await expect(ops.writeFile(root, 'dist/src/x.js', join(root, 'dist/src/x.js'), Buffer.from('Z')))
      .rejects.toThrow(/symlink-guard/i);
    // install must NOT have run
    expect(run.mock.calls.some(([, a]) => (a as string[])[0] === 'install' && (a as string[]).includes('-T'))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('propagates a non-zero install exit as an error (deploy must fail loudly)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ad-sudo-'));
    const run = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'install' && args.includes('-T')) return Promise.resolve({ code: 1, stdout: '', stderr: 'install: cannot create' });
      return Promise.resolve(ok);
    });
    const ops = makeSudoFileOps('archon', run);
    await expect(
      applyDiff(root, { files: [{ path: 'x.js', content: Buffer.from('Y').toString('base64') }], deletions: [] }, ops),
    ).rejects.toThrow(/install.*cannot create|install .*failed/i);
    await rm(root, { recursive: true, force: true });
  });
});
