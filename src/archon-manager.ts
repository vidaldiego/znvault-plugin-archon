import { spawn } from 'node:child_process';
import type { ArchonPluginConfig } from './plugin-config.js';
import { detectArchonService } from './detect-service.js';

export interface RunResult { code: number; stdout: string; stderr: string; }
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

const defaultRun: RunFn = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
});

export class ArchonManager {
  /** Resolved service name, cached after the first lookup (config or detection). */
  private resolvedService: string | undefined;

  constructor(private readonly cfg: ArchonPluginConfig, private readonly run: RunFn = defaultRun) {
    this.resolvedService = cfg.service;
  }

  /**
   * The systemd service to act on: `config.service` when set, otherwise the
   * single installed `archon-*.service` auto-detected. Detection throws (never
   * guesses) when zero or >1 archon services are present. A SUCCESSFUL detection
   * is cached for the lifetime of this manager; a THROWING detection is not
   * cached, so a transient failure is retried on the next call rather than
   * permanently wedging the node.
   */
  async getService(): Promise<string> {
    if (this.resolvedService === undefined) {
      // Assign only after the await resolves — a throw leaves resolvedService
      // undefined so the next call retries (see doc comment above).
      this.resolvedService = await detectArchonService(this.run);
    }
    return this.resolvedService;
  }

  private async systemctl(verb: string): Promise<void> {
    const service = await this.getService();
    const r = await this.run('sudo', ['systemctl', verb, service]);
    if (r.code !== 0) throw new Error(`systemctl ${verb} ${service} failed: ${r.stderr || r.code}`);
  }
  restart() { return this.systemctl('restart'); }
  start() { return this.systemctl('start'); }
  stop() { return this.systemctl('stop'); }

  async status(): Promise<{ active: boolean; raw: string }> {
    const service = await this.getService();
    const r = await this.run('sudo', ['systemctl', 'is-active', service]);
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
