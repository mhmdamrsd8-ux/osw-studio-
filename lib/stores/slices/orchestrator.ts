import { StateCreator } from 'zustand';
import type { DebugEvent, GenerationTask } from '../types';
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import type { PendingImage, PendingAudio, PendingFile } from '@/lib/llm/multi-agent-orchestrator';
import { configManager } from '@/lib/config/storage';
import { getProvider } from '@/lib/llm/providers/registry';
import { toast } from 'sonner';
import { track } from '@/lib/telemetry';
import { vfs } from '@/lib/vfs';
import type { Project, ProjectRuntime } from '@/lib/vfs/types';
import type { WorkspaceMode } from './project';
import { normalizeProjectSettings } from '@/lib/vfs/project-settings';
import { debugEventsState } from '@/lib/llm/debug-events-state';
import { drainRuntimeErrors } from '@/lib/preview/runtime-errors';
import { logger } from '@/lib/utils';
import { SSEClient } from '@/lib/server-generate/sse-client';
import { handleFilesChanged, cancelPendingFileSync } from '@/lib/server-generate/file-sync-handler';
import { handleBuildRequested } from '@/lib/server-generate/build-delegation-handler';
import { handleSearchRequested } from '@/lib/server-generate/search-delegation-handler';
import { playTaskCompleteSound, playTaskCompleteSoundSubtle } from '@/lib/utils/task-complete-sound';
import { checkpointManager } from '@/lib/vfs/checkpoint';
import { saveManager } from '@/lib/vfs/save-manager';
import { getProjectAssignment } from '@/lib/llm/models/project-assignment';
import type { InterviewTemplate } from '@/lib/interview/types';
import type { ApprovalRequest, ApprovalOutcome } from '@/lib/llm/permissions';

const MAX_DEBUG_EVENTS = 2000;
let debugIdCounter = 0;

const persistProjectIds = new Map<string, string>();
const saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Batched delta flushing — accumulates coalesced deltas and flushes once per animation frame
let pendingDeltaFlush: number | null = null;
const pendingDeltas = new Map<string, { eventId: string; fragments: any[] }>();

// When the user views a different project while generation runs, events accumulate
// here instead of in the store's debugEvents (which shows the viewed project's history).
const backgroundEventsMap = new Map<string, DebugEvent[]>();

let reattaching = false;
const dismissedServerProjects = new Set<string>();
type QueuedApproval = { req: ApprovalRequest; projectId: string; resolve: (o: ApprovalOutcome) => void };
let approvalQueue: QueuedApproval[] = [];

function isServerMode(): boolean {
  if (typeof window === 'undefined') return false;
  return process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
}

async function pullAndCheckpointServerFiles(
  projectId: string,
  get: () => CombinedState,
) {
  const { getSyncManager } = await import('@/lib/vfs/sync-manager');
  const syncMgr = getSyncManager();
  const pullResult = await syncMgr.pullProjectWithFiles(projectId);
  if (!pullResult.success || !pullResult.project || !pullResult.files) return;

  // Merge the server's fields into the local record instead of writing the JSON response straight
  // back: that response carries ISO strings, and a string lastSyncedAt makes every later status
  // comparison read 'synced' regardless of how far the copies have drifted.
  const serverProject = pullResult.project;
  const serverUpdatedAt = serverProject.updatedAt ? new Date(serverProject.updatedAt) : new Date();
  // getProject throws when the record is gone — the project can be deleted while a server
  // generation is still running. Fall back to the server's copy so the pulled files still land
  // somewhere instead of the whole sync being skipped.
  let target: Project;
  try {
    target = await vfs.getProject(projectId);
  } catch {
    target = {
      ...serverProject,
      createdAt: serverProject.createdAt ? new Date(serverProject.createdAt) : serverUpdatedAt,
    };
  }
  target.name = serverProject.name;
  target.description = serverProject.description;
  // Straight from a JSON response; normalized for the same reason the pull path does it.
  if (serverProject.settings) target.settings = normalizeProjectSettings(serverProject.settings);
  target.updatedAt = serverUpdatedAt;
  target.lastSyncedAt = new Date();
  target.serverUpdatedAt = serverUpdatedAt;
  target.syncStatus = 'synced';
  await vfs.updateProject(target, { preserveUpdatedAt: true });
  const existingFiles = await vfs.getAllFilesAndDirectories(projectId);
  const existingFilePaths = new Set(
    existingFiles
      .filter((f): f is import('@/lib/vfs/types').VirtualFile => !('type' in f && f.type === 'directory'))
      .map(f => f.path)
  );
  for (const file of pullResult.files) {
    if (existingFilePaths.has(file.path)) {
      await vfs.updateFile(projectId, file.path, file.content, { silent: true });
    } else {
      await vfs.createFile(projectId, file.path, file.content, { silent: true });
    }
  }
  const serverPaths = new Set(pullResult.files.map(f => f.path));
  for (const p of existingFilePaths) {
    if (!serverPaths.has(p)) {
      try { await vfs.deleteFile(projectId, p, { silent: true }); } catch {}
    }
  }
  try {
    const cp = await checkpointManager.createCheckpoint(projectId, 'After server generation', { kind: 'auto' });
    get().addDebugEvent('checkpoint_created', {
      checkpointId: cp.id, description: cp.description, timestamp: cp.timestamp,
    }, projectId);
  } catch (cpErr) {
    logger.warn('[ServerGen] Post-generation checkpoint failed:', cpErr);
  }
  if (get().projectId === projectId) {
    window.dispatchEvent(new Event('filesChanged'));
    get().markDirty();
    get().bumpRefreshTrigger();
  }
}

function debouncedSave(projectId: string, events: DebugEvent[]) {
  if (!persistProjectIds.has(projectId)) return;
  const existing = saveDebounceTimers.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    Promise.resolve(debugEventsState.saveEvents(projectId, events)).catch(error => {
      logger.error('Failed to persist debug events:', error);
    });
  }, 500);
  saveDebounceTimers.set(projectId, timer);
}

function flushSave(projectId: string, events: DebugEvent[]) {
  const existing = saveDebounceTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    saveDebounceTimers.delete(projectId);
  }
  Promise.resolve(debugEventsState.saveEvents(projectId, events)).catch(error => {
    logger.error('Failed to flush debug events:', error);
  });
}

function isTabVisible(): boolean {
  return typeof document !== 'undefined' && !document.hidden;
}

function deriveScalarFields(tasks: Map<string, GenerationTask>, viewedProjectId: string) {
  const viewedTask = tasks.get(viewedProjectId);
  return {
    generating: viewedTask?.result === null ? true : false,
  };
}

