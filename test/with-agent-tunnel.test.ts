import { describe, it, expect, vi } from 'vitest';
import { withAgentTunnel, type TunnelDeps } from '../src/cli/commands.js';

function fakeDeps(localPort = 45123) {
  const close = vi.fn().mockResolvedValue(undefined);
  const deps: TunnelDeps = {
    openTunnel: vi.fn().mockResolvedValue({ localPort, close }),
    setEndpointOverride: vi.fn(),
    clearEndpointOverride: vi.fn(),
  } as unknown as TunnelDeps;
  return { deps, close };
}

describe('withAgentTunnel', () => {
  it('opens a tunnel, sets the endpoint override, runs fn, then tears both down (success path)', async () => {
    const { deps, close } = fakeDeps();
    const fn = vi.fn().mockResolvedValue('result');

    const out = await withAgentTunnel('172.16.211.55', 9100, { user: 'sysadmin' }, fn, deps);

    expect(out).toBe('result');
    expect(deps.openTunnel).toHaveBeenCalledWith('172.16.211.55', { user: 'sysadmin', remotePort: 9100 });
    expect(deps.setEndpointOverride).toHaveBeenCalledWith('172.16.211.55', '127.0.0.1', 45123);
    expect(fn).toHaveBeenCalledTimes(1);
    // cleanup in finally
    expect(deps.clearEndpointOverride).toHaveBeenCalledWith('172.16.211.55');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('tears down the tunnel + override even when fn throws', async () => {
    const { deps, close } = fakeDeps();
    const fn = vi.fn().mockRejectedValue(new Error('reboot refused'));

    await expect(withAgentTunnel('172.16.211.55', 9100, {}, fn, deps)).rejects.toThrow('reboot refused');
    expect(deps.clearEndpointOverride).toHaveBeenCalledWith('172.16.211.55');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('with noTunnel=true, opens NO tunnel and calls fn directly (no override, no teardown)', async () => {
    const { deps, close } = fakeDeps();
    const fn = vi.fn().mockResolvedValue('ok');

    await withAgentTunnel('172.16.211.55', 9100, { noTunnel: true }, fn, deps);

    expect(deps.openTunnel).not.toHaveBeenCalled();
    expect(deps.setEndpointOverride).not.toHaveBeenCalled();
    expect(deps.clearEndpointOverride).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
