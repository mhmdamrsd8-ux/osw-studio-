/**
 * Multi-Agent Orchestrator — Facade
 *
 * Thin wiring layer that connects OSWS-specific dependencies (VFS, configManager,
 * telemetry, checkpoints, skills) to the portable core (AgentLoop,
 * ContextManager, ProviderAdapter, ToolExecutor, Coordinator).
 *
 * The core agent loop lives in core/agent-loop.ts. This file only handles:
 * - Constructor wiring (configManager → adapters → coordinator → loop)
 * - execute(): skill evaluation + message construction, then delegates to AgentLoop
 * - stop() / continue() / importConversation(): thin pass-through
 * - completionGate: drains runtime errors from preview iframe
 * - onPausableError: pause/resume UI flow
 * - Checkpoint recording (onAfterExecute hook)
 * - Telemetry emission
 * - Cost accumulation (configManager.updateSessionCost, VFS project cost)
 */

import { Agent, AgentType, agentRegistry } from './agent';
import { vfs } from '@/lib/vfs';
import { checkpointManager, Checkpoint } from '@/lib/vfs/checkpoint';
import { saveManager } from '@/lib/vfs/save-manager';
import { configManager } from '@/lib/config/storage';
import { getProvider, getModelContextLength } from '@/lib/llm/providers/registry';
import { boundCompactionLimit, resolveLocalContextLength } from '@/lib/llm/local-context';
import type { ProviderId } from '@/lib/llm/providers/types';
import { CostCalculator } from './cost-calculator';
import { ToolCall, UsageInfo, ContentBlock } from './types';
import { logger } from '@/lib/utils';
import { buildFileTree, ReasoningDetail } from './streaming-parser';
import { drainRuntimeErrors, formatRuntimeErrors, resetRuntimeErrors } from '@/lib/preview/runtime-errors';
import { buildSystemPrompt, buildProjectContext, buildCompactionPrompt } from './system-prompt';
import { withInterviewAgenda } from '@/lib/interview/agenda';
import { getInterviewTemplate } from '@/lib/interview/templates';
import { buildCompletionFeedback, summarizeCompletion, type ItemCheckResult } from '@/lib/interview/completion';
import type { InterviewTemplate } from '@/lib/interview/types';
import { runStructuredJudge } from '@/lib/testing/judge';
import { runAssertions } from '@/lib/testing/assertion-runner';
import { evaluateRelevantSkills } from './skill-evaluator';
import { skillsService } from '@/lib/vfs/skills';
import { track } from '@/lib/telemetry';
import { extractToolAnalytics, extractSkillRead, bucketInterviewTemplateId } from '@/lib/telemetry/tool-analytics';
import type { ServerOrchestratorContext } from '@/lib/server-generate/types';
import type { ApprovalRequest, ApprovalOutcome, PermissionMode, GateDecision } from './permissions';
import type { ResolvedAssignment, ModelRef } from '@/lib/llm/models/assignment';
import { transcribeAudio } from '@/lib/llm/transcribe';
import { generateImage } from '@/lib/llm/image-gen';

import { AgentLoop } from './core/agent-loop';
import { ContextManagerImpl } from './core/context-manager';
import { OswsProviderAdapter, PausableApiError } from './provider-adapter';
import { OswsToolExecutor } from './tool-executor';
import { MultiAgentCoordinator } from './coordinator';
import type { Message, ProgressReporter, CostTracker, AgentLoopConfig, AgentLoopResult, CompactionConfig } from './core/types';

// ---------------------------------------------------------------------------
// Exported types — consumed by 15+ files, must not change shape
// ---------------------------------------------------------------------------

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_details?: ReasoningDetail[];
  ui_metadata?: {
    checkpointId?: string;
    cost?: number;
    usage?: UsageInfo;
    isSyntheticError?: boolean;
    projectContext?: string;
    displayContent?: string | ContentBlock[];
    isCompactSummary?: boolean;
    focusContext?: { domPath: string; snippet: string };
    semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
    attachedFiles?: Array<{ name: string }>;
  };
}

export interface PendingImage {
  id: string;
  data: string;
  mediaType: string;
  preview: string;
}

export interface PendingAudio {
  id: string;
  data: string; // base64 WAV (no data: prefix); empty for browser-captured clips
  format: 'wav';
  durationMs: number;
  transcript?: string; // pre-captured text (browser STT); model clips transcribe at send
}

export interface PendingFile {
  id: string;
  name: string;
  content: string; // decoded text
  size: number;    // bytes
}

export interface ConversationNode {
  id: string;
  agent_type: AgentType;
  messages: AgentMessage[];
  metadata: {
    started_at: number;
    completed_at?: number;
    cost: number;
    status: 'running' | 'completed' | 'failed';
  };
}

export interface ContextBreakdown {
  systemPromptChars: number;
  userMessageChars: number;
  assistantTextChars: number;
  toolCallArgChars: number;
  toolResultChars: number;
  reasoningChars: number;
  totalChars: number;
}

export interface MultiAgentResult {
  success: boolean;
  summary: string;
  /** Why the loop ended: status_complete, max_iterations, loop_detected, stopped, error_stop, … */
  exitReason?: string;
  conversation: ConversationNode[];
  totalCost: number;
  totalUsage: UsageInfo;
  checkpointId?: string;
  toolCount?: number;
  turnCount?: number;
  apiErrorCount?: number;
  contextBreakdowns?: ContextBreakdown[];
}

// ---------------------------------------------------------------------------
// MultiAgentOrchestrator
// ---------------------------------------------------------------------------

