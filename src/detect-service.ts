import type { RunFn } from './archon-manager.js';

/**
 * Detect this node's archon systemd service by querying systemd for installed
 * `archon-*.service` units.
 *
 * WHY: the archon plugin's `service` is per-node (archon-api on API nodes,
 * archon-worker / archon-scheduler / archon-backup elsewhere), but the
 * zn-vault-agent host config (`archon-fleet`) is shared by all archon nodes
 * and has no per-agent override. Rather than maintain one host config per role,
 * the plugin detects its own service: each node runs exactly one archon-*
 * service, so a single fleet-wide plugin entry (with `service` omitted) works
 * everywhere.
 *
 * The query is READ-ONLY (`systemctl list-units`) and must NOT go through sudo:
 * the scoped sudoers only permits `systemctl {restart,start,stop,is-active,reboot}
 * archon-*`, not `list-units`. Read-only systemctl queries need no privilege.
 *
 * Throws (never guesses) when zero or more than one archon service is present —
 * an ambiguous host must set `config.service` explicitly.
 */
export async function detectArchonService(run: RunFn): Promise<string> {
  // `--all` (no --state filter) so we see the unit even if it's momentarily
  // stopped mid-deploy — but we then filter on the LOAD column below to drop
  // stale `not-found`/`masked` leftovers that would otherwise poison the count.
  const r = await run('systemctl', [
    'list-units',
    '--type=service',
    '--all',
    '--plain',
    '--no-legend',
    'archon-*.service',
  ]);
  if (r.code !== 0) {
    throw new Error(`failed to list archon units (systemctl list-units exit ${r.code}): ${r.stderr.trim() || 'unknown error'}`);
  }

  // Each line: "<unit> <load> <active> <sub> <description...>". Take the unit
  // name (first token) only for lines whose LOAD state (second token) is
  // `loaded` — this drops `not-found` and `masked` leftovers that `--all` can
  // surface, so a dead unit reference can't create a false "multiple services"
  // error or be returned as the service to act on. Blank/short lines are ignored.
  const units = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === 'loaded')
    .map((cols) => cols[0])
    .filter((u): u is string => !!u && u.startsWith('archon-') && u.endsWith('.service'));

  const unique = [...new Set(units)];

  if (unique.length > 1) {
    throw new Error(`multiple archon services found (${unique.join(', ')}) — ambiguous; set config.service explicitly`);
  }
  const service = unique[0];
  if (service === undefined) {
    throw new Error('no archon-*.service unit found on this host — set config.service explicitly');
  }
  return service;
}
