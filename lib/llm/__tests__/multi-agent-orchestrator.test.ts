import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopResult, Message } from '../core/types';

// --- Hoisted state shared with module mocks ---

const h = vi.hoisted(() => {
  const okResult = {
    success: true,
    summary: 'Completed successfully (status --complete)',
    exitReason: 'status_complete',
    totalCost: 0,
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolCount: 1,
    turnCount: 1,
  };
  const orchestratorAgent = {
    type: 'orchestrator', maxIterations: 40, isReadOnly: false, tools: ['bash'], hasTool: () => true,
  };
  return {
    okResult,
    orchestratorAgent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: orchestratorAgent as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loopBehavior: { run: async (_deps: any, _prompt: unknown): Promise<any> => ({ ...okResult }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loops: [] as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executorConfigs: [] as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    coordinatorConfigs: [] as any[],
  };
});

vi.mock('../core/agent-loop', () => ({
  AgentLoop: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(deps: any) { this.deps = deps; h.loops.push(this); }
    stop = vi.fn();
    run(prompt: unknown) { return h.loopBehavior.run(this.deps, prompt); }
  },
}));

vi.mock('../tool-executor', () => ({
  OswsToolExecutor: class {
    onAfterExecute?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(cfg: any) { h.executorConfigs.push(cfg); }
  },
}));

vi.mock('../provider-adapter', () => ({
  OswsProviderAdapter: class {
    constructor(_cfg: unknown) {}
  },
  PausableApiError: class extends Error {
    constructor(
      message: string,
      public readonly status = 0,
      public readonly errorType = 'unknown',
      public readonly errorCategory = 'unknown',
      public readonly provider = 'p',
      public readonly model = 'm',
    ) { super(message); }
  },
}));

vi.mock('../coordinator', () => ({
  MultiAgentCoordinator: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(cfg: any) { h.coordinatorConfigs.push(cfg); }
    createWrappedExecutor() {
      return { execute: async () => ({ tool_call_id: 'x', content: '', success: true }), getDefinitions: () => [] };
    }
    stop = vi.fn();
  },
}));

vi.mock('../agent', () => ({
  agentRegistry: { get: () => h.agent },
}));

vi.mock('@/lib/vfs', () => ({
  vfs: {
    listDirectory: vi.fn(async () => []),
    getServerContextMetadata: () => null,
    updateProjectCost: vi.fn(async () => undefined),
    readFile: vi.fn(async () => ({ content: '# profile' })),
  },
}));

vi.mock('@/lib/testing/judge', () => ({ runStructuredJudge: vi.fn(async () => []) }));
vi.mock('@/lib/testing/assertion-runner', () => ({ runAssertions: vi.fn(async () => []) }));

vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: { createCheckpoint: vi.fn(async () => ({ id: 'cp1', timestamp: 1 })) },
}));

vi.mock('@/lib/vfs/save-manager', () => ({
  saveManager: { getSavedCheckpointId: () => null },
}));

vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getSelectedProvider: () => 'openrouter',
    getProviderApiKey: () => 'key',
    getProviderModel: () => 'model-x',
    updateSessionCost: vi.fn(),
    getReasoningEnabled: () => false,
    getDebugStreamEnabled: () => false,
    getModelPricing: () => null,
    getCachedModels: () => null,
    getCompactionLimit: () => null,
    getModelContextLengthFromCache: () => null,
    getCurrentSession: () => null,
    isWebSearchConfigured: () => false,
  },
}));

const registryMock = vi.hoisted(() => ({ usesOAuth: false }));
vi.mock('@/lib/llm/providers/registry', () => ({
  getProvider: () => ({ apiKeyRequired: false, usesOAuth: registryMock.usesOAuth }),
  getModelContextLength: () => 128000,
}));

vi.mock('../cost-calculator', () => ({
  CostCalculator: { calculateCost: () => 0.25 },
}));

vi.mock('../streaming-parser', () => ({
  buildFileTree: () => 'tree',
}));

