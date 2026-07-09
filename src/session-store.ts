// Session store for chunked /deploy/chunk uploads.
//
// Ported (trimmed) from znvault-plugin-payara's SessionStore: same
// create/get/addFiles/delete/cleanup shape, adapted to archon's
// { path, content } file entries and DiffInput's deletions array (no
// WAR-specific fields).

import { randomUUID } from 'node:crypto';

export interface ChunkFile { path: string; content: string; }

export interface ChunkedDeploySession {
  id: string;
  createdAt: number;
  files: ChunkFile[];
  deletions: string[];
  expectedFiles?: number;
}

export interface SessionStoreConfig {
  maxSessions?: number;
  timeoutMs?: number;
}

export interface SessionLogger {
  info?(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
}

export class SessionStore {
  private readonly sessions = new Map<string, ChunkedDeploySession>();
  private readonly logger: SessionLogger;
  private readonly maxSessions: number;
  private readonly timeoutMs: number;

  constructor(logger: SessionLogger = {}, config: SessionStoreConfig = {}) {
    this.logger = logger;
    this.maxSessions = config.maxSessions ?? 10;
    this.timeoutMs = config.timeoutMs ?? 30 * 60 * 1000;
  }

  get size(): number {
    return this.sessions.size;
  }

  create(deletions: string[] = [], expectedFiles?: number): ChunkedDeploySession {
    this.cleanup();
    const session: ChunkedDeploySession = { id: randomUUID(), createdAt: Date.now(), files: [], deletions, expectedFiles };
    this.sessions.set(session.id, session);
    this.logger.info?.({ sessionId: session.id, expectedFiles }, 'Started chunked deployment session');
    return session;
  }

  get(sessionId: string): ChunkedDeploySession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (Date.now() - session.createdAt > this.timeoutMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  addFiles(sessionId: string, files: ChunkFile[]): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    session.files.push(...files);
    return true;
  }

  delete(sessionId: string): boolean {
    const existed = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);
    if (existed) this.logger.info?.({ sessionId }, 'Chunked deployment session deleted');
    return existed;
  }

  cleanup(): void {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.createdAt > this.timeoutMs) expiredIds.push(id);
    }
    for (const id of expiredIds) this.sessions.delete(id);

    while (this.sessions.size > this.maxSessions) {
      const oldestId = this.findOldestSession();
      if (!oldestId) break;
      this.sessions.delete(oldestId);
      this.logger.warn?.({ sessionId: oldestId, maxSessions: this.maxSessions }, 'Evicted oldest chunk session due to session limit');
    }
  }

  private findOldestSession(): string | null {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, session] of this.sessions.entries()) {
      if (session.createdAt < oldestTime) {
        oldestTime = session.createdAt;
        oldestId = id;
      }
    }
    return oldestId;
  }
}
