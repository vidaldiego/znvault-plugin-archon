import { describe, it, expect } from 'vitest';
import createArchonPlugin, { PLUGIN_VERSION } from '../src/index.js';

// Pins the exact contract zn-vault-agent's PluginLoader.validatePlugin enforces
// (loader.js): the plugin object MUST have a non-empty `name` string, a
// non-empty `version` string, and any of the lifecycle hooks it exposes must be
// functions. A missing `version` is what caused "Plugin must have a version
// property" on the first real load — unit tests never exercised the loader, so
// this test stands in for it.
const cfg = { appRoot: '/opt/archon', user: 'archon', healthProbePort: 4081 };

describe('createArchonPlugin — agent loader contract', () => {
  it('returns an object with a non-empty name', () => {
    const p = createArchonPlugin(cfg);
    expect(typeof p.name).toBe('string');
    expect(p.name).toBe('archon');
  });

  it('returns a non-empty version string (loader rejects a missing/blank version)', () => {
    const p = createArchonPlugin(cfg);
    expect(typeof p.version).toBe('string');
    expect(p.version.length).toBeGreaterThan(0);
    // matches the package version read at module load
    expect(p.version).toBe(PLUGIN_VERSION);
  });

  it('PLUGIN_VERSION matches this package.json version (never the 0.0.0 fallback in a normal build)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(PLUGIN_VERSION).not.toBe('0.0.0');
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exposes routes as a function (the only lifecycle hook we implement)', () => {
    const p = createArchonPlugin(cfg);
    expect(typeof p.routes).toBe('function');
  });
});
