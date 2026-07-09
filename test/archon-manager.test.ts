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