interface StartGenerationOptions {
  chatMode?: boolean;
  mode?: WorkspaceMode;
  projectId: string;
  focusContext?: any;
  placedBlocks?: any[];
  isTourLockingInput?: boolean;
  displayPrompt?: string;
  templateId?: string;
  audio?: PendingAudio[];
  files?: PendingFile[];
}

export interface OrchestratorSlice {
  generationTasks: Map<string, GenerationTask>;
  debugEvents: DebugEvent[];
  currentModel: string;
  projectCost: number;
  sseClient: SSEClient | null;

  generating: boolean;

  isProjectGenerating: (projectId: string) => boolean;
  isAnyGenerating: () => boolean;

  // Event methods
  addDebugEvent: (event: string, data: any, sourceProjectId?: string) => void;
  clearDebugEvents: () => void;
  getGenerationEvents: (projectId?: string) => DebugEvent[];

  // Generation lifecycle
  /**
   * Start a run for a project.
   *
   * Resolves `false` when nothing was started — the project already had a task, no model or key is
   * configured, the prompt was empty, the tour holds the input. Callers need that: the post-send
   * cleanup (spending the selection's inclusion, dropping attachments and placed blocks) must not
   * run for a request that was never sent.
   *
   * In browser mode it resolves when the run *finishes*, which is what makes that cleanup
   * post-generation. In server mode it resolves once the task is accepted.
   */
  startGeneration: (message: string, images?: PendingImage[], options?: StartGenerationOptions) => Promise<boolean>;
  stopGeneration: (projectId?: string) => void | Promise<void>;
  connectSSE: () => void;
  disconnectSSE: () => void;
  startServerGeneration: (projectId: string, prompt: string, chatMode: boolean, images?: PendingImage[], options?: StartGenerationOptions) => Promise<boolean>;
  continueGeneration: () => void;
  resetOrchestrator: () => void;

  // Settings
  setCurrentModel: (model: string) => void;
  setProjectCost: (cost: number) => void;

  // Persistence
  stashForegroundEvents: (projectId: string) => void;
  loadDebugEvents: (projectId: string) => Promise<void>;
  clearChat: (projectId: string) => Promise<void>;
  initPersistence: (projectId: string) => void;
  cleanupPersistence: () => void;
  dismissGenerationResult: (projectId?: string) => void;
  reattachServerTasks: () => Promise<void>;

  // Permission approval gate
  pendingApproval: { req: ApprovalRequest; projectId: string } | null;
  _provideApprovalCallback: (projectId: string) => (req: ApprovalRequest) => Promise<ApprovalOutcome>;
  resolveApproval: (outcome: ApprovalOutcome) => void;
  clearPendingApprovals: () => void;
}

/**
 * Shown when a start is refused because the project already has a task. Exported because the UI
 * paths that turn a gesture down for the same reason (a restore, a retry, starting an interview)
 * have to say the same thing.
 */
export const PROJECT_BUSY_NOTICE = 'Still working on the last change. Wait for it to finish, or stop it first.';

type CombinedState = OrchestratorSlice & {
  projectId: string;
  projectName: string;
  workspaceReady: boolean;
  markDirty: () => void;
  bumpRefreshTrigger: () => void;
  updateProjectSettings: (settings: { runtime?: ProjectRuntime }) => void;
};