/** Categories where an identical resend cannot succeed, whatever the user does meanwhile. */
const TERMINAL_CATEGORIES = new Set(['model_not_found', 'tool_not_supported', 'invalid_request', 'context_too_long']);

export function isTerminalApiError(error: PausableApiError): boolean {
  if (TERMINAL_CATEGORIES.has(error.errorCategory)) return true;
  const config = getProvider(error.provider);
  // An expired OAuth sign-in has just been cleared by the adapter; a pasted key can be replaced.
  if (error.errorCategory === 'auth_expired' && config.usesOAuth) return true;
  // HuggingFace's free allowance resets monthly. No Continue can hurry that; a paid provider's
  // credits can be topped up, so those still pause.
  if (error.errorCategory === 'credit_exhausted' && error.provider === 'huggingface') return true;
  return false;
}

export class MultiAgentOrchestrator {
  private projectId: string;
  private rootAgent: Agent;
  private conversations: Map<string, ConversationNode> = new Map();
  private currentConversationId: string;
  private onProgress?: (message: string, step?: unknown) => void;
  private chatMode: boolean;
  private model?: string;
  private assignment?: ResolvedAssignment;
  private serverContext: ServerOrchestratorContext | null;
  private interviewTemplateId?: string;
  private interviewTemplate?: InterviewTemplate;
  private onApprovalNeeded?: (req: ApprovalRequest) => Promise<ApprovalOutcome>;
  private permissionMode?: PermissionMode;
  private permissionOverrides?: Record<string, GateDecision>;

  /** Conversation-scoped baseline for the read-before-edit guard:
   *  path → updatedAt epoch-ms at the agent's last full read or overwrite. Lives
   *  on the orchestrator so it survives across messages (the instance is reused
   *  via persistedInstance), letting a task-1 write be compared against a task-2
   *  overwrite to detect edits the user made in between. */
  private readVersions = new Map<string, number>();

  private stopped = false;
  private abortController = new AbortController();
  private pauseResolve: (() => void) | null = null;

  private totalCost = 0;
  private totalUsage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
  private taskCost = 0;
  private taskTokens = 0;
  private toolCallCount = 0;
  private turnCount = 0;
  private apiErrorCount = 0;
  private contextBreakdowns: ContextBreakdown[] = [];

  private static readonly COMPACTION_THRESHOLD = 0.60;
  private static readonly RECENT_KEEP_RATIO = 0.20;
  private static readonly SUMMARY_TOKEN_RATIO = 0.10;
  private static readonly DEFAULT_COMPACTION_LIMIT = 128000;

  constructor(
    projectId: string,
    agentType: AgentType = 'orchestrator',
    onProgress?: (message: string, step?: unknown) => void,
    options?: { chatMode?: boolean; model?: string; assignment?: ResolvedAssignment; serverContext?: ServerOrchestratorContext; interviewTemplateId?: string; interviewTemplate?: InterviewTemplate; onApprovalNeeded?: (req: ApprovalRequest) => Promise<ApprovalOutcome>; permissionMode?: PermissionMode; permissionOverrides?: Record<string, GateDecision> }
  ) {
    this.projectId = projectId;
    this.onProgress = onProgress;
    this.chatMode = options?.chatMode ?? false;
    this.model = options?.model;
    this.assignment = options?.assignment;
    this.serverContext = options?.serverContext ?? null;
    this.interviewTemplateId = options?.interviewTemplateId;
    this.interviewTemplate = options?.interviewTemplate;
    this.onApprovalNeeded = options?.onApprovalNeeded;
    this.permissionMode = options?.permissionMode;
    this.permissionOverrides = options?.permissionOverrides;

    const agent = agentRegistry.get(agentType);
    if (!agent) throw new Error(`Agent type "${agentType}" not found`);
    this.rootAgent = agent;

    this.currentConversationId = this.createConversation(agentType);
  }

  // Update the resolved assignment (and derived model) on an already-constructed instance so a
  // long-lived orchestrator tracks the current global working selection without discarding its
  // in-flight conversation. execute()/model resolution read these instance fields (~:899-903).
  setAssignment(assignment: ResolvedAssignment): void {
    this.assignment = assignment;
    if (assignment?.agent?.model) this.model = assignment.agent.model;
  }