vi.mock('@/lib/preview/runtime-errors', () => ({
  drainRuntimeErrors: () => [],
  formatRuntimeErrors: () => '',
  resetRuntimeErrors: vi.fn(),
}));

vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn(async () => 'SYS PROMPT'),
  buildProjectContext: vi.fn(async () => 'PROJECT CTX'),
  buildCompactionPrompt: () => 'COMPACT',
}));

vi.mock('../skill-evaluator', () => ({
  evaluateRelevantSkills: vi.fn(async () => ({ skillIds: [] })),
}));

vi.mock('@/lib/vfs/skills', () => ({
  skillsService: {
    isEvaluationEnabled: async () => false,
    getEnabledSkillsMetadata: async () => [],
  },
}));

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/lib/telemetry/tool-analytics', () => ({
  extractToolAnalytics: () => ({}),
  bucketInterviewTemplateId: (id: string) => id,
}));

import { MultiAgentOrchestrator, AgentMessage } from '../multi-agent-orchestrator';
import { runStructuredJudge } from '@/lib/testing/judge';
import { getInterviewTemplate } from '@/lib/interview/templates';

beforeEach(() => {
  h.loops.length = 0;
  h.executorConfigs.length = 0;
  h.coordinatorConfigs.length = 0;
  h.agent = h.orchestratorAgent;
  h.loopBehavior.run = async () => ({ ...h.okResult });
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('MultiAgentOrchestrator result propagation and lifecycle', () => {
  it('propagates loop failure (success, summary, exitReason) instead of hardcoding success', async () => {
    h.loopBehavior.run = async (): Promise<AgentLoopResult> => ({
      success: false,
      summary: 'Reached maximum iterations (40)',
      exitReason: 'max_iterations',
      totalCost: 0,
      totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCount: 3,
      turnCount: 5,
    });
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const result = await orchestrator.execute('build a site');

    expect(result.success).toBe(false);
    expect(result.summary).toBe('Reached maximum iterations (40)');
    expect(result.exitReason).toBe('max_iterations');
    expect(result.conversation[0].metadata.status).toBe('failed');
  });

  it('marks the conversation completed and records accumulated cost on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      deps.cost.record({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'openrouter', 'model-x');
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const result = await orchestrator.execute('build a site');
    expect(result.success).toBe(true);
    expect(result.conversation[0].metadata.status).toBe('completed');
    // CostCalculator mock returns 0.25 per record() call
    expect(result.totalCost).toBe(0.25);
    expect(result.conversation[0].metadata.cost).toBe(0.25);
  });

  it('stops rather than pausing when an OAuth sign-in has expired', async () => {
    // A pause offers Continue, which re-sends the request. The adapter has just dropped the
    // expired credential, so a resend can only fail again: this is the loop users were in.
    registryMock.usesOAuth = true;
    const { PausableApiError } = await import('../provider-adapter');
    let action: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      action = await deps.config.onPausableError(new PausableApiError('expired', 401, 'auth', 'auth_expired', 'huggingface', 'm'));
      return { success: false, summary: 's', exitReason: 'error_stop', totalCost: 0, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCount: 0, turnCount: 0 };
    };
    try {
      // No continue() call: if this pauses, the promise never settles and the test times out.
      await new MultiAgentOrchestrator('test-p1').execute('build');
    } finally {
      registryMock.usesOAuth = false;
    }
    expect(action).toBe('stop');
  });

  it('still pauses for an expired credential on a provider that uses a pasted key', async () => {
    // Only OAuth sign-ins can be re-run in place. A pasted key needs the user to fix it in
    // Settings, and Continue after that is the right offer.
    const { PausableApiError } = await import('../provider-adapter');
    let action: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      action = await deps.config.onPausableError(new PausableApiError('bad key', 401, 'auth', 'auth_expired', 'openai', 'm'));
      return { success: false, summary: 's', exitReason: 'other', totalCost: 0, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCount: 0, turnCount: 0 };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const pending = orchestrator.execute('build');
    await tick(); await tick();
    orchestrator.continue();
    await pending;
    expect(action).toBe('continue');
  });

  it('keeps the tool-executor abort signal connected to stop() across pause/resume', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      const action = await deps.config.onPausableError(new Error('rate limited'));
      return {
        success: false,
        summary: action === 'stop' ? 'Stopped due to error' : 'continued',
        exitReason: action === 'stop' ? 'error_stop' : 'other',
        totalCost: 0,
        totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        toolCount: 0,
        turnCount: 0,
      };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const pending = orchestrator.execute('build');
    await tick();
    await tick();

    orchestrator.continue(); // resume after pause
    await pending;
    orchestrator.stop();

    expect(h.executorConfigs.length).toBe(1);
    expect((h.executorConfigs[0].abortSignal as AbortSignal).aborted).toBe(true);
  });

  it('emits conversation_replaced when compaction rewrites the history', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const replacement: Message[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'compacted context' },
      { role: 'assistant', content: 'summary text', metadata: { isCompactSummary: true } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      deps.context.onMessagesReplaced?.(replacement);
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator(
      'test-p1', 'orchestrator',
      (event, data) => events.push({ event, data: data as Record<string, unknown> }),
    );
    await orchestrator.execute('build');

    const replaced = events.find(e => e.event === 'conversation_replaced');
    expect(replaced).toBeDefined();
    const messages = replaced!.data?.messages as AgentMessage[];
    expect(messages).toHaveLength(3);
    expect(messages[2].ui_metadata?.isCompactSummary).toBe(true);
  });

  it('preserves the compact-summary marker when importing conversation into the context manager', async () => {
    let captured: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const imported: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'earlier prompt' },
      { role: 'assistant', content: 'Here is a summary of the conversation so far:\n\nstuff', ui_metadata: { isCompactSummary: true } },
    ];
    orchestrator.importConversation(imported);
    await orchestrator.execute('next step');

    expect(captured.some(m => m.metadata?.isCompactSummary)).toBe(true);
  });

  it('appends the template agenda to the interview agent system prompt', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    let captured: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator(
      'test-p1', 'interview', undefined,
      { interviewTemplateId: 'understand-company' },
    );
    await orchestrator.execute('Understand a company');

    const system = captured.find(m => m.role === 'system');
    expect(system).toBeDefined();
    const content = system!.content as string;
    expect(content).toContain('SYS PROMPT');
    expect(content).toContain('Understand a company');
    expect(content).toContain('/.interviews/company-profile.md');
  });

  it('interview completion gate passes (null) when all required items are judged complete', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    const template = getInterviewTemplate('understand-company')!;
    const requiredCount = template.items.filter(i => i.required !== false).length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runStructuredJudge as any).mockResolvedValue({
      verdicts: Array.from({ length: requiredCount }, () => ({ passed: true, reasoning: '' })),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, provider: 'openrouter', model: 'm' },
    });
    const progress = vi.fn();
    const orch = new MultiAgentOrchestrator('p', 'interview', progress, { interviewTemplateId: 'understand-company' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (orch as any).runInterviewCompletionGate(template);
    expect(result).toBeNull();
    expect(progress).toHaveBeenCalledWith('interview_gate', expect.objectContaining({
      complete: true,
      handoff: expect.objectContaining({ label: expect.any(String), prompt: expect.any(String), mode: 'code' }),
    }));
    // The judge's token usage is recorded and surfaced via a usage event.
    expect(progress).toHaveBeenCalledWith('usage', expect.objectContaining({ taskCost: expect.any(Number) }));
  });

  it('interview completion gate returns feedback naming an unmet required item', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    const template = getInterviewTemplate('understand-company')!;
    const required = template.items.filter(i => i.required !== false);
    // First required item fails its judge verdict, the rest pass.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runStructuredJudge as any).mockResolvedValue({
      verdicts: required.map((_, i) => ({ passed: i !== 0, reasoning: i === 0 ? 'name missing' : '' })),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, provider: 'openrouter', model: 'm' },
    });
    const progress = vi.fn();
    const orch = new MultiAgentOrchestrator('p', 'interview', progress, { interviewTemplateId: 'understand-company' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (orch as any).runInterviewCompletionGate(template);
    expect(result).not.toBeNull();
    expect(result).toContain(required[0].elicit);
    expect(result).toContain('name missing');
    expect(progress).toHaveBeenCalledWith('interview_gate', expect.objectContaining({ complete: false }));
  });

  it('buildCompletionGate uses an injected custom interview template (not just built-ins)', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    const custom = {
      id: 'custom-x', title: 'Custom X', description: 'd',
      artifacts: [{ path: '/.interviews/custom-x.md' }],
      items: [{ id: 'q', elicit: 'Q?', completion: [{ type: 'judge', criteria: 'CUSTOM CRITERIA', description: 'q' }], required: true }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runStructuredJudge as any).mockResolvedValue({
      verdicts: [{ passed: true, reasoning: '' }],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, provider: 'openrouter', model: 'm' },
    });
    const progress = vi.fn();
    // With injection: gate resolves and uses the custom criteria.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new MultiAgentOrchestrator('p', 'interview', progress, { interviewTemplateId: 'custom-x', interviewTemplate: custom as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = (orch as any).buildCompletionGate();
    expect(typeof gate).toBe('function');
    await gate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((runStructuredJudge as any)).toHaveBeenCalledWith(
      ['CUSTOM CRITERIA'],
      expect.anything(),
      expect.anything(),
    );

    // Without injection: a non-built-in id resolves to no gate.
    const orch2 = new MultiAgentOrchestrator('p', 'interview', vi.fn(), { interviewTemplateId: 'custom-x' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((orch2 as any).buildCompletionGate()).toBeUndefined();
  });

  it('does not append an agenda for the orchestrator agent', async () => {
    let captured: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    await orchestrator.execute('build a site');

    const system = captured.find(m => m.role === 'system');
    expect(system!.content as string).toBe('SYS PROMPT');
  });

  it('wires getFreshContext and child factories into the compaction/coordinator config', async () => {
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    await orchestrator.execute('build');

    expect(h.coordinatorConfigs.length).toBe(1);
    const cfg = h.coordinatorConfigs[0];
    expect(typeof cfg.createChildProvider).toBe('function');
    expect(typeof cfg.createChildExecutor).toBe('function');
    expect(typeof cfg.compactionConfig.getFreshContext).toBe('function');
    const fresh = await cfg.compactionConfig.getFreshContext();
    expect(fresh.systemPrompt).toBe('SYS PROMPT');
    expect(fresh.projectContext).toBe('PROJECT CTX');
  });

  it('resolves the agent call from the assignment, not the global provider', () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null },
    } as any);
    // @ts-expect-error private — exercised via the seam other tests in this file use
    expect(o.getProviderConfig()).toMatchObject({ provider: 'openai', model: 'gpt-x' });
  });

  it('setAssignment updates the resolved agent on an already-constructed instance', () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null },
    } as any);
    // @ts-expect-error private — exercised via the seam other tests in this file use
    expect(o.getProviderConfig()).toMatchObject({ provider: 'openai', model: 'gpt-x' });
    // Switching the working selection mid-session (describe-mode) must change the model used.
    o.setAssignment({ agent: { provider: 'anthropic', model: 'claude-y' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null });
    // @ts-expect-error private
    expect(o.getProviderConfig()).toMatchObject({ provider: 'anthropic', model: 'claude-y' });
  });

  it('resolveCompactionLimit prefers assignment.compactLimit over per-provider config', () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: true, compactLimit: 1234 },
    } as any);
    // @ts-expect-error private
    expect(o.resolveCompactionLimit()).toBe(1234);
  });

  it('sets compactionConfig.threshold to Infinity when autoCompact is false', async () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null },
    } as any);
    await o.execute('build');

    expect(h.coordinatorConfigs.length).toBe(1);
    const cfg = h.coordinatorConfigs[0];
    expect(cfg.compactionConfig.threshold).toBe(Infinity);
  });
});
