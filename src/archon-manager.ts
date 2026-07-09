import { spawn } from 'node:child_process';
import type { ArchonPluginConfig } from './plugin-config.js';

export interface RunResult { code: number; stdout: string; stderr: string; }
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

const defaultRun: RunFn = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
});

export class ArchonManager {
  constructor(private readonly cfg: ArchonPluginConfig, private readonly run: RunFn = defaultRun) {}

  private async systemctl(verb: string): Promise<void> {
    const r = await this.run('sudo', ['systemctl', verb, this.cfg.service]);
    if (r.code !== 0) throw new Error(`systemctl ${verb} ${this.cfg.service} failed: ${r.stderr || r.code}`);
  }
  restart() { return this.systemctl('restart'); }
  start() { return this.systemctl('start'); }
  stop() { return this.systemctl('stop'); }

  async status(): Promise<{ active: boolean; raw: string }> {
    const r = await this.run('sudo', ['systemctl', 'is-active', this.cfg.service]);
    return { active: r.stdout.trim() === 'active', raw: r.stdout.trim() };
  }

  async reboot(confirm: string, hostname: string, deployJournalOpen: boolean): Promise<{ accepted: boolean; reason?: string }> {
    if (confirm !== hostname) return { accepted: false, reason: `confirm '${confirm}' != hostname '${hostname}'` };
    if (deployJournalOpen) return { accepted: false, reason: 'a deploy journal is open — refusing reboot' };
    // detached: the reboot will kill us; don't await the machine going down.
    void this.run('sudo', ['systemctl', 'reboot']);
    return { accepted: true };
  }
}
