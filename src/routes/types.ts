// Shared types for the archon plugin's agent-side HTTP routes.
//
// These are structural (duck-typed) interfaces rather than direct imports of
// the concrete classes, so route handlers stay easy to unit-test with plain
// mocks (see test/routes.integration.test.ts) without needing to construct a
// real ArchonManager/differ/journal.

import type { Logger } from 'pino';
import type { ArchonPluginConfig } from '../plugin-config.js';

export interface RunResult { code: number; stdout: string; stderr: string; }

export interface ManagerLike {
  restart(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ active: boolean; raw: string }>;
  reboot(confirm: string, hostname: string, deployJournalOpen: boolean): Promise<{ accepted: boolean; reason?: string }>;
}

export interface DifferLike {
  hash(): Promise<unknown>;
  apply(input: unknown): Promise<{ written: number; deleted: number }>;
}

export interface JournalLike {
  isOpen(): boolean;
  hostname(): string;
  open?(options: { deploymentId: string; filesChanged: number; filesDeleted: number }): void;
  close?(): void;
  peek?(): unknown;
}

/** Minimal logger shape routes depend on — matches pino's Logger and the brief's test double ({ info, error }). */
export interface RouteLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
}

export interface RouteContext {
  mgr: ManagerLike;
  differ: DifferLike;
  journal: JournalLike;
  cfg: ArchonPluginConfig;
  logger: RouteLogger | Logger;
}
