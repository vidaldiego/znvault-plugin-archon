// Path: test/canary-rollout.test.ts
// Covers the spec-gap fix in src/cli/commands.ts's `deploy run`: a SERVING
// class (has an active haproxy.serverMap) must roll out through
// executeStrategy using the class's configured strategy (e.g. "1+R" canary),
// with each host drained before its deploy and readied after — even when the
// deploy/health-check fails (re-ready in `finally`). A WORKER class (no
// haproxy) must never call drainServer/readyServer.
//
// deploy-core's own executor/haproxy/health functions are mocked so this
// test asserts *how commands.ts wires them together*, not their internal
// behavior (already covered by deploy-core's own test suite).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import type { DeployConfig } from '@zincapp/znvault-deploy-core';

const {
  executeStrategyMock,
  drainServerMock,
  readyServerMock,
  performHealthCheckMock,
  testHAProxyConnectivityMock,
  getUnmappedHostsMock,
  agentGetMock,
  agentPostMock,
  openTunnelMock,
  closeTunnelMock,
  getConfigMock,
} = vi.hoisted(() => ({
  executeStrategyMock: vi.fn(),
  drainServerMock: vi.fn(),
  readyServerMock: vi.fn(),
  performHealthCheckMock: vi.fn(),
  testHAProxyConnectivityMock: vi.fn(),
  getUnmappedHostsMock: vi.fn(),
  agentGetMock: vi.fn(),
  agentPostMock: vi.fn(),
  openTunnelMock: vi.fn(),
  closeTunnelMock: vi.fn(),
  getConfigMock: vi.fn(),
}));

vi.mock('@zincapp/znvault-deploy-core', async () => {
  const actual = await vi.importActual<typeof import('@zincapp/znvault-deploy-core')>('@zincapp/znvault-deploy-core');
  return {
    ...actual,
    getConfig: getConfigMock,
    agentGet: agentGetMock,
    agentPost: agentPostMock,
    openTunnel: openTunnelMock,
    executeStrategy: executeStrategyMock,
    drainServer: drainServerMock,
    readyServer: readyServerMock,
    performHealthCheck: performHealthCheckMock,
    testHAProxyConnectivity: testHAProxyConnectivityMock,
    getUnmappedHosts: getUnmappedHostsMock,
  };
});

// Import AFTER vi.mock so commands.ts binds to the mocked module.
const { createArchonCLIPlugin } = await import('../src/cli.js');

function makeCtx() {
  return {
    client: { get: vi.fn(), post: vi.fn() },
    output: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      table: vi.fn(),
      keyValue: vi.fn(),
    },
    getConfig: () => ({ url: 'http://localhost' }),
    isPlainMode: () => true,
  };
}

function buildProgram(ctx: ReturnType<typeof makeCtx>) {
  const program = new Command();
  program.exitOverride(); // don't process.exit() in tests
  createArchonCLIPlugin().registerCommands(program, ctx as any);
  return program;
}

const apiConfig: DeployConfig = {
  name: 'staging',
  rootDir: '/tmp/archon-project',
  warPath: '/tmp/archon-project',
  port: 9100,
  classes: [
    {
      name: 'api',
      hosts: ['192.0.2.55', '192.0.2.56'],
      strategy: '1+R',
      haproxy: {
        hosts: ['198.51.100.20'],
        backend: 'api_servers',
        serverMap: { '192.0.2.55': 'api1', '192.0.2.56': 'api2' },
      },
    },
    {
      name: 'worker',
      hosts: ['192.0.2.58'],
    },
  ],
};

const quiescedWorkerConfig: DeployConfig = {
  ...apiConfig,
  classes: [
    apiConfig.classes![0]!,
    {
      ...apiConfig.classes![1]!,
      quiesce: { enabled: true, pollMs: 1, drainTimeoutMs: 100 },
    },
  ],
};

