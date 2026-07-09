import { describe, it, expect, vi } from 'vitest';
import { composeEphemeralUrl, makeArchonRunPhase } from '../src/cli/migration-runner.js';

describe('composeEphemeralUrl', () => {
  it('percent-encodes user + password and pins sslmode=require, direct port', () => {
    const url = composeEphemeralUrl({
      leaseId: 'l', username: 'v-migrate-x/y', password: 'p@ss:w#rd',
      host: '172.16.210.250', port: 5432, database: 'archon',
    } as any);
    expect(url).toBe('postgresql://v-migrate-x%2Fy:p%40ss%3Aw%23rd@172.16.210.250:5432/archon?sslmode=require');
  });
  it('throws when no database on lease and no override', () => {
    expect(() => composeEphemeralUrl({ leaseId: 'l', username: 'u', password: 'p', host: 'h', port: 5432 } as any))
      .toThrow(/database/i);
  });
});

describe('makeArchonRunPhase orchestration', () => {
  const lease = { leaseId: 'L1', username: 'u', password: 'p', host: 'h', port: 5432, database: 'archon' };
  function deps() {
    const events: string[] = [];
    const client = {
      issueCredential: vi.fn(async (_r, o) => { events.push(`mint:${o.ttlSeconds}`); return lease; }),
      revokeCredential: vi.fn(async () => { events.push('revoke'); }),
    };
    const child = { env: undefined as any, killed: false,
      on(ev: string, cb: (c: number) => void) { if (ev === 'close') setTimeout(() => { events.push('child-exit'); cb(0); }, 5); },
      kill() { this.killed = true; } };
    const spawn = vi.fn((_c, _a, opts) => { child.env = opts.env; events.push('spawn'); return child; });
    return { events, client, spawn, settleMs: 0, now: () => 0 };
  }

  it('mints 14400s, spawns prisma with the ephemeral URL, then revokes AFTER child exit', async () => {
    const d = deps();
    const runPhase = makeArchonRunPhase({ output: { info: vi.fn(), warn: vi.fn() } } as any, '/opt/archon', d as any);
    await runPhase({ roleId: 'dbr_x' } as any, 'pre-deploy', {} as any);
    expect(d.client.issueCredential).toHaveBeenCalledWith('dbr_x', { ttlSeconds: 14400 });
    expect(d.spawn.mock.calls[0][1]).toContain('deploy'); // prisma migrate deploy
    expect(d.spawn.mock.calls[0][2].env.DATABASE_URL).toMatch(/^postgresql:\/\/u:p@h:5432\/archon\?sslmode=require$/);
    expect(d.spawn.mock.calls[0][2].env.DIRECT_URL).toBe(d.spawn.mock.calls[0][2].env.DATABASE_URL);
    // revoke happens after child-exit, never before
    expect(d.events.indexOf('revoke')).toBeGreaterThan(d.events.indexOf('child-exit'));
  });
});
