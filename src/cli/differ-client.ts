// Path: src/cli/differ-client.ts
// Client-side counterpart to src/differ.ts's hashManagedFiles/applyDiff.
//
// The AGENT (src/differ.ts) hashes the managed file sets on the REMOTE host
// and exposes them via GET /plugins/archon/hashes. This module hashes the
// LOCAL build output the same way, diffs the two manifests, and builds the
// upload payload (changed + new files as base64 content, deleted paths as a
// plain list) that the CLI POSTs to /plugins/archon/deploy.
//
// Managed sets mirror src/differ.ts's SETS exactly (dist minus dist/public,
// dist/public split out, prisma/, scripts/archon-crypt/dist, and the two
// root files) so a hash mismatch on either side means "this file differs",
// never "this file isn't tracked by one side."

// SINGLE SOURCE OF TRUTH: the managed-set definition + hashing lives ONLY in
// src/differ.ts (hashManagedFiles). The agent hashes the remote tree with it
// and the CLI hashes the local build with the SAME function here, so the two
// manifests can never disagree about which files/sets are tracked — a hash
// difference always means "this file's content differs", never "one side
// doesn't track this set". Do NOT re-declare SETS/walk here.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { hashManagedFiles, type HashManifest } from '../differ.js';

/** Local manifest = the same shape the agent produces (differ.ts's HashManifest). */
export type LocalHashManifest = HashManifest;
/** Remote manifest shape returned by GET /plugins/archon/hashes. */
export type RemoteHashManifest = HashManifest;

/**
 * Hash the local build output with the EXACT same logic the agent uses for the
 * remote managed-file sets — a thin alias over differ.ts's hashManagedFiles so
 * the two sides share one definition (see the note above).
 */
export async function hashLocalBuild(projectPath: string): Promise<LocalHashManifest> {
  return hashManagedFiles(projectPath);
}

export interface DiffPlan {
  /** Paths that are new or whose content differs — need upload. */
  changed: string[];
  /** Paths present on the remote but absent locally — need deletion. */
  deleted: string[];
}

/**
 * Diff a local manifest against a remote one, restricted to the given set
 * keys (e.g. worker classes omit 'dist/public' — see filterSetsForClass).
 * A path is "changed" if it's new locally or its hash differs; "deleted" if
 * it exists remotely but not locally. Unchanged paths are omitted from both.
 */
export function diffManifests(
  local: LocalHashManifest,
  remote: RemoteHashManifest,
  setKeys: string[],
): DiffPlan {
  const localByPath = new Map<string, string>();
  const remoteByPath = new Map<string, string>();

  for (const key of setKeys) {
    for (const f of local[key] ?? []) localByPath.set(f.path, f.sha256);
    for (const f of remote[key] ?? []) remoteByPath.set(f.path, f.sha256);
  }

  const changed: string[] = [];
  for (const [path, sha] of localByPath) {
    if (remoteByPath.get(path) !== sha) changed.push(path);
  }
  const deleted: string[] = [];
  for (const path of remoteByPath.keys()) {
    if (!localByPath.has(path)) deleted.push(path);
  }

  changed.sort();
  deleted.sort();
  return { changed, deleted };
}

/**
 * Which managed-file set keys apply to a given class. Only the 'api' class
 * (the one serving dist/public — the built frontend) gets the dist/public
 * set; every other class (workers, scheduler, etc.) is filtered to just the
 * server-side sets. Matches src/differ.ts's split rationale ("dist/public so
 * the CLI can ship it only to the api class").
 */
export function filterSetsForClass(className: string): string[] {
  const base = ['dist', 'prisma', 'archon-crypt', 'root'];
  return className === 'api' ? [...base, 'dist/public'] : base;
}

export interface UploadFile {
  path: string;
  content: string; // base64, matches src/differ.ts's applyDiff expectation
}

export interface DeployPayload {
  files: UploadFile[];
  deletions: string[];
}

/**
 * Build the /deploy request body: read each changed local file and base64
 * it (applyDiff on the agent decodes with Buffer.from(content, 'base64')),
 * pair it with the deletions list from the diff plan.
 */
export async function buildDeployPayload(projectPath: string, plan: DiffPlan): Promise<DeployPayload> {
  const files: UploadFile[] = [];
  for (const path of plan.changed) {
    const buf = await fs.readFile(join(projectPath, path));
    files.push({ path, content: buf.toString('base64') });
  }
  return { files, deletions: plan.deleted };
}

/**
 * Fetch the remote hash manifest from GET /plugins/archon/hashes, compute
 * the local manifest, diff them (scoped to the class's managed sets), and
 * build the upload payload — the full client-side "what changed" pipeline
 * for one host/class.
 *
 * `getJson` is injected (rather than importing deploy-core's agentGet
 * directly) so this module stays test-friendly without a real HTTP call;
 * production callers pass deploy-core's `agentGet`.
 */
export async function computeDeployPlan(
  projectPath: string,
  className: string,
  pluginUrl: string,
  getJson: (url: string) => Promise<RemoteHashManifest>,
): Promise<{ plan: DiffPlan; payload: DeployPayload }> {
  const [local, remote] = await Promise.all([
    hashLocalBuild(projectPath),
    getJson(`${pluginUrl}/hashes`),
  ]);
  const setKeys = filterSetsForClass(className);
  const plan = diffManifests(local, remote, setKeys);
  const payload = await buildDeployPayload(projectPath, plan);
  return { plan, payload };
}
