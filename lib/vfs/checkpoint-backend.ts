/**
 * The backend half of a checkpoint.
 *
 * `checkpoint.ts` snapshots files and directories out of the VFS. Backend features are not files:
 * edge functions, server functions, secrets and schedules are rows the storage adapter owns, and
 * the runtime / entry point / global styles / database schema live on the project record. None of
 * it was in a checkpoint, so "Discard changes" and per-message restore did nothing for any of it.
 *
 * **Secrets hold a name, not a value.** `CheckpointSecret` is `Secret` without `value`, so a
 * checkpoint never carries cleartext and cannot leak one. The consequence is asymmetric and is the
 * reason `previewRestore` exists: a secret the project still has keeps its stored value across a
 * restore (only the name and description are written back), but one that was deleted since the
 * checkpoint comes back as an empty placeholder, and one created since is removed along with its
 * value. Both are worth telling the user about before the restore, not after.
 *
 * **What is deliberately not here.** Project name and description are identity, not content;
 * rolling a rename back out of a code turn's undo would be surprising. `hfSpace` records a Space
 * that exists on HuggingFace, so reverting it would orphan the link rather than undo anything.
 * A scheduled function's `lastRunAt` / `lastStatus` are carried because in a project record they
 * are only ever written by an import: the scheduler writes run state to a deployment's
 * runtime.sqlite (`lib/scheduler/deployment-scheduler.ts`), never here.
 */
import type {
  EdgeFunction,
  Project,
  ProjectRuntime,
  ScheduledFunction,
  Secret,
  ServerFunction,
} from './types';
import { normalizeProjectSettings } from './project-settings';
import type { StorageAdapter } from './adapters/types';
import { logger } from '@/lib/utils';

/**
 * The slice of `VirtualFileSystem` this module uses, described structurally so the backend half
 * of a checkpoint does not have to import the class it is called from.
 */
interface BackendVFS {
  getStorageAdapter(): StorageAdapter;
  getProject(projectId: string): Promise<Project>;
  updateProject(project: Project, options?: { preserveUpdatedAt?: boolean }): Promise<void>;
}

/** A secret's identity without its value. Checkpoints never hold cleartext. */
export type CheckpointSecret = Omit<Secret, 'value'>;

/**
 * The project settings a checkpoint covers. Same set the project archive treats as portable
 * content (`lib/vfs/archive/analyze.ts` `diffSettings`), minus name and description.
 */
export interface CheckpointProjectSettings {
  runtime?: ProjectRuntime;
  previewEntryPoint?: string;
  globalStyles?: string;
  databaseSchema?: string;
}

export interface CheckpointBackendSnapshot {
  edgeFunctions: EdgeFunction[];
  serverFunctions: ServerFunction[];
  secrets: CheckpointSecret[];
  scheduledFunctions: ScheduledFunction[];
  settings: CheckpointProjectSettings;
}

/** What a restore would do to stored secret values, for a warning shown before it runs. */
export interface BackendRestorePreview {
  /** In the checkpoint, gone from the project: comes back as a placeholder with no value. */
  secretsCleared: string[];
  /** Holds a value now, absent from the checkpoint: removed, and the value goes with it. */
  secretsDropped: string[];
}

export function isEmptyPreview(preview: BackendRestorePreview): boolean {
  return preview.secretsCleared.length === 0 && preview.secretsDropped.length === 0;
}

/**
 * Order-independent identity for a record, used to skip writes that would change nothing.
 * Keys are sorted because a snapshot has been through JSON and a live record has not, and absent
 * keys are treated as equal to undefined ones for the same reason: `JSON.stringify` drops
 * `{ description: undefined }`, so comparing raw would report a difference on every restore.
 */
