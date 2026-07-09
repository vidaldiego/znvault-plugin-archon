import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/routes/index.js';

describe('archon agent routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = Fastify();
    const mgr = { restart: vi.fn().mockResolvedValue(undefined), status: vi.fn().mockResolvedValue({ active: true, raw: 'active' }),
      reboot: vi.fn(async (c: string, h: string, j: boolean) => (c === h && !j ? { accepted: true } : { accepted: false, reason: 'x' })) };
    const differ = { hash: vi.fn().mockResolvedValue({ dist: [] }), apply: vi.fn().mockResolvedValue({ written: 0, deleted: 0 }) };
    const journal = { isOpen: () => false, hostname: () => 'archon-api-1' };
    await registerRoutes(app, mgr as any, differ as any, journal as any,
      { service: 'archon-api', appRoot: '/opt/archon', user: 'archon', healthProbePort: 4081 } as any, { info: vi.fn(), error: vi.fn() } as any);
    await app.ready();
  });
  afterEach(() => app.close());

  it('GET /hashes returns the manifest', async () => {
    const r = await app.inject({ method: 'GET', url: '/hashes' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toHaveProperty('dist');
  });
  it('POST /restart calls the manager', async () => {
    const r = await app.inject({ method: 'POST', url: '/restart' });
    expect(r.statusCode).toBe(200);
  });
  it('POST /reboot refuses on hostname mismatch (400/409)', async () => {
    const r = await app.inject({ method: 'POST', url: '/reboot', payload: { confirm: 'wrong' } });
    expect([400, 409]).toContain(r.statusCode);
  });
  it('POST /reboot accepts on matching hostname → 202', async () => {
    const r = await app.inject({ method: 'POST', url: '/reboot', payload: { confirm: 'archon-api-1' } });
    expect(r.statusCode).toBe(202);
  });
});
