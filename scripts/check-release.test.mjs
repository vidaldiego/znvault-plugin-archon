import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, URL} from 'node:url';
import {spawnSync, execFileSync} from 'node:child_process';
import process from 'node:process';

const script = fileURLToPath(new URL('./check-release.mjs', import.meta.url));

for (const scenario of ['valid', 'wrong-tag', 'wrong-lock', 'branch-dispatch', 'off-main', 'tag-other-commit']) {
  test(scenario, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-plugin-release-test-'));
    try {
      const git = (...args) => execFileSync('git', args, {cwd, stdio: 'pipe'});
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({name: '@zincapp/znvault-plugin-archon', version: '0.5.5'}));
      writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({
        version: scenario === 'wrong-lock' ? '0.0.0' : '0.5.5',
        packages: {'': {version: '0.5.5'}},
      }));
      git('add', '.');
      git('commit', '-m', 'initial');
      git('tag', 'v0.5.5');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      if (['off-main', 'tag-other-commit'].includes(scenario)) {
        git('commit', '--allow-empty', '-m', 'next');
        if (scenario === 'tag-other-commit') git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      }

      const result = spawnSync(process.execPath, [script, scenario === 'wrong-tag' ? 'v0.5.6' : 'v0.5.5'], {
        cwd,
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_REF_TYPE: scenario === 'branch-dispatch' ? 'branch' : 'tag',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status === 0, scenario === 'valid', result.stderr);
    } finally {
      rmSync(cwd, {recursive: true, force: true});
    }
  });
}
