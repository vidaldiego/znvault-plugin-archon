import { describe, it, expect, vi } from 'vitest';
import { ArchonManager } from '../src/archon-manager.js';

const cfg = { service: 'archon-api', appRoot: '/opt/archon', user: 'archon', healthProbePort: 4081 };

describe('ArchonManager.reboot guard', () => {
  it('refuses when confirm !== hostname', async () => {
    const run = vi.fn();
    const m = new ArchonManager(cfg, run);
    const r = await m.reboot('wrong-host', 'archon-api-1', false);
    expect(r.accepted).toBe(false);
    expect(run).not.toHaveBeenCalledWith('sudo', expect.arrayContaining(['systemctl', 'reboot']));
  });
  it('refuses while a deploy journal is open', async () => {
    const run = vi.fn();
    const m = new ArchonManager(cfg, run);
    const r = await m.reboot('archon-api-1', 'archon-api-1', true);
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/journal/i);
  });
  it('accepts + issues reboot when confirm matches and no journal', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const m = new ArchonManager(cfg, run);
    const r = await m.reboot('archon-api-1', 'archon-api-1', false);
    expect(r.accepted).toBe(true);
    expect(run).toHaveBeenCalledWith('sudo', expect.arrayContaining(['systemctl', 'reboot']));
  });
  it('restart runs sudo systemctl restart <service>', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await new ArchonManager(cfg, run).restart();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'archon-api']);
  });
});

describe('ArchonManager service auto-detection (config.service omitted)', () => {
  const noService = { appRoot: '/opt/archon', user: 'archon', healthProbePort: 4081 };

  it('detects the service via non-sudo list-units, then acts on it', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args.includes('list-units')) {
        return Promise.resolve({ code: 0, stdout: 'archon-worker.service loaded active running Archon Node Worker\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    await new ArchonManager(noService, run).restart();
    // detection call is non-sudo:
    expect(run).toHaveBeenCalledWith('systemctl', expect.arrayContaining(['list-units', 'archon-*.service']));
    // the resolved service is what gets restarted:
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'archon-worker.service']);
  });

  it('detects only ONCE and caches the result across calls', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args.includes('list-units')) {
        return Promise.resolve({ code: 0, stdout: 'archon-api.service loaded active running Archon Node API\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: 'active', stderr: '' });
    });
    const m = new ArchonManager(noService, run);
    await m.restart();
    await m.status();
    await m.stop();
    const detectCalls = run.mock.calls.filter(([cmd, args]) => cmd === 'systemctl' && (args as string[]).includes('list-units'));
    expect(detectCalls).toHaveLength(1);
  });

  it('propagates the ambiguity error when >1 archon service exists', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'archon-api.service loaded active running x\narchon-worker.service loaded active running y\n',
      stderr: '',
    });
    await expect(new ArchonManager(noService, run).restart()).rejects.toThrow(/multiple|ambiguous/i);
  });

  it('explicit config.service skips detection entirely', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await new ArchonManager(cfg, run).restart();
    const detectCalls = run.mock.calls.filter(([cmd, args]) => cmd === 'systemctl' && (args as string[]).includes('list-units'));
    expect(detectCalls).toHaveLength(0);
  });

  it('does NOT cache a failed detection — retries on the next call (no permanent wedge)', async () => {
    let detectCall = 0;
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args.includes('list-units')) {
        detectCall += 1;
        // first detection: transient empty result (throws); second: succeeds
        return Promise.resolve(
          detectCall === 1
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 0, stdout: 'archon-worker.service loaded active running Archon Node Worker\n', stderr: '' },
        );
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    const m = new ArchonManager(noService, run);
    await expect(m.restart()).rejects.toThrow(/no archon-\*\.service/i);
    // the failure was NOT cached: the retry detects successfully and acts
    await m.restart();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'archon-worker.service']);
    expect(detectCall).toBe(2);
  });
});
