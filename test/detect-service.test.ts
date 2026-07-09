import { describe, it, expect, vi } from 'vitest';
import { detectArchonService } from '../src/detect-service.js';

// list-units output shape verified live on a real node:
//   "archon-worker.service loaded active running Archon Node Worker"
const line = (unit: string) => `${unit} loaded active running Archon Node`;

describe('detectArchonService', () => {
  it('returns the single archon-*.service unit name via a non-sudo list-units query', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: line('archon-worker.service') + '\n', stderr: '' });
    const svc = await detectArchonService(run);
    expect(svc).toBe('archon-worker.service');
    // detection is a read-only query — the ONLY call it makes is a non-sudo
    // `systemctl list-units` (list-units is not in the scoped sudoers allow-list).
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args] = run.mock.calls[0]!;
    expect(cmd).toBe('systemctl');
    expect(args).toEqual(expect.arrayContaining(['list-units', '--type=service', 'archon-*.service']));
  });

  it('ignores stale not-found / masked leftovers surfaced by --all (LOAD != loaded)', async () => {
    // `--all` can list a dead reference; only the `loaded` unit is real.
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout:
        'archon-api.service not-found inactive dead archon-api.service\n' +
        line('archon-worker.service') + '\n' +
        'archon-scheduler.service masked inactive dead archon-scheduler.service\n',
      stderr: '',
    });
    expect(await detectArchonService(run)).toBe('archon-worker.service');
  });

  it('strips a trailing .service-less name too (accepts either form)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'archon-api.service loaded active running Archon Node API\n', stderr: '' });
    expect(await detectArchonService(run)).toBe('archon-api.service');
  });

  it('throws a clear error when NO archon service is found', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await expect(detectArchonService(run)).rejects.toThrow(/no archon-\*\.service/i);
  });

  it('throws when MORE THAN ONE archon service is found (ambiguous — require explicit config.service)', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: line('archon-api.service') + '\n' + line('archon-worker.service') + '\n',
      stderr: '',
    });
    await expect(detectArchonService(run)).rejects.toThrow(/multiple|ambiguous/i);
  });

  it('ignores blank lines and systemctl noise', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '\n  \n' + line('archon-scheduler.service') + '\n\n',
      stderr: '',
    });
    expect(await detectArchonService(run)).toBe('archon-scheduler.service');
  });

  it('throws when systemctl itself fails (non-zero exit)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'Failed to list units: connection refused' });
    await expect(detectArchonService(run)).rejects.toThrow(/list.*units|connection refused/i);
  });
});