describe('deploy run — canary rollout + HAProxy drain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockResolvedValue(apiConfig);
    // Remote manifest carries a stale file absent locally, so every host's
    // diff is always non-empty (a deletion) — forces the deploy path (agentPost)
    // to run instead of short-circuiting on "up to date", regardless of what
    // (if anything) is actually on disk at rootDir in the test environment.
    agentGetMock.mockResolvedValue({ root: [{ path: 'stale-remote-only-file.txt', sha256: 'deadbeef' }] });
    agentPostMock.mockResolvedValue({});
    closeTunnelMock.mockResolvedValue(undefined);
    openTunnelMock.mockResolvedValue({ host: '192.0.2.58', localPort: 49123, close: closeTunnelMock });
    testHAProxyConnectivityMock.mockResolvedValue({ success: true, results: [] });
    getUnmappedHostsMock.mockReturnValue([]);
    drainServerMock.mockResolvedValue({ success: true, results: [] });
    readyServerMock.mockResolvedValue({ success: true, results: [] });
    performHealthCheckMock.mockResolvedValue({ success: true, status: 200, attempts: 1, totalTime: 10 });
  });

  it('runs the api (serving) class through executeStrategy with its configured strategy', async () => {
    executeStrategyMock.mockImplementation(async (strategy, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map<string, any>();
      for (const h of hosts) results.set(h, await deployFn(h));
      return { total: hosts.length, successful: hosts.length, failed: 0, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx);
    await program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'run', 'staging', '--class', 'api']);

    expect(executeStrategyMock).toHaveBeenCalledTimes(1);
    const [strategyArg, hostsArg] = executeStrategyMock.mock.calls[0]!;
    expect(strategyArg).toMatchObject({ name: '1+R', isCanary: true });
    expect(hostsArg).toEqual(['192.0.2.55', '192.0.2.56']);
  });

  it('drains before deploy and readies after, for every host in the serving class', async () => {
    executeStrategyMock.mockImplementation(async (strategy, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map<string, any>();
      for (const h of hosts) results.set(h, await deployFn(h));
      return { total: hosts.length, successful: hosts.length, failed: 0, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx);
    await program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'run', 'staging', '--class', 'api']);

    expect(drainServerMock).toHaveBeenCalledTimes(2);
    expect(readyServerMock).toHaveBeenCalledTimes(2);
    for (const host of ['192.0.2.55', '192.0.2.56']) {
      expect(drainServerMock).toHaveBeenCalledWith(apiConfig.classes![0]!.haproxy, host);
      expect(readyServerMock).toHaveBeenCalledWith(apiConfig.classes![0]!.haproxy, host);
    }

    // drain must happen before deploy (agentPost), ready must happen after.
    const drainOrder = drainServerMock.mock.invocationCallOrder[0]!;
    const postOrder = agentPostMock.mock.invocationCallOrder[0]!;
    const readyOrder = readyServerMock.mock.invocationCallOrder[0]!;
    expect(drainOrder).toBeLessThan(postOrder);
    expect(postOrder).toBeLessThan(readyOrder);
  });

  it('re-readies a host in `finally` when the deploy fails after a successful drain', async () => {
    // Simulate a deploy failure: agentPost throws on the first host only.
    agentPostMock.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    executeStrategyMock.mockImplementation(async (strategy, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map<string, any>();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx);
    // A failed blocking class aborts the deploy run (exit code 1); with
    // exitOverride() that surfaces as a thrown CommanderError instead of a
    // real process.exit — expected here since the test deliberately fails
    // one host's deploy. The assertions below are about drain/ready pairing,
    // not the exit code.
    await expect(
      program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'run', 'staging', '--class', 'api']),
    ).rejects.toThrow();

    // Both hosts were drained (host 1 before its failed deploy, host 2 before its ok deploy).
    expect(drainServerMock).toHaveBeenCalledTimes(2);
    // readyServer must STILL be called for the failed host (via `finally`), plus the healthy one.
    expect(readyServerMock).toHaveBeenCalledTimes(2);
    expect(readyServerMock).toHaveBeenCalledWith(apiConfig.classes![0]!.haproxy, '192.0.2.55');
    expect(readyServerMock).toHaveBeenCalledWith(apiConfig.classes![0]!.haproxy, '192.0.2.56');
  });

  it('does NOT call drainServer/readyServer for a worker class with no haproxy config', async () => {
    const ctx = makeCtx();
    const program = buildProgram(ctx);
    await program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'run', 'staging', '--class', 'worker']);

    expect(drainServerMock).not.toHaveBeenCalled();
    expect(readyServerMock).not.toHaveBeenCalled();
    // Worker class deploys directly (bare sequential loop), not via executeStrategy.
    expect(executeStrategyMock).not.toHaveBeenCalled();
    expect(agentPostMock).toHaveBeenCalledWith(expect.stringContaining('192.0.2.58'), expect.anything());
    expect(agentPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/restart'),
      {},
      300_000,
    );
  });

  it('--skip-drain forces the api class through the bare (no-drain) worker-style path', async () => {
    const ctx = makeCtx();
    const program = buildProgram(ctx);
    await program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'run', 'staging', '--class', 'api', '--skip-drain']);

    expect(drainServerMock).not.toHaveBeenCalled();
    expect(readyServerMock).not.toHaveBeenCalled();
    expect(executeStrategyMock).not.toHaveBeenCalled();
    expect(testHAProxyConnectivityMock).not.toHaveBeenCalled();
  });

  it('runs the configured worker quiesce -> drain -> deploy/restart -> resume ceremony', async () => {
    getConfigMock.mockResolvedValue(quiescedWorkerConfig);
    let statusCalls = 0;
    agentGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/quiesce/status')) {
        statusCalls++;
        return { quiesced: true, activeJobs: statusCalls === 1 ? 1 : 0 };
      }
      return { root: [{ path: 'stale-remote-only-file.txt', sha256: 'deadbeef' }] };
    });
    agentPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/quiesce')) return { quiesced: true, activeJobs: 2 };
      return {};
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx);
    await program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'run', 'staging', '--class', 'worker']);

    const calls = agentPostMock.mock.calls.map(([url]) => String(url));
    const quiesceAt = calls.findIndex((url) => url.endsWith('/quiesce'));
    const deployAt = calls.findIndex((url) => url.endsWith('/deploy'));
    const restartAt = calls.findIndex((url) => url.endsWith('/restart'));
    const resumeAt = calls.findIndex((url) => url.endsWith('/resume'));
    expect(quiesceAt).toBeGreaterThanOrEqual(0);
    expect(quiesceAt).toBeLessThan(deployAt);
    expect(deployAt).toBeLessThan(restartAt);
    expect(restartAt).toBeLessThan(resumeAt);
    expect(statusCalls).toBe(2);
    expect(ctx.output.info).toHaveBeenCalledWith(expect.stringContaining('quiesced and drained'));
    expect(ctx.output.info).toHaveBeenCalledWith(expect.stringContaining('resumed'));
  });

  it('fails closed and resumes when configured quiesce is unavailable', async () => {
    getConfigMock.mockResolvedValue(quiescedWorkerConfig);
    agentPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/quiesce')) return { status: 'noop', reason: 'not_found' };
      return {};
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx);
    await program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'run', 'staging', '--class', 'worker']);

    const calls = agentPostMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.endsWith('/deploy'))).toBe(false);
    expect(calls.some((url) => url.endsWith('/restart'))).toBe(false);
    expect(calls.some((url) => url.endsWith('/resume'))).toBe(true);
    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringContaining('quiesce unavailable (not_found)'));
  });

  it('opens and tears down the configured SSH tunnel for deploy hashes', async () => {
    getConfigMock.mockResolvedValue({ ...apiConfig, tunnel: true, ssh: { user: 'sysadmin' } }); // gitleaks:allow reason=test-only documented default SSH account, not a credential

    const ctx = makeCtx();
    const program = buildProgram(ctx);
    await program.parseAsync(['node', 'znvault', 'archon', 'deploy', 'hashes', 'staging', '--class', 'worker']);

    expect(openTunnelMock).toHaveBeenCalledWith('192.0.2.58', {
      user: 'sysadmin', // gitleaks:allow reason=test-only documented default SSH account, not a credential
      remotePort: 9100,
      readinessTimeoutMs: undefined,
    });
    expect(agentGetMock).toHaveBeenCalledWith('http://127.0.0.1:49123/plugins/archon/hashes');
    expect(closeTunnelMock).toHaveBeenCalledTimes(1);
    expect(ctx.output.info).toHaveBeenCalledWith(expect.stringContaining('[worker] 192.0.2.58:'));
  });
});