export const createOrchestratorSlice: StateCreator<CombinedState, [], [], OrchestratorSlice> = (set, get) => ({
  generationTasks: new Map<string, GenerationTask>(),
  debugEvents: [],
  currentModel: '',
  projectCost: 0,
  sseClient: null,
  generating: false,
  pendingApproval: null,

  _provideApprovalCallback: (projectId: string) => (req: ApprovalRequest) =>
    new Promise<ApprovalOutcome>((resolve) => {
      approvalQueue.push({ req, projectId, resolve });
      // Only surface + sound when this is the front of the queue (nothing else pending).
      if (approvalQueue.length === 1) {
        set({ pendingApproval: { req, projectId } });
        playTaskCompleteSoundSubtle(); // single-note request sound
      }
    }),

  resolveApproval: (outcome: ApprovalOutcome) => {
    const current = approvalQueue.shift();
    current?.resolve(outcome);
    const next = approvalQueue[0];
    if (next) {
      set({ pendingApproval: { req: next.req, projectId: next.projectId } });
      playTaskCompleteSoundSubtle(); // announce the next pending request
    } else {
      set({ pendingApproval: null });
    }
  },

  clearPendingApprovals: () => {
    const queued = approvalQueue;
    approvalQueue = [];
    set({ pendingApproval: null });
    queued.forEach((a) => a.resolve('deny'));
  },

  isProjectGenerating: (projectId: string) => {
    const task = get().generationTasks.get(projectId);
    return task?.result === null ? true : false;
  },

  isAnyGenerating: () => {
    for (const task of get().generationTasks.values()) {
      if (task.result === null) return true;
    }
    return false;
  },

  addDebugEvent: (event: string, data: any, sourceProjectId?: string) => {
    const { projectId } = get();
    const source = sourceProjectId ?? projectId;
    const isBackground = source !== projectId;
    const shouldCoalesce = event === 'assistant_delta' || event === 'tool_param_delta' || event === 'reasoning_delta';

    const debugEvent: DebugEvent = {
      id: `${Date.now()}-${debugIdCounter++}`,
      timestamp: Date.now(),
      event,
      data,
      count: 1,
      version: 1,
    };

    if (isBackground) {
      let buffer = backgroundEventsMap.get(source) ?? [];
      if (shouldCoalesce && buffer.length > 0) {
        const searchLimit = Math.max(0, buffer.length - 4);
        for (let i = buffer.length - 1; i >= searchLimit; i--) {
          if (buffer[i].event === event) {
            const target = buffer[i];
            const all = target.data.all ?? [target.data];
            all.push(data);
            buffer[i] = {
              ...target,
              timestamp: Date.now(),
              version: target.version + 1,
              count: target.count + 1,
              data: { all },
            };
            backgroundEventsMap.set(source, buffer);
            debouncedSave(source, buffer);
            return;
          }
        }
      }
      buffer.push(debugEvent);
      if (buffer.length > MAX_DEBUG_EVENTS) {
        buffer = buffer.slice(-MAX_DEBUG_EVENTS);
      }
      backgroundEventsMap.set(source, buffer);
      debouncedSave(source, buffer);
      return;
    }

    // For delta events in the foreground, batch updates to avoid per-chunk React re-renders
    if (shouldCoalesce) {
      // Find the target event id to coalesce into
      const prev = get().debugEvents;
      let targetId: string | null = null;
      const searchLimit = Math.max(0, prev.length - 4);
      for (let i = prev.length - 1; i >= searchLimit; i--) {
        if (prev[i].event === event) {
          targetId = prev[i].id;
          break;
        }
      }

      if (targetId) {
        // Accumulate in the pending buffer — no Zustand set() yet
        let pending = pendingDeltas.get(targetId);
        if (!pending) {
          pending = { eventId: targetId, fragments: [] };
          pendingDeltas.set(targetId, pending);
        }
        pending.fragments.push(data);
      } else {
        // First delta of its kind — add the event, then future deltas coalesce into it
        set(state => {
          let newEvents = [...state.debugEvents, debugEvent];
          if (newEvents.length > MAX_DEBUG_EVENTS) newEvents = newEvents.slice(-MAX_DEBUG_EVENTS);
          return { debugEvents: newEvents };
        });
      }

      // Flush pending deltas into Zustand state
      const flushPendingDeltas = () => {
        if (pendingDeltas.size === 0) return;
        set(state => {
          const events = [...state.debugEvents];
          for (const [eventId, pending] of pendingDeltas) {
            let idx = -1;
            for (let i = events.length - 1; i >= Math.max(0, events.length - 10); i--) {
              if (events[i].id === eventId) { idx = i; break; }
            }
            if (idx === -1) continue;
            const target = events[idx];
            const existingAll = target.data.all ?? [target.data];
            const all = [...existingAll, ...pending.fragments];
            events[idx] = {
              ...target,
              timestamp: Date.now(),
              version: target.version + pending.fragments.length,
              count: target.count + pending.fragments.length,
              data: { all },
            };
          }
          pendingDeltas.clear();
          return { debugEvents: events };
        });
        debouncedSave(source, get().debugEvents);
      };

      if (typeof requestAnimationFrame !== 'undefined') {
        if (pendingDeltaFlush === null) {
          pendingDeltaFlush = requestAnimationFrame(() => {
            pendingDeltaFlush = null;
            flushPendingDeltas();
          });
        }
      } else {
        flushPendingDeltas();
      }
      return;
    }

    // Non-delta events: flush any pending deltas first, then add the new event
    if (pendingDeltas.size > 0) {
      if (pendingDeltaFlush !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(pendingDeltaFlush);
        pendingDeltaFlush = null;
      }
      // Inline flush
      set(state => {
        const events = [...state.debugEvents];
        for (const [eventId, pending] of pendingDeltas) {
          let idx = -1;
          for (let i = events.length - 1; i >= Math.max(0, events.length - 10); i--) {
            if (events[i].id === eventId) { idx = i; break; }
          }
          if (idx === -1) continue;
          const target = events[idx];
          const existingAll = target.data.all ?? [target.data];
          const all = [...existingAll, ...pending.fragments];
          events[idx] = {
            ...target,
            timestamp: Date.now(),
            version: target.version + pending.fragments.length,
            count: target.count + pending.fragments.length,
            data: { all },
          };
        }
        pendingDeltas.clear();
        return { debugEvents: events };
      });
    }

    set(state => {
      let newEvents = [...state.debugEvents, debugEvent];
      if (newEvents.length > MAX_DEBUG_EVENTS) {
        newEvents = newEvents.slice(-MAX_DEBUG_EVENTS);
      }
      return { debugEvents: newEvents };
    });
    debouncedSave(source, get().debugEvents);
  },

  clearDebugEvents: () => {
    set({ debugEvents: [] });
  },

  getGenerationEvents: (projectId?: string) => {
    const target = projectId ?? get().projectId;
    const viewedProjectId = get().projectId;
    const buffer = backgroundEventsMap.get(target);
    if (target !== viewedProjectId && buffer && buffer.length > 0) {
      return buffer;
    }
    return get().debugEvents;
  },

  startGeneration: async (message: string, images?: PendingImage[], options?: StartGenerationOptions) => {
    if (options?.isTourLockingInput) return false;

    const projectId = options?.projectId || '';

    // One task per project. Tasks are stored by project id, so a second start would take the slot
    // and leave the first running where Stop can no longer reach it; on the server that orphan then
    // finishes and lands changes the client sees as another device's. The guard has to sit ahead of
    // both paths.
    if (get().isProjectGenerating(projectId)) {
      toast.info(PROJECT_BUSY_NOTICE);
      return false;
    }

    if (isServerMode()) {
      return get().startServerGeneration(projectId, message.trim(), !!options?.chatMode, images, options);
    }

    drainRuntimeErrors();

    const trimmedPrompt = message.trim();
    const hasAttachments = !!(images?.length || options?.audio?.length || options?.files?.length);
    if (!trimmedPrompt && !hasAttachments) {
      toast.error('Please enter a prompt');
      return false;
    }

    const chatMode = options?.chatMode ?? false;
    const projectName = get().projectName || 'Untitled';

    // Create the GenerationTask entry synchronously so `generating=true` is
    // visible before any async work. Model is filled in after assignment resolves.
    const newTask: GenerationTask = {
      projectId,
      projectName,
      prompt: trimmedPrompt,
      model: '',
      startedAt: Date.now(),
      result: null,
      paused: false,
      pausedMessage: null,
      orchestratorInstance: null,
      persistedInstance: get().generationTasks.get(projectId)?.persistedInstance ?? null,
    };

    const newTasks = new Map(get().generationTasks);
    newTasks.set(projectId, newTask);
    set({
      generationTasks: newTasks,
      ...deriveScalarFields(newTasks, get().projectId),
    });

    // Register persist target before any saves
    persistProjectIds.set(projectId, projectId);

    // Resolve the assignment (async). The task is already in the map, so the
    // synchronous isProjectGenerating() guard above prevents a double-start
    // across this await. The generating=true event is emitted only after the
    // guards pass (below): emitting it here would leave listeners stuck
    // "generating" if a guard then fails (cleanup dispatches no false event).
    let assignment;
    try {
      assignment = await getProjectAssignment();
    } catch (err) {
      // Resolution failed (e.g. no model template could be created) — clean up the
      // pre-created task so it doesn't leave the project stuck "generating".
      const cancelTasks = new Map(get().generationTasks);
      cancelTasks.delete(projectId);
      set({ generationTasks: cancelTasks, ...deriveScalarFields(cancelTasks, get().projectId) });
      logger.error('[Orchestrator] Failed to resolve project model assignment:', err);
      toast.error('Could not resolve this project\'s model configuration. Check your provider settings.');
      return false;
    }
    const currentProvider = assignment.agent.provider;
    const providerConfig = getProvider(currentProvider);
    const apiKey = configManager.getProviderApiKey(currentProvider);

    if (providerConfig.apiKeyRequired && !apiKey && !providerConfig.usesOAuth) {
      // Clean up the task we pre-created
      const cancelTasks = new Map(get().generationTasks);
      cancelTasks.delete(projectId);
      set({ generationTasks: cancelTasks, ...deriveScalarFields(cancelTasks, get().projectId) });
      toast.error(`Please set your ${providerConfig.name} API key in settings`);
      return false;
    }

    if (providerConfig.isLocal) {
      if (!assignment.agent.model) {
        const cancelTasks = new Map(get().generationTasks);
        cancelTasks.delete(projectId);
        set({ generationTasks: cancelTasks, ...deriveScalarFields(cancelTasks, get().projectId) });
        toast.error(`No model selected for ${providerConfig.name}. Please select a model in settings.`);
        return false;
      }
    }

    const modelToUse = assignment.agent.model;

    if (!modelToUse) {
      const cancelTasks = new Map(get().generationTasks);
      cancelTasks.delete(projectId);
      set({ generationTasks: cancelTasks, ...deriveScalarFields(cancelTasks, get().projectId) });
      toast.error(`No model selected. Please select a model in settings.`);
      return false;
    }

    // Backfill model into the task now that we have it
    const tasksWithModel = new Map(get().generationTasks);
    const pendingTask = tasksWithModel.get(projectId);
    if (pendingTask) {
      tasksWithModel.set(projectId, { ...pendingTask, model: modelToUse });
      set({ generationTasks: tasksWithModel, currentModel: modelToUse, ...deriveScalarFields(tasksWithModel, get().projectId) });
    }

    // Generation is committed (guards passed) — signal listeners (e.g. the
    // console suppresses preview auto-run while generating). Failed guards above
    // returned without emitting this, so listeners never get stuck "generating".
    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent('generationStateChanged', { detail: { generating: true, projectId } }));
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    track('task_started', { provider: currentProvider, model: modelToUse, task_id: taskId });
    const taskStartTime = Date.now();

    // Project-scoped progress callback
    const progressCallback = (event: string, data: any) => {
      get().addDebugEvent(event, data, projectId);
      const isViewingThis = get().projectId === projectId;
      if (event === 'tool_status' && data?.status === 'completed' && isViewingThis) {
        // Mark the session dirty on any tool completion, but do NOT force a preview recompile here:
        // a read-only command (rg, grep, cat, ls, …) must not reload the preview. Actual file writes
        // dispatch 'filesChanged' from the VFS, which the preview already listens to, so writes still
        // recompile — only reads stop triggering a needless reload.
        get().markDirty();
      }
      if (event === 'usage' && data?.totalCost != null && isViewingThis) {
        set({ projectCost: data.totalCost });
      }
      if (event === 'runtimeChanged' && data?.runtime && isViewingThis) {
        get().updateProjectSettings({ runtime: data.runtime });
      }
      if (event === 'error_paused') {
        const tasks = new Map(get().generationTasks);
        const t = tasks.get(projectId);
        if (t) {
          tasks.set(projectId, { ...t, paused: true, pausedMessage: data?.message || 'API error' });
          set({ generationTasks: tasks });
        }
      }
      if (event === 'iteration' || event === 'tool_status') {
        const t = get().generationTasks.get(projectId);
        if (t?.paused) {
          const tasks = new Map(get().generationTasks);
          tasks.set(projectId, { ...t, paused: false, pausedMessage: null });
          set({ generationTasks: tasks });
        }
      }
    };

    try {
      let orchestrator = newTask.persistedInstance;

      if (!orchestrator) {
        let interviewTemplate: InterviewTemplate | undefined;
        if (options?.mode === 'interview' && options?.templateId) {
          const { interviewTemplatesService } = await import('@/lib/interview/templates-service');
          interviewTemplate = (await interviewTemplatesService.getTemplate(options.templateId)) ?? undefined;
        }

        orchestrator = new MultiAgentOrchestrator(
          projectId,
          options?.mode === 'interview' ? 'interview' : 'orchestrator',
          progressCallback,
          { chatMode, model: modelToUse, assignment, interviewTemplateId: options?.templateId, interviewTemplate, onApprovalNeeded: get()._provideApprovalCallback(projectId) },
        );

        // Only bootstrap conversation if viewing this project.
        // Compaction rewrites the conversation via a conversation_replaced
        // event — rebuild from the last one so the compacted context (with its
        // summary) is restored instead of the full pre-compaction history.
        if (get().projectId === projectId) {
          const events = get().debugEvents;
          let baseMessages: unknown[] = [];
          let replacedIdx = -1;
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].event === 'conversation_replaced') {
              baseMessages = (events[i].data?.messages as unknown[]) ?? [];
              replacedIdx = i;
              break;
            }
          }
          const subsequentMessages = events
            .slice(replacedIdx + 1)
            .filter(event => event.event === 'conversation_message')
            .map(event => event.data.message);
          const conversationMessages = [...baseMessages, ...subsequentMessages];

          if (conversationMessages.length > 0) {
            orchestrator.importConversation(conversationMessages);
          }
        }
      }

      // Update task with orchestrator instances
      const tasksWithOrch = new Map(get().generationTasks);
      const currentTask = tasksWithOrch.get(projectId);
      if (currentTask) {
        tasksWithOrch.set(projectId, { ...currentTask, orchestratorInstance: orchestrator, persistedInstance: orchestrator });
        set({ generationTasks: tasksWithOrch, ...deriveScalarFields(tasksWithOrch, get().projectId) });
      }

      const imageData = images?.map(img => ({ data: img.data, mediaType: img.mediaType }));
      const executeOptions: Record<string, any> = {};
      if (imageData?.length) executeOptions.images = imageData;
      if (options?.audio?.length) {
        executeOptions.audio = options.audio.map(a => ({ data: a.data, format: a.format, transcript: a.transcript }));
        executeOptions.voiceInput = assignment.voiceInput;
      }
      if (options?.files?.length) executeOptions.files = options.files.map(f => ({ name: f.name, content: f.content }));

      const result = await orchestrator.execute(
        trimmedPrompt,
        Object.keys(executeOptions).length > 0 ? executeOptions : undefined,
      );

      if (result.success) {
        if (vfs.hasServerContext()) {
          await vfs.refreshServerContext();
        }
        // awaiting_user is a pause (e.g. interview question, ask chips), not a
        // completion — clean up the task but skip the completion toast/sounds.
        const awaitingUser = result.exitReason === 'awaiting_user';
        track('task_complete', {
          provider: currentProvider, model: modelToUse,
          duration_ms: Date.now() - taskStartTime, task_id: taskId,
          tool_count: result.toolCount ?? 0, turn_count: result.turnCount ?? 0,
          api_error_count: result.apiErrorCount ?? 0,
        });

        const isForeground = isTabVisible() && get().projectId === projectId;
        const successTasks = new Map(get().generationTasks);
        if (isForeground) {
          successTasks.delete(projectId);
        } else {
          const successTask = successTasks.get(projectId);
          if (successTask) {
            successTasks.set(projectId, { ...successTask, result: 'completed' });
          }
          if (!awaitingUser) playTaskCompleteSound();
        }
        set({ generationTasks: successTasks, ...deriveScalarFields(successTasks, get().projectId) });
        if (isForeground && !awaitingUser) playTaskCompleteSound();
        if (!awaitingUser) toast.success('Task completed');
      } else {
        // User-initiated stops are not failures: stopGeneration already
        // tracked task_fail (reason: stopped) and the user expects no error.
        const wasStopped = result.exitReason === 'stopped' || result.exitReason === 'error_stop';
        if (!wasStopped) {
          track('task_fail', {
            provider: currentProvider, model: modelToUse, reason: 'api_error',
            duration_ms: Date.now() - taskStartTime, task_id: taskId,
            tool_count: result.toolCount ?? 0, turn_count: result.turnCount ?? 0,
            api_error_count: result.apiErrorCount ?? 0,
          });
        }

        const failForeground = isTabVisible() && get().projectId === projectId;
        const failTasks = new Map(get().generationTasks);
        if (failForeground) {
          failTasks.delete(projectId);
        } else {
          const failTask = failTasks.get(projectId);
          if (failTask) {
            failTasks.set(projectId, { ...failTask, result: 'failed' });
          }
        }
        set({ generationTasks: failTasks, ...deriveScalarFields(failTasks, get().projectId) });
        if (!wasStopped) {
          toast.error(result.summary || 'Generation failed', { duration: 5000, position: 'bottom-center' });
        }
      }
    } catch (error) {
      logger.error('Generation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate';
      track('task_fail', {
        provider: currentProvider, model: modelToUse, reason: 'api_error',
        duration_ms: Date.now() - taskStartTime, task_id: taskId,
      });

      const errorForeground = isTabVisible() && get().projectId === projectId;
      const errorTasks = new Map(get().generationTasks);
      if (errorForeground) {
        errorTasks.delete(projectId);
      } else {
        const errorTask = errorTasks.get(projectId);
        if (errorTask) {
          errorTasks.set(projectId, { ...errorTask, result: 'failed' });
        }
      }
      set({ generationTasks: errorTasks, ...deriveScalarFields(errorTasks, get().projectId) });
      get().addDebugEvent('error', { message: errorMessage }, projectId);
      toast.error(errorMessage, { duration: 5000, position: 'bottom-center' });
    } finally {
      // Clear orchestratorInstance but keep persistedInstance
      const finalTasks = new Map(get().generationTasks);
      const finalTask = finalTasks.get(projectId);
      if (finalTask) {
        finalTasks.set(projectId, { ...finalTask, orchestratorInstance: null });
        set({ generationTasks: finalTasks, ...deriveScalarFields(finalTasks, get().projectId) });
      }

      // Flush buffered events
      const buffer = backgroundEventsMap.get(projectId);
      if (buffer && buffer.length > 0) {
        flushSave(projectId, buffer);
      } else {
        flushSave(projectId, get().debugEvents);
      }
      backgroundEventsMap.delete(projectId);

      if (typeof globalThis.dispatchEvent === 'function') {
        globalThis.dispatchEvent(new CustomEvent('generationStateChanged', { detail: { generating: false, projectId } }));
      }
    }

    // Reached only by a run that started. Whether it then succeeded, failed or was stopped is the
    // task's `result`, which the caller reads separately; this says the request was accepted.
    return true;
  },

  stopGeneration: async (projectId?: string) => {
    const targetId = projectId ?? get().projectId;
    const task = get().generationTasks.get(targetId);

    // Release any waiting approval promises so gated sub-agents don't hang.
    get().clearPendingApprovals();

    if (task?.serverTaskId) {
      // Soft stop: abort the current inference and let the server emit task_complete. When the
      // server says there is no live loop to stop, no such event is coming, and waiting for it
      // would leave the task marked as running for good; that case is closed locally below.
      let serverWillComplete = false;
      try {
        const response = await fetch('/api/server-generate/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: task.serverTaskId }),
        });
        const body = response.ok ? await response.json().catch(() => ({})) : {};
        serverWillComplete = response.ok && body.hadOrchestrator === true;
      } catch {
        serverWillComplete = false;
      }
      if (serverWillComplete) return;
    }

    if (task?.orchestratorInstance) {
      task.orchestratorInstance.stop();
      track('task_fail', {
        provider: configManager.getSelectedProvider(),
        model: get().currentModel || configManager.getDefaultModel(),
        reason: 'stopped',
        duration_ms: task ? Date.now() - task.startedAt : undefined,
        task_id: targetId,
      });
    }
    if (task) {
      const newTasks = new Map(get().generationTasks);
      newTasks.set(targetId, { ...task, result: 'failed', orchestratorInstance: null });
      set({ generationTasks: newTasks, ...deriveScalarFields(newTasks, get().projectId) });
    }
    // Flush buffered events
    const buffer = backgroundEventsMap.get(targetId);
    if (buffer && buffer.length > 0) flushSave(targetId, buffer);
    // Dispatch event
    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent('generationStateChanged', { detail: { generating: false, projectId: targetId } }));
    }
  },

  continueGeneration: () => {
    const task = get().generationTasks.get(get().projectId);
    if (task?.orchestratorInstance) {
      task.orchestratorInstance.continue();
      toast.info('Resuming task...');
    }
  },

  resetOrchestrator: () => {
    const viewedId = get().projectId;
    if (get().isProjectGenerating(viewedId)) return;
    const newTasks = new Map(get().generationTasks);
    const task = newTasks.get(viewedId);
    if (task) {
      newTasks.set(viewedId, { ...task, orchestratorInstance: null, persistedInstance: null });
      set({ generationTasks: newTasks });
    }
  },

  setCurrentModel: (model: string) => set({ currentModel: model }),

  setProjectCost: (cost: number) => set({ projectCost: cost }),

  stashForegroundEvents: (projectId: string) => {
    if (!get().isProjectGenerating(projectId)) return;
    const events = get().debugEvents;
    if (events.length > 0) {
      backgroundEventsMap.set(projectId, [...events]);
    }
  },

  loadDebugEvents: async (projectId: string) => {
    // Re-derive scalar fields for the new viewed project
    set(deriveScalarFields(get().generationTasks, projectId));

    // Opening a project counts as seeing its result: implicitly dismiss a terminal (completed/
    // failed/unavailable) background task for it, so the shelf popup doesn't reappear on the
    // projects list / menu after the user has viewed it. No-ops for a still-running task, so live
    // background generations keep showing until they finish.
    get().dismissGenerationResult(projectId);

    // Background buffer takes priority — SSE replay may have populated it while
    // the user was on another page (e.g. project list during reattach).
    // Persist to IDB before deleting so StrictMode double-calls find fresh data.
    const buffer = backgroundEventsMap.get(projectId);
    if (buffer && buffer.length > 0) {
      backgroundEventsMap.delete(projectId);
      set({ debugEvents: buffer });
      try { debugEventsState.saveEvents(projectId, buffer)?.catch?.(() => {}); } catch {}
      return;
    }

    // If actively generating, in-memory debugEvents are already authoritative.
    if (get().isProjectGenerating(projectId)) return;

    try {
      const savedEvents = await debugEventsState.loadEvents(projectId);
      if (savedEvents.length > 0) {
        const normalized: DebugEvent[] = savedEvents.map(e => ({
          ...e,
          count: (e as any).count ?? 1,
          version: (e as any).version ?? 1,
        }));
        set({ debugEvents: normalized });
      } else {
        set({ debugEvents: [] });
      }
    } catch (error) {
      logger.error('Failed to load debug events:', error);
    }
  },

  clearChat: async (projectId: string) => {
    const newTasks = new Map(get().generationTasks);
    const task = newTasks.get(projectId);
    if (task) {
      newTasks.set(projectId, { ...task, persistedInstance: null });
      set({ debugEvents: [], generationTasks: newTasks });
    } else {
      set({ debugEvents: [] });
    }
    try {
      await debugEventsState.clearEvents(projectId);
    } catch (error) {
      logger.error('Failed to clear debug events:', error);
    }
  },

  initPersistence: (projectId: string) => {
    for (const task of get().generationTasks.values()) {
      if (task.result === null) persistProjectIds.set(task.projectId, task.projectId);
    }
    persistProjectIds.set(projectId, projectId);
  },

  cleanupPersistence: () => {
    const viewedId = get().projectId;
    const timer = saveDebounceTimers.get(viewedId);
    if (timer) { clearTimeout(timer); saveDebounceTimers.delete(viewedId); }
    persistProjectIds.delete(viewedId);
  },

  connectSSE: () => {
    if (get().sseClient) return;

    const client = new SSEClient({
      // A restarted server has no in-memory event buffer. Re-checking status on
      // each successful connection turns a recovered terminal task into UI state.
      onConnect: () => { get().reattachServerTasks(); },
      onEvent: (event, data) => {
        const projectId = data.sourceProjectId as string;
        if (event === 'files_changed') {
          handleFilesChanged(data as any).then(() => {
            if (get().projectId === projectId) {
              get().markDirty();
              get().bumpRefreshTrigger();
            }
          });
          return;
        }
        if (event === 'build_requested') {
          handleBuildRequested(data as any);
          return;
        }
        if (event === 'search_requested') {
          handleSearchRequested(data as any);
          return;
        }
        if (event === 'task_complete') {
          cancelPendingFileSync();

          // awaiting_user is a pause (e.g. a gated command awaiting the user's Allow/Deny), not a
          // finish — the approval prompt is already in the chat. Don't celebrate or pull files.
          const awaitingUser = data.exitReason === 'awaiting_user';

          const tasks = new Map(get().generationTasks);
          const task = [...tasks.values()].find((t) => t.serverTaskId && t.projectId === projectId && t.result === null);
          if (task) {
            const result = data.result === 'success' || data.result === 'stopped'
              ? 'completed' as const
              : 'failed' as const;
            const serverForeground = isTabVisible() && get().projectId === projectId && get().workspaceReady;
            if (serverForeground) {
              dismissedServerProjects.add(task.projectId);
              tasks.delete(task.projectId);
            } else {
              tasks.set(task.projectId, { ...task, result, orchestratorInstance: null });
            }
            set({ generationTasks: tasks, ...deriveScalarFields(tasks, get().projectId) });
            if (result === 'completed') {
              if (data.result !== 'stopped' && !awaitingUser) {
                playTaskCompleteSound();
              }
              if (!awaitingUser) {
                toast.success(data.result === 'stopped' ? 'Task stopped' : 'Task completed');
                pullAndCheckpointServerFiles(projectId, get).catch(err => {
                  logger.warn('[ServerGen] Post-completion pull failed:', err);
                });
              }
            } else if (data.error) {
              toast.error(String(data.error), { duration: 5000 });
            }
          }
          get().addDebugEvent(event, data, projectId);
          return;
        }
        if (event === 'usage') {
          if (data.totalCost != null && get().projectId === projectId) {
            set({ projectCost: data.totalCost as number });
          }
          // Don't return — let it fall through to addDebugEvent so chat panel gets usage info
        }

        // Suppress server-side duplicates of events the client already added locally
        if (event === 'conversation_message') {
          const role = (data as any).message?.role;
          if (role === 'system') return; // System prompt is internal, client doesn't render it
          if (role === 'user') {
            const localIdx = get().debugEvents.findLastIndex(
              (e) => e.event === 'conversation_message' && e.data?.message?.role === 'user'
            );
            if (localIdx >= 0) {
              const serverMeta = (data as any).message?.ui_metadata;
              if (serverMeta?.projectContext) {
                set((state) => {
                  const events = [...state.debugEvents];
                  const existing = { ...events[localIdx] };
                  existing.data = {
                    ...existing.data,
                    message: { ...existing.data.message, ui_metadata: { ...existing.data.message?.ui_metadata, ...serverMeta } },
                  };
                  existing.version = (existing.version ?? 1) + 1;
                  events[localIdx] = existing;
                  return { debugEvents: events };
                });
              }
              return;
            }
          }
        }

        // Client already adds 'waiting' in startServerGeneration — skip the server's copy.
        // Only dedup for the currently viewed project; background events must pass through.
        if (event === 'waiting' && get().projectId === projectId) {
          const events = get().debugEvents;
          for (let i = events.length - 1; i >= Math.max(0, events.length - 3); i--) {
            if (events[i].event === 'waiting') return;
            if (events[i].event === 'conversation_message' && events[i].data?.message?.role === 'user') break;
          }
        }

        get().addDebugEvent(event, data, projectId);

        const isViewingThis = get().projectId === projectId;
        if (event === 'error_paused') {
          const tasks = new Map(get().generationTasks);
          const t = [...tasks.values()].find((tt) => tt.serverTaskId && tt.projectId === projectId);
          if (t) {
            tasks.set(projectId, { ...t, paused: true, pausedMessage: (data?.message as string) || 'API error' });
            set({ generationTasks: tasks });
          }
        }
        if ((event === 'iteration' || event === 'tool_status') && isViewingThis) {
          const t = get().generationTasks.get(projectId);
          if (t?.paused) {
            const tasks = new Map(get().generationTasks);
            tasks.set(projectId, { ...t, paused: false, pausedMessage: null });
            set({ generationTasks: tasks });
          }
        }
      },
      onSyncGap: (_projectId) => {
        // Full project sync needed — placeholder for future implementation
      },
    });

    client.connect();
    set({ sseClient: client });
  },

  disconnectSSE: () => {
    get().sseClient?.disconnect();
    set({ sseClient: null });
  },

  startServerGeneration: async (projectId: string, prompt: string, chatMode: boolean, images?: PendingImage[], options?: StartGenerationOptions) => {
    const projectName = get().projectName || 'Untitled';

    /**
     * Claim the project before the first `await`, exactly as the browser path does.
     *
     * `isProjectGenerating` reads this map, so the one-task-per-project guard in `startGeneration`
     * only holds once the task is in it — and a model resolve, a project delta sync, a checkpoint
     * write and the POST all stand between the press and that point. The claim also flips
     * `generating`, which is what disables the composer while they run.
     *
     * The body of an async function runs synchronously up to its first `await`, so setting it here
     * closes the guard in the same tick the press opens it.
     */
    const claim = new Map(get().generationTasks);
    claim.set(projectId, {
      projectId,
      projectName,
      prompt: prompt.trim(),
      // Filled in once the assignment resolves, like the browser path's.
      model: '',
      startedAt: Date.now(),
      result: null,
      paused: false,
      pausedMessage: null,
      orchestratorInstance: null,
      persistedInstance: null,
    });
    set({ generationTasks: claim, ...deriveScalarFields(claim, get().projectId) });

    /** Give the claim back. Every exit before the task is running has to call this, or the project
     *  stays "generating" with nothing running and no way to stop it. */
    const abandonClaim = () => {
      const next = new Map(get().generationTasks);
      next.delete(projectId);
      set({ generationTasks: next, ...deriveScalarFields(next, get().projectId) });
    };

    // Resolve the agent model from the global active template, mirroring
    // the browser-mode path.
    let assignment;
    try {
      assignment = await getProjectAssignment();
    } catch (err) {
      logger.error('[ServerGen] Failed to resolve project model assignment:', err);
      toast.error('Could not resolve this project\'s model configuration. Check your provider settings.');
      abandonClaim();
      return false;
    }
    const provider = assignment.agent.provider;
    const providerConfig = getProvider(provider);
    const apiKey = configManager.getProviderApiKey(provider);
    const model = assignment.agent.model;

    if (!model) {
      toast.error(`No model selected for ${providerConfig.name}. Please select a model in settings.`);
      abandonClaim();
      return false;
    }

    // Server-mode generation always requires an API key in the request body
    // (the backend has no server-side auth resolution for the user's provider).
    if (!apiKey) {
      toast.error(`Please set your ${providerConfig.name} API key in settings`);
      abandonClaim();
      return false;
    }

    // The message goes up before the slow work, not after it: everything above this point is
    // local and fast (a config read), while the sync and the checkpoint write below are neither.
    // `conversationHistory` is built from the events further down, so it still includes this one.
    // Build ui_metadata for the local user message (mirrors what the orchestrator produces)
    const displayPrompt = options?.displayPrompt ?? prompt;
    const uiMeta: Record<string, any> = { displayContent: displayPrompt };
    if (options?.focusContext) uiMeta.focusContext = { domPath: options.focusContext.domPath, snippet: options.focusContext.outerHTML };
    if (options?.placedBlocks?.length) uiMeta.semanticBlocks = options.placedBlocks.map((b: any) => ({ name: b.name, domPath: b.domPath, position: b.position, description: b.description }));

    get().addDebugEvent('conversation_message', {
      message: {
        role: 'user',
        content: prompt,
        ui_metadata: uiMeta,
      },
    }, projectId);
    get().addDebugEvent('waiting', {}, projectId);

    // A saved project is normally already pushed by the debounced auto-sync. Flush
    // that pending push first, then avoid serializing the entire VFS when its sync
    // metadata is confirmed current. Dirty projects use a server manifest and send
    // only changed/deleted files.
    try {
      await vfs.flushSyncTimeout(projectId);
      const { getSyncManager } = await import('@/lib/vfs/sync-manager');
      const syncMgr = getSyncManager();
      const project = await vfs.getProject(projectId);
      const alreadySynced = project?.syncStatus === 'synced'
        && !!project.lastSyncedAt
        && !!project.serverUpdatedAt
        && !saveManager.isDirty(projectId);
      if (project && !alreadySynced) {
        const allItems = await vfs.getAllFilesAndDirectories(projectId);
        const files = allItems.filter((f): f is import('@/lib/vfs/types').VirtualFile => !('type' in f && f.type === 'directory'));
        const result = await syncMgr.pushProjectDelta(projectId, project, files);
        if (!result.success) {
          logger.warn('[ServerGen] Pre-generation sync failed:', result.error);
        } else if (result.project) {
          await vfs.updateProject({
            ...project,
            lastSyncedAt: new Date(result.project.lastSyncedAt ?? Date.now()),
            serverUpdatedAt: new Date(result.project.serverUpdatedAt ?? result.project.updatedAt),
            syncStatus: 'synced',
          }, { preserveUpdatedAt: true });
        }
      }
    } catch (err) {
      logger.warn('[ServerGen] Pre-generation sync error:', err);
    }

    // Snapshot current project state so the user can roll back after server generation
    try {
      const cp = await checkpointManager.createCheckpoint(projectId, 'Pre-generation snapshot', { kind: 'auto' });
      get().addDebugEvent('checkpoint_created', {
        checkpointId: cp.id, description: cp.description, timestamp: cp.timestamp,
      }, projectId);
    } catch (err) {
      logger.warn('[ServerGen] Pre-generation checkpoint failed:', err);
    }

    // Connect SSE before starting generation to avoid missing early events
    get().connectSSE();

    const conversationHistory = get().debugEvents
      .filter((e) => e.event === 'conversation_message')
      .map((e) => e.data.message);

    // Extract workspace ID from URL path (/w/{workspaceId}/...)
    const wsMatch = typeof window !== 'undefined' ? window.location.pathname.match(/^\/w\/([^/]+)/) : null;
    const workspaceId = wsMatch?.[1];

    // Web-search config for the server-side fallback (used only if no browser answers a delegated
    // search). The default path delegates back to this browser; this carries the key for headless.
    const wsProvider = configManager.getWebSearchProvider();
    const webSearch = wsProvider
      ? {
          provider: wsProvider,
          key: (wsProvider === 'tavily' || wsProvider === 'firecrawl' || wsProvider === 'brave')
            ? (configManager.getWebSearchKey(wsProvider) || undefined)
            : undefined,
          searxngUrl: wsProvider === 'searxng' ? (configManager.getSearxngUrl() || undefined) : undefined,
        }
      : undefined;

    // Build execute options for the server orchestrator
    const imageData = images?.map(img => ({ data: img.data, mediaType: img.mediaType }));
    const executeOptions: Record<string, any> = {};
    if (imageData?.length) executeOptions.images = imageData;
    if (options?.audio?.length) executeOptions.audio = options.audio.map(a => ({ data: a.data, format: a.format }));
    if (options?.files?.length) executeOptions.files = options.files.map(f => ({ name: f.name, content: f.content }));
    if (options?.focusContext) executeOptions.focusContext = { domPath: options.focusContext.domPath, snippet: options.focusContext.outerHTML };
    if (options?.placedBlocks?.length) executeOptions.semanticBlocks = options.placedBlocks.map((b: any) => ({ name: b.name, domPath: b.domPath, position: b.position, description: b.description }));
    if (options?.displayPrompt) executeOptions.displayPrompt = options.displayPrompt;

    let taskId: string;
    try {
      const response = await fetch('/api/server-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          projectName,
          prompt,
          model,
          apiKey,
          workspaceId,
          providerConfig: { provider },
          permissionMode: configManager.getPermissionMode(),
          permissionOverrides: configManager.getPermissionOverrides(),
          webSearchAvailable: configManager.isWebSearchConfigured(),
          ...(webSearch ? { webSearch } : {}),
          conversationHistory,
          ...(Object.keys(executeOptions).length > 0 ? { executeOptions } : {}),
          generationParams: {
            reasoningEnabled: configManager.getReasoningEnabled(model),
            compactionEnabled: configManager.isCompactionEnabled(provider),
            compactionLimit: configManager.getCompactionLimit(provider),
            debugStreamEnabled: configManager.getDebugStreamEnabled(),
            modelPricing: {},
            cachedModels: configManager.getCachedModels(provider)?.models ?? [],
          },
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        toast.error((error as any).error || 'Failed to start server generation');
        abandonClaim();
        return false;
      }

      ({ taskId } = await response.json());
    } catch {
      toast.error('Failed to connect to server for generation');
      abandonClaim();
      return false;
    }

    // Merged onto the claim rather than replacing it. The claim exists for the whole of the work
    // above, so an SSE event (a pause, a result) can have reached the task already; a fresh object
    // here would put `paused` and `result` back to their defaults and lose it.
    const tasks = new Map(get().generationTasks);
    const claimed = tasks.get(projectId);
    tasks.set(projectId, {
      ...(claimed ?? {
        projectId,
        projectName,
        startedAt: Date.now(),
        result: null,
        paused: false,
        pausedMessage: null,
        orchestratorInstance: null,
        persistedInstance: null,
      }),
      prompt,
      model,
      serverTaskId: taskId,
    });
    set({ generationTasks: tasks, ...deriveScalarFields(tasks, get().projectId) });
    return true;
  },

  dismissGenerationResult: (projectId?: string) => {
    const targetId = projectId ?? get().projectId;
    const task = get().generationTasks.get(targetId);
    if (!task || task.result === null) return;
    dismissedServerProjects.add(targetId);
    const newTasks = new Map(get().generationTasks);
    newTasks.delete(targetId);
    set({ generationTasks: newTasks, ...deriveScalarFields(newTasks, get().projectId) });
  },

  reattachServerTasks: async () => {
    if (!isServerMode()) return;

    if (reattaching) return;
    reattaching = true;

    try {
      const response = await fetch('/api/server-generate/status');
      if (!response.ok) return;

      const { tasks: serverTasks } = await response.json();
      const generationTasks = new Map(get().generationTasks);
      let needSSE = false;

      const serverProjectIds = new Set<string>();

      // Group server tasks by projectId — only keep the latest per project
      const latestByProject = new Map<string, typeof serverTasks[0]>();
      if (serverTasks?.length) {
        for (const t of serverTasks) {
          serverProjectIds.add(t.projectId);
          const existing = latestByProject.get(t.projectId);
          if (!existing || t.startedAt > existing.startedAt) {
            latestByProject.set(t.projectId, t);
          }
        }
      }

      for (const [, serverTask] of latestByProject) {

        if (serverTask.status === 'running' || serverTask.status === 'paused') {
          needSSE = true;
          generationTasks.set(serverTask.projectId, {
            projectId: serverTask.projectId,
            projectName: serverTask.projectName || '',
            prompt: serverTask.prompt || '',
            model: serverTask.model || '',
            startedAt: serverTask.startedAt,
            result: null,
            paused: serverTask.status === 'paused',
            pausedMessage: null,
            orchestratorInstance: null,
            persistedInstance: null,
            serverTaskId: serverTask.taskId,
          });
        } else if (serverTask.status === 'completed' || serverTask.status === 'failed') {
          if (dismissedServerProjects.has(serverTask.projectId)) continue;
          const existing = generationTasks.get(serverTask.projectId);
          if (existing && existing.result !== null) continue;

          const result = serverTask.status === 'completed' ? 'completed' as const : 'failed' as const;
          needSSE = true;

          generationTasks.set(serverTask.projectId, {
            projectId: serverTask.projectId,
            projectName: serverTask.projectName || '',
            prompt: serverTask.prompt || '',
            model: serverTask.model || '',
            startedAt: serverTask.startedAt,
            result,
            paused: false,
            pausedMessage: null,
            orchestratorInstance: null,
            persistedInstance: null,
            serverTaskId: serverTask.taskId,
          });
          get().addDebugEvent('task_complete', {
            result: serverTask.status,
            error: serverTask.failureReason,
            recovered: true,
          }, serverTask.projectId);

          if (result === 'completed') {
            try {
              await pullAndCheckpointServerFiles(serverTask.projectId, get);
            } catch (err) {
              logger.warn('[Reattach] pull failed:', err);
            }
          }
        }
      }

      // A task absent from both the in-memory manager and the durable store has expired past the
      // reattach window: its outcome is unknown. A genuine restart-interrupt is surfaced as a
      // failure via the durable row above, so reaching here means we truly cannot tell. Mark it
      // 'unavailable' rather than claiming success or inventing a failure — and do
      // not pull files, since their presence would not prove the generation finished.
      for (const [pid, task] of generationTasks) {
        if (task.serverTaskId && task.result === null && !serverProjectIds.has(pid)) {
          generationTasks.set(pid, { ...task, result: 'unavailable' });
          get().addDebugEvent('task_complete', {
            result: 'unavailable',
            error: 'Generation status expired — outcome unknown',
            recovered: true,
          }, pid);
        }
      }

      const hasRunning = [...generationTasks.values()].some(t => t.result === null);
      set({ generationTasks, ...deriveScalarFields(generationTasks, get().projectId) });
      if (needSSE) {
        get().connectSSE();
        // If no tasks are actively running, disconnect after replay completes
        if (!hasRunning) {
          setTimeout(() => {
            const stillRunning = [...get().generationTasks.values()].some(t => t.result === null);
            if (!stillRunning) get().disconnectSSE();
          }, 5000);
        }
      }
    } catch {
      // Non-critical — tasks will be picked up on next page load
    } finally {
      reattaching = false;
    }
  },
});