function stableKey(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'string') {
    // A round-tripped Date arrives as its ISO string, so both sides have to spell it the same way.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .filter(k => obj[k] !== undefined && obj[k] !== null)
      .map(k => `${JSON.stringify(k)}:${stableKey(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A record's own timestamp, which JSON transport has turned into an ISO string on the way in. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The same, for a field that is genuinely optional on the record. */
function toOptionalDate(value: Date | string | undefined): Date | undefined {
  return value === undefined ? undefined : toDate(value);
}

function byId<T extends { id: string }>(records: T[]): Map<string, T> {
  return new Map(records.map(r => [r.id, r]));
}

// ── Capture ────────────────────────────────────────────────────────────

/**
 * Read the project's backend records and covered settings.
 *
 * Returns `undefined` when the adapter cannot list backend records at all — every method on
 * `StorageAdapter` in this area is optional. `undefined` means "not captured" and makes the whole
 * restore a no-op, which is also what an older checkpoint written before this existed produces.
 */
export async function captureBackend(
  vfs: BackendVFS,
  projectId: string
): Promise<CheckpointBackendSnapshot | undefined> {
  const adapter = vfs.getStorageAdapter();
  if (!adapter.listEdgeFunctions || !adapter.listServerFunctions || !adapter.listSecrets || !adapter.listScheduledFunctions) {
    return undefined;
  }

  try {
    const [edgeFunctions, serverFunctions, liveSecrets, scheduledFunctions] = await Promise.all([
      adapter.listEdgeFunctions(projectId),
      adapter.listServerFunctions(projectId),
      adapter.listSecrets(projectId),
      adapter.listScheduledFunctions(projectId),
    ]);

    const secrets: CheckpointSecret[] = liveSecrets.map(({ value: _value, ...rest }) => rest);

    const project = await vfs.getProject(projectId);
    // Normalized, so a snapshot records what the project actually has rather than `undefined` for
    // every field of settings that was stored as a JSON string.
    const source = normalizeProjectSettings(project?.settings);
    // Spelled out per field rather than looped over the key list: a loop assigns through a union
    // of keys, which only typechecks behind a cast, and four fields do not need one.
    const settings: CheckpointProjectSettings = {
      runtime: source?.runtime,
      previewEntryPoint: source?.previewEntryPoint,
      globalStyles: source?.globalStyles,
      databaseSchema: source?.databaseSchema,
    };

    return { edgeFunctions, serverFunctions, secrets, scheduledFunctions, settings };
  } catch (error) {
    // A checkpoint whose file half is good is worth keeping. Losing the backend half costs an
    // undo; throwing here would cost the user the save or the pre-generation snapshot entirely.
    logger.error('[Checkpoint] Failed to capture backend features', error);
    return undefined;
  }
}

// ── Preview ────────────────────────────────────────────────────────────

export async function previewBackendRestore(
  vfs: BackendVFS,
  snapshot: CheckpointBackendSnapshot,
  projectId: string
): Promise<BackendRestorePreview> {
  const preview: BackendRestorePreview = { secretsCleared: [], secretsDropped: [] };

  const adapter = vfs.getStorageAdapter();
  if (!adapter.listSecrets) return preview;

  const live = byId(await adapter.listSecrets(projectId));
  const snapshotIds = new Set(snapshot.secrets.map(s => s.id));

  for (const secret of snapshot.secrets) {
    // hasValue is read off the snapshot here on purpose: a placeholder that never had a value is
    // not something the user loses, so naming it in the warning would be noise.
    if (!live.has(secret.id) && secret.hasValue) preview.secretsCleared.push(secret.name);
  }
  for (const secret of live.values()) {
    if (!snapshotIds.has(secret.id) && secret.hasValue) preview.secretsDropped.push(secret.name);
  }

  preview.secretsCleared.sort();
  preview.secretsDropped.sort();
  return preview;
}

// ── Restore ────────────────────────────────────────────────────────────

/**
 * Bring the project's backend records and covered settings back to the snapshot.
 *
 * Deletions run before writes, and schedules are deleted first and written last, because a
 * scheduled function's `functionId` points at an edge function: removing the edge function first
 * would leave a schedule pointing at nothing for the length of the restore.
 *
 * Every write is compared first, so a restore that changes no backend record touches neither the
 * adapter nor the project's `updatedAt` — which the sync status reads to decide "Local newer".
 */
export async function restoreBackend(
  vfs: BackendVFS,
  snapshot: CheckpointBackendSnapshot,
  projectId: string
): Promise<void> {
  const adapter = vfs.getStorageAdapter();

  // Schedules out first: they reference edge functions.
  if (adapter.listScheduledFunctions && adapter.deleteScheduledFunction) {
    const wanted = new Set(snapshot.scheduledFunctions.map(f => f.id));
    for (const fn of await adapter.listScheduledFunctions(projectId)) {
      if (!wanted.has(fn.id)) await adapter.deleteScheduledFunction(fn.id);
    }
  }

  if (adapter.listEdgeFunctions && adapter.createEdgeFunction && adapter.updateEdgeFunction && adapter.deleteEdgeFunction) {
    const live = byId(await adapter.listEdgeFunctions(projectId));
    const wanted = new Set(snapshot.edgeFunctions.map(f => f.id));
    for (const fn of live.values()) {
      if (!wanted.has(fn.id)) await adapter.deleteEdgeFunction(fn.id);
    }
    for (const stored of snapshot.edgeFunctions) {
      const fn: EdgeFunction = {
        ...stored,
        projectId,
        createdAt: toDate(stored.createdAt),
        updatedAt: toDate(stored.updatedAt),
      };
      const current = live.get(fn.id);
      if (!current) await adapter.createEdgeFunction(fn);
      else if (stableKey(current) !== stableKey(fn)) await adapter.updateEdgeFunction(fn);
    }
  }

  if (adapter.listServerFunctions && adapter.createServerFunction && adapter.updateServerFunction && adapter.deleteServerFunction) {
    const live = byId(await adapter.listServerFunctions(projectId));
    const wanted = new Set(snapshot.serverFunctions.map(f => f.id));
    for (const fn of live.values()) {
      if (!wanted.has(fn.id)) await adapter.deleteServerFunction(fn.id);
    }
    for (const stored of snapshot.serverFunctions) {
      const fn: ServerFunction = {
        ...stored,
        projectId,
        createdAt: toDate(stored.createdAt),
        updatedAt: toDate(stored.updatedAt),
      };
      const current = live.get(fn.id);
      if (!current) await adapter.createServerFunction(fn);
      else if (stableKey(current) !== stableKey(fn)) await adapter.updateServerFunction(fn);
    }
  }

  if (adapter.listSecrets && adapter.createSecret && adapter.updateSecret && adapter.deleteSecret) {
    const live = byId(await adapter.listSecrets(projectId));
    const wanted = new Set(snapshot.secrets.map(s => s.id));
    for (const secret of live.values()) {
      if (!wanted.has(secret.id)) await adapter.deleteSecret(secret.id);
    }
    for (const stored of snapshot.secrets) {
      const current = live.get(stored.id);
      // The stored value is the project's, not the checkpoint's: a restore renames and
      // re-describes a secret the project still holds, and leaves what it decrypts to alone.
      // A secret that is not there any more can only come back empty.
      const secret: Secret = {
        ...stored,
        projectId,
        createdAt: toDate(stored.createdAt),
        updatedAt: toDate(stored.updatedAt),
        hasValue: current ? current.hasValue : false,
        value: current?.value,
      };
      if (!current) await adapter.createSecret(secret);
      else if (stableKey(current) !== stableKey(secret)) await adapter.updateSecret(secret);
    }
  }

  if (adapter.listScheduledFunctions && adapter.createScheduledFunction && adapter.updateScheduledFunction) {
    const live = byId(await adapter.listScheduledFunctions(projectId));
    for (const stored of snapshot.scheduledFunctions) {
      const fn: ScheduledFunction = {
        ...stored,
        projectId,
        createdAt: toDate(stored.createdAt),
        updatedAt: toDate(stored.updatedAt),
        lastRunAt: toOptionalDate(stored.lastRunAt),
        nextRunAt: toOptionalDate(stored.nextRunAt),
      };
      const current = live.get(fn.id);
      if (!current) await adapter.createScheduledFunction(fn);
      else if (stableKey(current) !== stableKey(fn)) await adapter.updateScheduledFunction(fn);
    }
  }

  await restoreSettings(vfs, snapshot.settings, projectId);
}

async function restoreSettings(
  vfs: BackendVFS,
  settings: CheckpointProjectSettings,
  projectId: string
): Promise<void> {
  const project = await vfs.getProject(projectId);
  if (!project) return;

  const current = normalizeProjectSettings(project.settings);
  const next = { ...current };
  let changed = false;

  // A setting the checkpoint does not carry was absent when it was taken, so restoring means
  // removing it — `delete` rather than writing undefined, so the record keeps the shape a project
  // that never had the setting would have.
  const apply = <K extends keyof CheckpointProjectSettings>(key: K) => {
    const wanted = settings[key];
    if (current[key] === wanted) return;
    changed = true;
    if (wanted === undefined) delete next[key];
    else next[key] = wanted;
  };

  /**
   * The runtime is restored when the checkpoint names one, and left alone when it does not.
   *
   * Unlike the other three, a project is never *meant* to have no runtime -- it decides how the
   * project is compiled, and absent it every consumer falls back. So "the checkpoint carries none"
   * does not distinguish a project that had no runtime from a snapshot that could not read one,
   * and older snapshots are full of the latter: capture reads `project.settings?.runtime`, which is
   * `undefined` for settings stored as a JSON string (see lib/vfs/project-settings.ts). Deleting on
   * that answer is what made a runtime look like it reset itself after an undo.
   */
  if (settings.runtime !== undefined) apply('runtime');
  apply('previewEntryPoint');
  apply('globalStyles');
  apply('databaseSchema');

  if (!changed) return;
  await vfs.updateProject({ ...project, settings: next });
}
