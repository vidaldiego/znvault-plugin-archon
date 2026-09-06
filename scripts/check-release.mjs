import process from 'node:process';
import console from 'node:console';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const tag = process.argv[2];

if (pkg.name !== '@zincapp/znvault-plugin-archon' ||
    !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
    lock.version !== pkg.version ||
    lock.packages?.['']?.version !== pkg.version ||
    tag !== `v${pkg.version}`) {
  throw new Error('Tag, package and lockfile release identity must agree');
}

if (process.env.GITHUB_ACTIONS === 'true') {
  const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
  if (process.env.GITHUB_REF_TYPE !== 'tag' ||
      git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main') ||
      git('rev-parse', `${tag}^{commit}`) !== git('rev-parse', 'HEAD')) {
    throw new Error('Publication requires a version tag at current main');
  }
}

console.log(`Release identity verified: ${tag}`);