  continue(): void {
    if (this.pauseResolve) {
      // Note: do NOT replace abortController here. It was not aborted on pause,
      // and the ToolExecutor holds its signal — swapping it would disconnect
      // stop() from in-flight tool execution for the rest of the run.
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.abortController.abort();
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    logger.info('[MultiAgentOrchestrator] Execution stopped by user');
  }

  importConversation(messages: AgentMessage[]): void {
    const conversation = this.conversations.get(this.currentConversationId);
    if (!conversation) throw new Error('Cannot import conversation: root conversation not found');
    conversation.messages = messages;
    logger.info(`[MultiAgentOrchestrator] Imported ${messages.length} conversation messages`);
  }

  async execute(
    userPrompt: string,
    options?: {
      images?: Array<{ data: string; mediaType: string }>;
      audio?: Array<{ data: string; format: 'wav'; transcript?: string }>;
      voiceInput?: ModelRef | 'agent' | 'browser' | null;
      files?: Array<{ name: string; content: string }>;
      focusContext?: { domPath: string; snippet: string };
      semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
      displayPrompt?: string;
    }
  ): Promise<MultiAgentResult> {
    logger.info('[MultiAgentOrchestrator] Starting execution', { agent: this.rootAgent.type });

    this.stopped = false;
    this.abortController = new AbortController();
    this.taskCost = 0;
    this.taskTokens = 0;

    // Strip trailing nudge messages from previous execution
    const conversation = this.conversations.get(this.currentConversationId)!;
    conversation.metadata.status = 'running';
    while (conversation.messages.length > 0) {
      const last = conversation.messages[conversation.messages.length - 1];
      if (last.role === 'user' && typeof last.content === 'string' && last.content.includes('Before finishing, run the status command')) {
        conversation.messages.pop();
      } else {
        break;
      }
    }

    try {
      // 1. Build system prompt and project context
      let fileTreeStr: string | undefined;
      try {
        const files = await this.getVFS().listDirectory(this.projectId, '/');
        if (files.length > 0) fileTreeStr = buildFileTree(files);
      } catch { /* ignore */ }

      const serverCtxMeta = this.getVFS().getServerContextMetadata();
      const modelSupportsTools = this.checkModelSupportsTools();
      let systemPrompt = await buildSystemPrompt(this.chatMode, serverCtxMeta, this.projectId, this.rootAgent.type, modelSupportsTools, this.isImageGenAvailable(), this.isWebSearchAvailable(), !!this.serverContext);
      if (this.rootAgent.type === 'interview') {
        systemPrompt = withInterviewAgenda(systemPrompt, this.interviewTemplateId, this.interviewTemplate);
      }

      const hasExistingSystemMessage = conversation.messages.some(m => m.role === 'system');
      if (!hasExistingSystemMessage) {
        this.addMessage(this.currentConversationId, { role: 'system', content: systemPrompt });
      }

      let projectContext = '';
      if (!hasExistingSystemMessage) {
        projectContext = await buildProjectContext(fileTreeStr, serverCtxMeta);
      }

      // 2. Skill evaluation (orchestrator only)
      let skillHint = '';
      try {
        const evalEnabled = await skillsService.isEvaluationEnabled();
        if (evalEnabled && this.rootAgent.type === 'orchestrator') {
          const skillsMeta = await skillsService.getEnabledSkillsMetadata();
          if (skillsMeta.length > 0) {
            const { provider, apiKey, model } = this.getProviderConfig();
            const evalResult = await evaluateRelevantSkills(userPrompt, skillsMeta, fileTreeStr || '', provider, apiKey, model);
            if (evalResult.usage) {
              const cost = CostCalculator.calculateCost(evalResult.usage, evalResult.usage.provider, evalResult.usage.model, true);
              this.totalCost += cost;
              this.taskCost += cost;
              this.totalUsage.completionTokens += evalResult.usage.completionTokens;
              this.totalUsage.totalTokens += evalResult.usage.totalTokens;
              this.taskTokens += evalResult.usage.totalTokens;
              this.getConfig().updateSessionCost({ ...evalResult.usage, cost }, cost);
            }
            this.onProgress?.('skill_evaluation', { skills: skillsMeta.map(s => s.id), matched: evalResult.skillIds, usage: evalResult.usage });
            if (evalResult.skillIds.length > 0) {
              skillHint = `Skill evaluation: read ${evalResult.skillIds.map(s => `/.skills/${s}.md`).join(', ')} before proceeding.\n\n`;
            }
          }
        }
      } catch { /* silent fallback */ }

      // 3. Build user message
      const messagePrefix = (projectContext ? projectContext + '\n\n' : '') + skillHint;
      const cleanPrompt = options?.displayPrompt ?? userPrompt;

      // Attached text files are folded into the model-visible text. The display
      // bubble keeps the user's prompt and shows files as compact chips
      // (ui_metadata.attachedFiles), not the raw content.
      let fileText = '';
      if (options?.files?.length) {
        for (const f of options.files) {
          fileText += `\n\n--- Attached file: ${f.name} ---\n${f.content}`;
        }
      }
      // modelBlocks go to the model; displayBlocks go to the chat bubble. They
      // diverge for transcribed voice: the model gets the text, the bubble still
      // shows the clip (mirroring how images attach).
      const modelBlocks: ContentBlock[] = [];
      const displayBlocks: ContentBlock[] = [];
      if (options?.images?.length) {
        for (const img of options.images) {
          const block: ContentBlock = {
            type: 'image_url' as const,
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          };
          modelBlocks.push(block);
          displayBlocks.push(block);
        }
      }

      // Voice attachments resolve at send. "Reuse agent" (or a voice model equal
      // to the agent) passes the clip through for the model to hear; otherwise it
      // is transcribed (pre-captured browser text, or the voice model called now)
      // and added as labeled context. The clip itself still shows in the bubble.
      let voiceText = '';
      let voiceFailed = false;
      if (options?.audio?.length) {
        const vi = options.voiceInput;
        const agent = this.assignment?.agent;
        const passToAgent = vi === 'agent'
          || !!(vi && typeof vi === 'object' && agent && vi.provider === agent.provider && vi.model === agent.model);
        for (const clip of options.audio) {
          const block: ContentBlock = {
            type: 'input_audio' as const,
            input_audio: { data: clip.data, format: clip.format },
          };
          if (passToAgent) {
            modelBlocks.push(block);
            displayBlocks.push(block);
            continue;
          }
          if (clip.data) displayBlocks.push(block); // real clip; browser clips carry no audio
          let text = clip.transcript?.trim() ?? '';
          if (!text && vi && typeof vi === 'object') {
            try {
              text = await transcribeAudio({ data: clip.data, format: clip.format }, vi);
            } catch (e) {
              logger.warn('[MultiAgentOrchestrator] voice transcription failed', e);
              voiceFailed = true;
            }
          }
          if (text) voiceText += `${text}\n\n`;
        }
      }

      const userText = messagePrefix + voiceText + userPrompt + fileText;
      // The failure note is display-only — never sent to the model.
      const displayText = voiceText
        + (voiceFailed ? '[Voice transcription failed — check the voice-input model for this project]\n\n' : '')
        + cleanPrompt;

      const userContent: string | ContentBlock[] = modelBlocks.length > 0
        ? [{ type: 'text' as const, text: userText }, ...modelBlocks]
        : userText;
      const displayContent: string | ContentBlock[] = displayBlocks.length > 0
        ? [{ type: 'text' as const, text: displayText }, ...displayBlocks]
        : displayText;

      this.addMessage(this.currentConversationId, {
        role: 'user',
        content: userContent,
        ui_metadata: {
          displayContent,
          ...(projectContext ? { projectContext } : {}),
          ...(options?.focusContext ? { focusContext: options.focusContext } : {}),
          ...(options?.semanticBlocks?.length ? { semanticBlocks: options.semanticBlocks } : {}),
          ...(options?.files?.length ? { attachedFiles: options.files.map(f => ({ name: f.name })) } : {}),
        },
      });

      // 4. Run agent loop via extracted modules
      const loopResult = await this.runLoop();

      // 5. Post-run: checkpoint
      if (this.rootAgent.type !== 'setup') {
        await this.recordAutoCheckpoint(`After: ${userPrompt.substring(0, 60)}`);
      }

      return {
        success: loopResult.success,
        summary: loopResult.summary,
        exitReason: loopResult.exitReason,
        conversation: Array.from(this.conversations.values()),
        totalCost: this.totalCost,
        totalUsage: this.totalUsage,
        toolCount: this.toolCallCount,
        turnCount: this.turnCount,
        apiErrorCount: this.apiErrorCount,
        contextBreakdowns: this.contextBreakdowns.length > 0 ? this.contextBreakdowns : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[MultiAgentOrchestrator] Execution error:', errorMessage);
      this.onProgress?.('error', { message: errorMessage, type: 'execution_error', stack: error instanceof Error ? error.stack : undefined });
      if (this.rootAgent.type !== 'setup') {
        await this.recordAutoCheckpoint(`After failure: ${userPrompt.substring(0, 60)}`);
      }
      return {
        success: false,
        summary: `Error: ${errorMessage}`,
        exitReason: 'execution_error',
        conversation: Array.from(this.conversations.values()),
        totalCost: this.totalCost,
        totalUsage: this.totalUsage,
        toolCount: this.toolCallCount,
        turnCount: this.turnCount,
        apiErrorCount: this.apiErrorCount,
        contextBreakdowns: this.contextBreakdowns.length > 0 ? this.contextBreakdowns : undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private: runLoop — wire extracted modules and run
  // ---------------------------------------------------------------------------

  private async runLoop(): Promise<AgentLoopResult> {
    const conversation = this.conversations.get(this.currentConversationId)!;
    const compactionLimit = this.resolveCompactionLimit();

    // Build ContextManager from existing conversation
    // When autoCompact is explicitly false, disable compaction by setting an unreachable threshold.
    const compactionEnabled = this.assignment?.autoCompact !== false;
    const compactionConfig: CompactionConfig = {
      contextLength: compactionLimit,
      threshold: compactionEnabled ? Math.floor(compactionLimit * MultiAgentOrchestrator.COMPACTION_THRESHOLD) : Infinity,
      recentKeepRatio: MultiAgentOrchestrator.RECENT_KEEP_RATIO,
      summaryTokenRatio: MultiAgentOrchestrator.SUMMARY_TOKEN_RATIO,
      buildCompactionPrompt,
      // Post-compaction rebuild gets a current system prompt and file tree
      // instead of reusing the stale pre-compaction system message.
      getFreshContext: async () => {
        let fileTreeStr: string | undefined;
        try {
          const files = await this.getVFS().listDirectory(this.projectId, '/');
          if (files.length > 0) fileTreeStr = buildFileTree(files);
        } catch { /* ignore */ }
        const serverCtxMeta = this.getVFS().getServerContextMetadata();
        const systemPrompt = await buildSystemPrompt(
          this.chatMode, serverCtxMeta, this.projectId, this.rootAgent.type, this.checkModelSupportsTools(), this.isImageGenAvailable(), this.isWebSearchAvailable(), !!this.serverContext
        );
        const projectContext = await buildProjectContext(fileTreeStr, serverCtxMeta);
        return { systemPrompt, projectContext };
      },
    };
    const contextManager = new ContextManagerImpl(compactionConfig);

    // Import prior messages (everything except the last user message — loop.run adds it)
    const priorMessages = conversation.messages.slice(0, -1);
    const lastUserMsg = conversation.messages[conversation.messages.length - 1];
    contextManager.importMessages(this.toPortableMessages(priorMessages));

    // Sync new messages from ContextManager back to ConversationNode
    let skipNextUserMessage = true; // Skip the user message that loop.run() adds (already in conversation)
    contextManager.onMessageAdded = (msg: Message) => {
      if (skipNextUserMessage && msg.role === 'user') {
        skipNextUserMessage = false;
        return;
      }
      const agentMsg: AgentMessage = { role: msg.role, content: msg.content as string | ContentBlock[] };
      if (msg.tool_calls) agentMsg.tool_calls = msg.tool_calls;
      if (msg.tool_call_id) agentMsg.tool_call_id = msg.tool_call_id;
      if (msg.reasoning_details?.length) agentMsg.reasoning_details = msg.reasoning_details;
      if (msg.metadata?.isCompactSummary) agentMsg.ui_metadata = { isCompactSummary: true };
      conversation.messages.push(agentMsg);
      this.onProgress?.('conversation_message', { message: agentMsg });
    };

    // When compaction replaces the context, sync the conversation node and
    // notify the event log — the store rebuilds conversations from events, so
    // without this the pre-compaction history would be restored on re-import.
    contextManager.onMessagesReplaced = (newMessages: Message[]) => {
      conversation.messages = newMessages.map(msg => {
        const agentMsg: AgentMessage = { role: msg.role, content: msg.content as string | ContentBlock[] };
        if (msg.tool_calls) agentMsg.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) agentMsg.tool_call_id = msg.tool_call_id;
        if (msg.reasoning_details?.length) agentMsg.reasoning_details = msg.reasoning_details;
        if (msg.metadata?.isCompactSummary) agentMsg.ui_metadata = { isCompactSummary: true };
        return agentMsg;
      });
      skipNextUserMessage = false;
      this.onProgress?.('conversation_replaced', { messages: conversation.messages });
      // this.totalUsage.promptTokens reflects the context window size as of the
      // last recorded usage (see costTracker.record below) — the cheapest
      // available approximation of the pre-compaction token count.
      track('compaction_fired', { token_count: this.totalUsage.promptTokens });
    };

    // Build ProgressReporter (facade wraps onProgress + telemetry)
    const progress: ProgressReporter = {
      onEvent: (event: string, data?: Record<string, unknown>) => {
        if (event === 'nudge') track('task_nudged');
        this.onProgress?.(event, data);
      },
    };

    // Build CostTracker (tracks latest context size + cumulative output)
    const costTracker: CostTracker = {
      record: (usage, provider, model) => {
        const cost = CostCalculator.calculateCost(usage, provider, model, true);
        this.totalCost += cost;
        this.taskCost += cost;
        // promptTokens = current context window size (replace, not accumulate)
        this.totalUsage.promptTokens = usage.promptTokens;
        this.totalUsage.completionTokens += usage.completionTokens;
        this.totalUsage.totalTokens += usage.totalTokens;
        this.taskTokens += usage.totalTokens;
        this.getConfig().updateSessionCost({ ...usage, cost }, cost);

        const sessionId = this.getConfig().getCurrentSession?.()?.sessionId;
        if (!this.projectId.startsWith('test-') && this.rootAgent.type !== 'setup') {
          this.getVFS().updateProjectCost(this.projectId, {
            cost, provider: usage.provider || provider || 'unknown',
            tokenUsage: { input: usage.promptTokens, output: usage.completionTokens },
            sessionId, mode: 'absolute',
          }).catch(err => logger.error('Failed to update project cost:', err));
        }

        this.onProgress?.('usage', { usage, totalCost: this.totalCost, totalUsage: { ...this.totalUsage }, taskCost: this.taskCost, taskTokens: this.taskTokens });
      },
      getTurnCost: () => 0,
      getTotalCost: () => this.totalCost,
      getTotalUsage: () => ({ ...this.totalUsage }),
      resetTurn: () => { /* no-op for facade */ },
    };

    // Build ProviderAdapter
    const providerAdapter = new OswsProviderAdapter({
      getProviderConfig: () => this.getProviderConfig(),
      getApiUrl: () => this.getApiUrl(),
      getReasoningEnabled: (m) => this.getConfig().getReasoningEnabled(m),
      getDebugStreamEnabled: () => this.getConfig().getDebugStreamEnabled(),
      getModelPricing: (p, m) => this.getConfig().getModelPricing(p, m),
      getCachedModels: (p) => this.getConfig().getCachedModels(p),
      getLocalContextLength: () => this.getLocalContextLength(),
      progress,
    });

    // Build ToolExecutor. Only wire the capability when an image-capable model is
    // assigned — this stays in lockstep with the prompt gating so we never
    // advertise `generate-image` without it working (or vice versa).
    const imageGen = this.assignment?.imageGen;
    const generateImageCapability = this.isImageGenAvailable()
      ? async (prompt: string, opts: { aspectRatio?: string; imageSize?: string }) => {
          const ref = imageGen === 'agent' ? this.assignment!.agent : imageGen as ModelRef;
          const apiKey = this.getConfig().getProviderApiKey(ref.provider) || '';
          // Request the model's declared output modalities so image-only models
          // (e.g. FLUX, Grok Imagine) aren't sent an unsupported 'text' modality
          // while multimodal models (e.g. Gemini) still get 'text' as they require.
          const modalities = this.getModelOutputModalities(ref);
          return generateImage({ provider: ref.provider, apiKey, model: ref.model, prompt, modalities, signal: this.abortController.signal, ...opts });
        }
      : undefined;
    const buildToolExecutor = (executorProgress: ProgressReporter) => {
      const executor = new OswsToolExecutor({
        projectId: this.projectId,
        progress: executorProgress,
        getAgent: () => this.rootAgent,
        chatMode: this.chatMode,
        abortSignal: this.abortController.signal,
        generateImage: generateImageCapability,
        onApprovalNeeded: this.onApprovalNeeded,
        permissionMode: this.permissionMode,
        permissionOverrides: this.permissionOverrides,
        readVersions: this.readVersions,
        onBuildRequested: this.serverContext?.onBuildRequested,
        onSearchRequested: this.serverContext?.onSearchRequested,
        // Server-side runs pause on gated commands (no UI to prompt); browser runs prompt live.
        pauseForApproval: !!this.serverContext,
      });
      executor.onAfterExecute = async (toolCall, result, durationMs) => {
        track('tool_call', {
          ...extractToolAnalytics(toolCall.function.name, toolCall.function.arguments, result.success),
          ...(typeof durationMs === 'number' ? { duration_ms: durationMs } : {}),
        });
        const skillRead = extractSkillRead(toolCall.function.arguments);
        if (skillRead) track('skill_read', skillRead);
      };
      return executor;
    };
    const toolExecutor = buildToolExecutor(progress);

    // Build Coordinator (wraps executor for delegation). Children get their own
    // provider/executor instances scoped to the child progress reporter so their
    // streaming and tool events don't leak unwrapped into the main UI channel.
    const coordinator = new MultiAgentCoordinator({
      innerExecutor: toolExecutor,
      provider: providerAdapter,
      progress,
      cost: costTracker,
      projectId: this.projectId,
      chatMode: this.chatMode,
      compactionConfig,
      createChildProvider: (childProgress: ProgressReporter) => new OswsProviderAdapter({
        getProviderConfig: () => this.getProviderConfig(),
        getApiUrl: () => this.getApiUrl(),
        getReasoningEnabled: (m) => this.getConfig().getReasoningEnabled(m),
        getDebugStreamEnabled: () => this.getConfig().getDebugStreamEnabled(),
        getModelPricing: (p, m) => this.getConfig().getModelPricing(p, m),
        getCachedModels: (p) => this.getConfig().getCachedModels(p),
        getLocalContextLength: () => this.getLocalContextLength(),
        progress: childProgress,
      }),
      createChildExecutor: (childProgress: ProgressReporter) => buildToolExecutor(childProgress),
      buildSystemPrompt: async (agentType: string) => {
        const serverCtxMeta = this.getVFS().getServerContextMetadata();
        return buildSystemPrompt(
          this.chatMode || agentType === 'explore' || agentType === 'plan',
          serverCtxMeta, this.projectId, agentType as AgentType, true, this.isImageGenAvailable(), this.isWebSearchAvailable(), !!this.serverContext
        );
      },
    });

    // Build AgentLoop config
    const loopConfig: AgentLoopConfig = {
      maxIterations: this.rootAgent.maxIterations,
      maxNudges: 3,
      maxDuplicateToolCalls: 3,
      agentType: this.rootAgent.type,
      isReadOnly: this.chatMode || this.rootAgent.isReadOnly,
      completionGate: this.buildCompletionGate(),
      onPausableError: async (error: Error) => {
        this.apiErrorCount++;
        const isPausable = error instanceof PausableApiError;
        this.onProgress?.('error_paused', {
          message: error.message,
          status: isPausable ? (error as PausableApiError).status : 0,
          errorType: isPausable ? (error as PausableApiError).errorType : 'unknown',
          provider: isPausable ? (error as PausableApiError).provider : '',
          model: isPausable ? (error as PausableApiError).model : '',
        });
        if (isPausable) {
          track('api_error', {
            provider: (error as PausableApiError).provider,
            model: (error as PausableApiError).model,
            error_type: (error as PausableApiError).errorType,
            error_category: (error as PausableApiError).errorCategory,
            status_code: (error as PausableApiError).status,
          });
        } else {
          // Non-pausable generation error (not a PausableApiError) — still
          // reaches this handler and can lead to nudge/retry or task failure.
          // Report best-effort fields only; never the error message.
          track('api_error', {
            error_type: error.name || 'unknown',
            error_category: 'unknown',
          });
        }
        // Pausing offers Continue, which re-sends the same request. That only helps when the
        // failure can pass on its own or after something the user can fix in place: a server
        // blip, a rate limit, a pasted key replaced in Settings, credits topped up. For a request
        // the provider will refuse identically every time, a pause is a dead button, and most API
        // errors are of that kind. End the task instead; Retry from the checkpoint remains.
        if (isPausable && isTerminalApiError(error as PausableApiError)) {
          return 'stop';
        }
        await new Promise<void>(resolve => { this.pauseResolve = resolve; });
        return this.stopped ? 'stop' : 'continue';
      },
    };

    // Clear runtime errors before starting
    this.resetErrors();

    // Run
    const loop = new AgentLoop({
      config: loopConfig,
      provider: providerAdapter,
      executor: coordinator.createWrappedExecutor(),
      context: contextManager,
      progress,
      cost: costTracker,
    });

    // Propagate stop to coordinator and loop
    const originalStop = this.stop.bind(this);
    this.stop = () => {
      originalStop();
      loop.stop();
      coordinator.stop();
    };

    const userContent = lastUserMsg?.content ?? '';
    let result: AgentLoopResult;
    try {
      result = await loop.run(userContent);
    } finally {
      this.stop = originalStop;
    }

    this.toolCallCount += result.toolCount;
    this.turnCount += result.turnCount;

    // Mark conversation finished — status reflects the actual loop outcome
    conversation.metadata.completed_at = Date.now();
    conversation.metadata.status = result.success ? 'completed' : 'failed';
    conversation.metadata.cost = this.totalCost;

    // Emit context breakdown
    const breakdown = this.measureContextBreakdown(conversation.messages);
    this.contextBreakdowns.push(breakdown);

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getConfig(): any {
    return this.serverContext ? this.serverContext.config : configManager;
  }

  private getVFS() {
    return this.serverContext?.vfs ?? vfs;
  }

  private getApiUrl(): string {
    if (this.serverContext) return this.serverContext.apiBaseUrl + '/api/generate';
    return typeof window !== 'undefined' ? `${window.location.origin}/api/generate` : '/api/generate';
  }

  private checkModelSupportsTools(): boolean {
    const { provider, model } = this.getProviderConfig();
    const cached = this.getConfig().getCachedModels(provider);
    if (cached?.models?.length) {
      const entry = (cached.models as { id: string; supportsFunctions?: boolean }[]).find(m => m.id === model);
      if (entry && entry.supportsFunctions === false) return false;
    }
    return true;
  }

  /** A model's declared output modalities from the cached catalog, if known. */
  private getModelOutputModalities(ref: ModelRef): string[] | undefined {
    const entry = this.getConfig().getCachedModels(ref.provider)?.models
      ?.find((m: { id: string; outputModalities?: string[] }) => m.id === ref.model);
    return entry?.outputModalities?.length ? entry.outputModalities : undefined;
  }

  /**
   * Whether image generation should be offered (prompt docs + wired capability).
   * True when an image-capable model is assigned: an explicit image model (the
   * picker only lists image-output models), or 'agent' reuse only when the agent
   * model actually outputs images. Guards against a stale `imageGen: 'agent'`
   * pointing at a text-only agent model — which would otherwise advertise a
   * `generate-image` command that fails at runtime.
   */
  private isImageGenAvailable(): boolean {
    const imageGen = this.assignment?.imageGen;
    if (!imageGen) return false;
    if (imageGen !== 'agent') return true;
    return !!this.getModelOutputModalities(this.assignment!.agent)?.includes('image');
  }

  private isWebSearchAvailable(): boolean {
    // Server-side the provider config lives on the client, so trust the flag the client sent
    // (the search itself is delegated back to the browser). Browser runs read local config.
    if (this.serverContext) return !!this.serverContext.webSearchAvailable;
    return configManager.isWebSearchConfigured();
  }

  /** Selects the completion gate for the active agent (undefined = no gate). */
  private buildCompletionGate(): (() => Promise<string | null>) | undefined {
    if (this.rootAgent.type === 'orchestrator') {
      return async () => {
        await new Promise(resolve => setTimeout(resolve, 400));
        const errors = this.drainErrors();
        if (errors.length > 0) return formatRuntimeErrors(errors);
        return null;
      };
    }
    if (this.rootAgent.type === 'interview' && this.interviewTemplateId) {
      const template = this.interviewTemplate ?? getInterviewTemplate(this.interviewTemplateId);
      if (template) return () => this.runInterviewCompletionGate(template);
    }
    return undefined;
  }

  /**
   * Verifies the template's required items are captured in the artifact before
   * the interview can finish. Fails open on a judge error so an API hiccup
   * cannot trap the interview.
   */
  private async runInterviewCompletionGate(template: InterviewTemplate): Promise<string | null> {
    const required = template.items.filter(i => i.required !== false);
    if (required.length === 0) return null;

    const results: ItemCheckResult[] = [];

    try {
      // File-based assertions (judge assertions are skipped by runAssertions).
      const conversation = Array.from(this.conversations.values());
      for (const item of required) {
        const fileAssertions = item.completion.filter(a => a.type !== 'judge');
        if (fileAssertions.length === 0) continue;
        const ars = await runAssertions(this.projectId, conversation, fileAssertions);
        for (const ar of ars) {
          results.push({ itemId: item.id, passed: ar.passed, reason: ar.passed ? undefined : (ar.actual || 'check failed') });
        }
      }

      // Judge assertions — one combined call across all required items.
      const judgeChecks: { itemId: string; criteria: string }[] = [];
      for (const item of required) {
        for (const a of item.completion) {
          if (a.type === 'judge') judgeChecks.push({ itemId: item.id, criteria: a.criteria });
        }
      }
      if (judgeChecks.length > 0) {
        const files = await this.readArtifactFiles(template);
        const { provider, apiKey, model } = this.getProviderConfig();
        const judged = await runStructuredJudge(
          judgeChecks.map(c => c.criteria),
          {
            prompt: `Interview: ${template.title} — ${template.description}`,
            files,
            summary: 'The interviewer reported the agenda complete.',
          },
          { provider: provider as ProviderId, apiKey, model },
        );
        if (judged.usage) this.recordSideCost(judged.usage);
        judged.verdicts.forEach((v, i) => {
          results.push({ itemId: judgeChecks[i].itemId, passed: v.passed, reason: v.passed ? undefined : v.reasoning });
        });
      }
    } catch (err) {
      // Best-effort gate: never block completion on an evaluation failure.
      logger.warn('[Interview] completion gate evaluation failed, allowing completion', err);
      this.onProgress?.('interview_gate', { complete: true, errored: true, items: [] });
      return null;
    }

    const feedback = buildCompletionFeedback(template.items, results);
    if (feedback === null) {
      track('interview_completed', {
        template: bucketInterviewTemplateId(template.id),
        required_items: required.length,
      });
    }
    this.onProgress?.('interview_gate', {
      complete: feedback === null,
      items: summarizeCompletion(template.items, results),
      ...(feedback === null && template.handoff ? { handoff: template.handoff } : {}),
    });
    return feedback;
  }

  /** Reads the template's declared artifact files from the VFS for judging. */
  private async readArtifactFiles(template: InterviewTemplate): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const artifact of template.artifacts) {
      try {
        const f = await this.getVFS().readFile(this.projectId, artifact.path);
        const content = f && typeof f.content === 'string' ? f.content : '';
        if (content) files[artifact.path] = content;
      } catch { /* artifact not written yet */ }
    }
    return files;
  }

  /**
   * Records a side LLM call's cost (e.g. the completion-gate judge) and emits a
   * 'usage' event. Does not replace promptTokens — a side call's prompt is
   * unrelated to the agent's context window.
   */
  private recordSideCost(usage: UsageInfo): void {
    const provider = usage.provider || '';
    const model = usage.model || this.model || '';
    const cost = CostCalculator.calculateCost(usage, provider, model, true);
    this.totalCost += cost;
    this.taskCost += cost;
    this.totalUsage.completionTokens += usage.completionTokens;
    this.totalUsage.totalTokens += usage.totalTokens;
    this.taskTokens += usage.totalTokens;
    this.getConfig().updateSessionCost({ ...usage, cost }, cost);
    this.onProgress?.('usage', {
      usage, totalCost: this.totalCost, totalUsage: { ...this.totalUsage },
      taskCost: this.taskCost, taskTokens: this.taskTokens,
    });
  }

  private getProviderConfig(): { provider: string; apiKey: string; model: string; baseUrl: string; customHeaders?: Record<string, string> } {
    if (this.serverContext) {
      const cfg = this.getConfig();
      const provider = cfg.getSelectedProvider();
      return { provider, apiKey: cfg.getProviderApiKey(provider) || '', model: cfg.getProviderModel(provider) || this.model || 'default-model', baseUrl: '' };
    }
    const agent = this.assignment?.agent;
    const provider = (agent?.provider ?? configManager.getSelectedProvider()) as ProviderId;
    const providerConfig = getProvider(provider);
    const apiKey = configManager.getProviderApiKey(provider);
    const model = agent?.model || configManager.getProviderModel(provider) || this.model || undefined;
    if (providerConfig.apiKeyRequired && !apiKey && !providerConfig.usesOAuth) {
      throw new Error(`API key not configured for provider: ${provider}`);
    }
    return {
      provider,
      apiKey: apiKey || '',
      model: model || 'default-model',
      baseUrl: providerConfig.baseUrl || '',
      ...(providerConfig.customHeaders ? { customHeaders: providerConfig.customHeaders } : {}),
    };
  }

  private resolveCompactionLimit(): number {
    // A local model is loaded with the provider's context length; nothing may exceed it.
    return boundCompactionLimit(this.resolveUnboundedCompactionLimit(), this.getLocalContextLength());
  }

  private resolveUnboundedCompactionLimit(): number {
    const { provider, model } = this.getProviderConfig();
    // Assignment-level limit takes precedence over per-provider config
    const userLimit = this.assignment?.compactLimit ?? this.getConfig().getCompactionLimit(provider);
    if (userLimit) return userLimit;
    const registryLimit = getModelContextLength(provider as ProviderId, model);
    if (registryLimit) return registryLimit;
    const cachedLimit = this.getConfig().getModelContextLengthFromCache(provider, model);
    if (cachedLimit) return cachedLimit;
    return MultiAgentOrchestrator.DEFAULT_COMPACTION_LIMIT;
  }

  /** The context length a local provider runs with; undefined for cloud providers. */
  private getLocalContextLength(): number | undefined {
    const { provider } = this.getProviderConfig();
    if (!getProvider(provider as ProviderId).isLocal) return undefined;
    return resolveLocalContextLength(this.getConfig().getLocalContextLength?.(provider));
  }

  private resetErrors(): void {
    if (!this.serverContext) resetRuntimeErrors();
  }

  private drainErrors() {
    return this.serverContext ? [] : drainRuntimeErrors();
  }

  private addMessage(conversationId: string, message: AgentMessage): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);
    conv.messages.push(message);
    if (conversationId === this.currentConversationId) {
      this.onProgress?.('conversation_message', { message });
    }
  }

  private createConversation(agentType: AgentType): string {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.conversations.set(id, {
      id,
      agent_type: agentType,
      messages: [],
      metadata: { started_at: Date.now(), cost: 0, status: 'running' },
    });
    return id;
  }

  private async recordAutoCheckpoint(description: string): Promise<Checkpoint | null> {
    if (this.serverContext) return null;
    const checkpoint = await checkpointManager.createCheckpoint(this.projectId, description, {
      kind: 'auto',
      baseRevisionId: saveManager.getSavedCheckpointId(this.projectId),
    });
    this.onProgress?.('checkpoint_created', { checkpointId: checkpoint.id, description, timestamp: checkpoint.timestamp });
    return checkpoint;
  }

  private measureContextBreakdown(messages: AgentMessage[]): ContextBreakdown {
    let systemPromptChars = 0, userMessageChars = 0, assistantTextChars = 0;
    let toolCallArgChars = 0, toolResultChars = 0, reasoningChars = 0;
    for (const msg of messages) {
      const contentLen = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
      switch (msg.role) {
        case 'system': systemPromptChars += contentLen; break;
        case 'user': userMessageChars += contentLen; break;
        case 'assistant':
          assistantTextChars += contentLen;
          if (msg.tool_calls) for (const tc of msg.tool_calls) toolCallArgChars += (tc.function.arguments || '').length;
          if (msg.reasoning_details) for (const rd of msg.reasoning_details) reasoningChars += (rd.text || '').length + (rd.signature || '').length;
          break;
        case 'tool': toolResultChars += contentLen; break;
      }
    }
    const totalChars = systemPromptChars + userMessageChars + assistantTextChars + toolCallArgChars + toolResultChars + reasoningChars;
    return { systemPromptChars, userMessageChars, assistantTextChars, toolCallArgChars, toolResultChars, reasoningChars, totalChars };
  }

  private toPortableMessages(messages: AgentMessage[]): Message[] {
    return messages.map(({ ui_metadata, ...rest }) => ({
      ...rest,
      // Keep the compact-summary marker — compact() uses it to chain summaries
      ...(ui_metadata?.isCompactSummary ? { metadata: { isCompactSummary: true } } : {}),
    }) as Message);
  }
}
