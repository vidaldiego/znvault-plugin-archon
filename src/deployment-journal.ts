// Deployment journal for crash recovery.
//
// Ported from znvault-plugin-payara's DeploymentJournal, adapted to Archon's
// file-diff deploy model (no WAR, no asadmin steps). The invariant this
// preserves: a /deploy either fully applies (journal closed) or leaves the
// journal marked open on disk, so a crash mid-deploy is detectable on the
// next boot / next request, and POST /reboot refuses to fire while a
// deployment is in flight.
//
// Unlike payara's journal (which tracks step-by-step asadmin progress for
// future resume), Archon's applyDiff is a single atomic-ish operation from
// the route's point of view — the journal here only needs open/close plus
// the synchronous accessors the reboot guard reads on every request
// (isOpen(), hostname()). Load-from-disk on construction so a fresh process
// picks up an interrupted deploy immediately.

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname as osHostname } from 'node:os';

export interface DeploymentCheckpoint {
  deploymentId: string;
  startedAt: number;
  filesChanged: number;
  filesDeleted: number;
}

export interface JournalLogger {
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

/**
 * Deployment journal for crash recovery + the reboot guard's "is a deploy in
 * flight" check.
 *
 * Journal is stored at `<appRoot>/.deploy-journal.json` by default (kept
 * alongside the managed app tree, not under /var/lib, since the plugin has
 * no other persistent-state directory conventions yet). `isOpen()` is a
 * synchronous read of in-memory state (mirrored to disk on every open/close)
 * so the reboot guard never has to do I/O on the hot path.
 */
export class DeploymentJournal {
  private readonly journalPath: string;
  private readonly logger: JournalLogger;
  private readonly hostnameValue: string;
  private current: DeploymentCheckpoint | null = null;

  constructor(appRootOrPath: string, logger: JournalLogger = {}, hostnameOverride?: string) {
    this.journalPath = appRootOrPath.endsWith('.json')
      ? appRootOrPath
      : `${appRootOrPath.replace(/\/$/, '')}/.deploy-journal.json`;
    this.logger = logger;
    this.hostnameValue = hostnameOverride ?? osHostname();
    this.loadFromDisk();
  }

  /** Hostname this node identifies as — read by the reboot confirm guard. */
  hostname(): string {
    return this.hostnameValue;
  }

  /** True while a deploy is open (journal not yet closed). Synchronous — read on every /reboot request. */
  isOpen(): boolean {
    return this.current !== null;
  }

  /** Open a new journal entry before applying a diff. Persists to disk. */
  open(options: { deploymentId: string; filesChanged: number; filesDeleted: number }): void {
    this.current = {
      deploymentId: options.deploymentId,
      startedAt: Date.now(),
      filesChanged: options.filesChanged,
      filesDeleted: options.filesDeleted,
    };
    this.persist();
    this.logger.info?.({ deploymentId: options.deploymentId }, 'Deployment journal opened');
  }

  /** Close (clear) the journal after a deploy fully applies. */
  close(): void {
    if (!this.current) return;
    const { deploymentId, startedAt } = this.current;
    this.current = null;
    this.clearDisk();
    this.logger.info?.({ deploymentId, durationMs: Date.now() - startedAt }, 'Deployment journal closed');
  }

  /** Current checkpoint, if any — for diagnostics / GET /deploy/status. */
  peek(): DeploymentCheckpoint | null {
    return this.current;
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.journalPath)) return;
      const raw = readFileSync(this.journalPath, 'utf-8');
      this.current = JSON.parse(raw) as DeploymentCheckpoint;
      this.logger.warn?.(
        { deploymentId: this.current.deploymentId },
        'Found an open deployment journal on startup — a previous deploy may have crashed mid-apply',
      );
    } catch (err) {
      this.logger.warn?.({ err }, 'Failed to read deployment journal from disk (ignoring, treating as closed)');
      this.current = null;
    }
  }

  private persist(): void {
    if (!this.current) return;
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      writeFileSync(this.journalPath, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    } catch (err) {
      this.logger.warn?.({ err }, 'Failed to persist deployment journal');
    }
  }

  private clearDisk(): void {
    try {
      rmSync(this.journalPath, { force: true });
    } catch {
      // ignore
    }
  }
}
