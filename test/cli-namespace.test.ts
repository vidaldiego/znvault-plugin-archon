import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createArchonCLIPlugin } from '../src/cli.js';

describe('archon CLI namespace', () => {
  it('registers "archon" with deploy/restart/reboot/config/quiesce subcommands', () => {
    const program = new Command();
    createArchonCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
    const archon = program.commands.find((c) => c.name() === 'archon');
    expect(archon).toBeTruthy();
    const subs = archon!.commands.map((c) => c.name());
    for (const s of ['deploy', 'restart', 'reboot', 'config', 'quiesce']) expect(subs).toContain(s);
  });
});
