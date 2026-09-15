'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Image as ImageIcon, Mic, Brain, Eye, Wrench, BookmarkPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { configManager } from '@/lib/config/storage';
import { trackAgentProviderChange } from '@/lib/telemetry/provider-selection';
import { getActiveTemplate, saveAsTemplate } from '@/lib/llm/models/template-store';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';
import { Drawer } from './drawer';
import { ModelPicker } from './model-picker';
import { fmtCtx, modelRefLabel } from './format';
import type { ModelTemplate, ModelRef, ModelAssignment } from '@/lib/llm/models/assignment';
import type { ProviderModel } from '@/lib/llm/providers/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrawerSlot = 'agent' | 'imageGen' | 'voiceInput';
type DrawerMode = 'pick' | 'save-template' | null;

interface DrawerState {
  open: boolean;
  mode: DrawerMode;
  slot: DrawerSlot | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPrice(model: ProviderModel): string | null {
  const pricing = model.pricing;
  // Image models are billed per image, not per token — OpenRouter reports 0 token
  // rates for them, so don't show "free" (it's misleading).
  const isImageOut = !!model.outputModalities?.includes('image');
  if (!pricing) return isImageOut ? 'per-image' : null;
  if (pricing.input === 0 && pricing.output === 0) return isImageOut ? 'per-image' : 'free';
  const fmt = (n: number) => {
    if (n === 0) return '$0';
    if (n < 0.01) return `$${(n).toFixed(4)}`;
    return `$${n.toFixed(2)}`;
  };
  return `${fmt(pricing.input)} / ${fmt(pricing.output)}`;
}

function autoLimitHint(ctxLength: number | undefined): string {
  if (!ctxLength) return 'auto';
  const auto = Math.round(ctxLength * 0.6);
  if (auto >= 1_000_000) return `auto (${(auto / 1_000_000).toFixed(1)}M)`;
  return `auto (${Math.round(auto / 1_000)}K)`;
}

// ---------------------------------------------------------------------------
// Capability pill
// ---------------------------------------------------------------------------

interface CapPillProps {
  icon: React.ReactNode;
  label: string;
  enabled: boolean;
}

function CapPill({ icon, label, enabled }: CapPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium border',
        enabled
          ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
          : 'text-muted-foreground/50 bg-transparent border-border',
      )}
    >
      <span className={cn('w-3 h-3 flex-shrink-0', enabled ? 'text-emerald-400' : 'text-muted-foreground/50')}>
        {icon}
      </span>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Mini toggle
// ---------------------------------------------------------------------------

interface MiniToggleProps {
  checked: boolean;
  onChange: (val: boolean) => void;
  id?: string;
}

function MiniToggle({ checked, onChange, id }: MiniToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex items-center flex-shrink-0 w-9 h-[21px] rounded-full border transition-colors duration-150 cursor-pointer',
        checked ? 'bg-primary border-primary' : 'bg-secondary border-border',
      )}
    >
      <span
        className={cn(
          'absolute block w-[15px] h-[15px] rounded-full transition-transform duration-150',
          checked ? 'translate-x-[18px] bg-white' : 'translate-x-[2px] bg-muted-foreground',
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

interface SectionHeadProps {
  label: string;
  required?: boolean;
  note?: string;
}

function SectionHead({ label, required, note }: SectionHeadProps) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-xs font-semibold tracking-[0.09em] uppercase text-muted-foreground">
          {label}
        </span>
        {required && (
          <span className="text-[10px] font-semibold text-primary bg-primary/15 border border-primary/40 px-[7px] py-[1px] rounded-sm">
            required
          </span>
        )}
      </div>
      {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card wrapper
// ---------------------------------------------------------------------------

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg px-[18px] py-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Off-state line
// ---------------------------------------------------------------------------

function OffLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span className="w-[7px] h-[7px] rounded-full bg-muted-foreground/40 flex-shrink-0" />
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model name display (enriched)
// ---------------------------------------------------------------------------

interface EnrichedModelInfo {
  name: string;
  ctx: string | null;
  price: string | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}

function useEnrichedModel(ref: ModelRef | null): EnrichedModelInfo | null {
  const [info, setInfo] = useState<EnrichedModelInfo | null>(null);

  useEffect(() => {
    if (!ref) { setInfo(null); return; }
    let cancelled = false;
    loadProviderModels(ref.provider).then((models) => {
      if (cancelled) return;
      const found = models.find((m) => m.id === ref.model);
      if (found) {
        setInfo({
          name: found.name,
          ctx: fmtCtx(found.contextLength),
          price: fmtPrice(found),
          supportsVision: found.supportsVision,
          supportsTools: found.supportsFunctions,
          supportsReasoning: found.supportsReasoning,
        });
      } else {
        // Fall back to raw model id
        setInfo({ name: modelRefLabel(ref), ctx: null, price: null });
      }
    }).catch(() => {
      if (!cancelled) setInfo({ name: modelRefLabel(ref), ctx: null, price: null });
    });
    return () => { cancelled = true; };
  }, [ref?.provider, ref?.model]); // eslint-disable-line react-hooks/exhaustive-deps

  return info;
}

// ---------------------------------------------------------------------------
// Save-template body (rendered inside Drawer)
// ---------------------------------------------------------------------------

interface SaveTemplateBodyProps {
  template: ModelTemplate;
  onSaved: (newId: string) => void;
  onCancel: () => void;
}

function SaveTemplateBody({ template, onSaved, onCancel }: SaveTemplateBodyProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { assignment } = template;

  function agentSummary(): string {
    const ref = assignment.agent;
    return `${ref.provider} / ${modelRefLabel(ref)}`;
  }

  function imageGenSummary(): string {
    if (!assignment.imageGen) return 'off';
    if (assignment.imageGen === 'agent') return 'reuse agent';
    return modelRefLabel(assignment.imageGen);
  }

  function voiceInputSummary(): string {
    if (!assignment.voiceInput) return 'off';
    if (assignment.voiceInput === 'agent') return 'reuse agent';
    if (assignment.voiceInput === 'browser') return 'browser / on-device';
    return modelRefLabel(assignment.voiceInput);
  }

  function compactionSummary(): string {
    if (!assignment.autoCompact) return 'off';
    return assignment.compactLimit ? `${assignment.compactLimit} tok` : 'auto';
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const saved = saveAsTemplate(trimmed, template.assignment);
    onSaved(saved.id);
  }

  return (
    <form onSubmit={handleSubmit} className="px-[18px] pt-4 pb-[18px] flex flex-col gap-4">
      {/* Name field */}
      <div>
        <label
          htmlFor="tpl-name-input"
          className="block text-xs font-medium text-muted-foreground mb-[7px]"
        >
          Name
        </label>
        <input
          ref={inputRef}
          id="tpl-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Client work"
          className={cn(
            'w-full px-[11px] py-2 rounded-sm text-[13px] font-[Inter,system-ui,sans-serif]',
            'bg-background border border-border text-foreground placeholder:text-muted-foreground',
            'outline-none focus:border-ring transition-colors',
          )}
        />
      </div>

      {/* Summary */}
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-[7px]">
          Saving
        </label>
        <div className="bg-card border border-border rounded-md px-[14px] py-[12px] flex flex-col gap-1">
          {(
            [
              ['Agent', agentSummary()],
              ['Image gen', imageGenSummary()],
              ['Voice in', voiceInputSummary()],
              ['Compaction', compactionSummary()],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between text-xs py-[3px]">
              <span className="text-muted-foreground">{k}</span>
              <span className="text-muted-foreground font-medium">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2.5 justify-end pt-1">
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
            'bg-transparent border border-border text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!name.trim()}
          className={cn(
            'px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
            'bg-primary border border-primary text-white',
            'hover:bg-primary/90 hover:border-primary',
            'disabled:opacity-45 disabled:cursor-not-allowed',
          )}
        >
          Save as template
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

interface AgentCardProps {
  template: ModelTemplate;
  onOpenPicker: () => void;
  onAssignmentChange: (partial: Partial<ModelAssignment>) => void;
}

function AgentCard({ template, onOpenPicker, onAssignmentChange }: AgentCardProps) {
  const { assignment } = template;
  const agentRef = assignment.agent;
  const enriched = useEnrichedModel(agentRef);
  const modelId = agentRef.model;
  const [reasoningEnabled, setReasoningEnabled] = useState(() =>
    configManager.getReasoningEnabled(modelId),
  );
  const [compactLimitInput, setCompactLimitInput] = useState(
    assignment.compactLimit != null ? String(assignment.compactLimit) : '',
  );

  // Sync local state when template changes (e.g. after template switch)
  useEffect(() => {
    setReasoningEnabled(configManager.getReasoningEnabled(modelId));
    setCompactLimitInput(assignment.compactLimit != null ? String(assignment.compactLimit) : '');
  }, [modelId, assignment.compactLimit]);

  function handleReasoningToggle(enabled: boolean) {
    setReasoningEnabled(enabled);
    configManager.setReasoningEnabled(modelId, enabled);
  }

  function handleAutoCompactToggle(enabled: boolean) {
    onAssignmentChange({ autoCompact: enabled });
  }

  function handleCompactLimitChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setCompactLimitInput(raw);
    const parsed = parseInt(raw.replace(/\D/g, ''), 10);
    onAssignmentChange({ compactLimit: raw.trim() === '' ? null : (Number.isNaN(parsed) ? null : parsed) });
  }

  const autoHint = enriched?.ctx
    ? `auto (60% of ${enriched.ctx})`
    : autoLimitHint(undefined);

  return (
    <Card>
      {/* Top row: model info + Change button */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
              {enriched?.name ?? modelRefLabel(agentRef)}
            </span>
            <span className="text-xs font-mono text-muted-foreground">
              {agentRef.provider}
            </span>
          </div>
          {(enriched?.ctx || enriched?.price) && (
            <p className="text-xs font-mono text-muted-foreground mt-1">
              {[enriched.ctx, enriched.price].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenPicker}
          className={cn(
            'flex-shrink-0 px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
            'bg-card border border-border text-foreground',
            'hover:bg-muted hover:border-muted-foreground/30',
          )}
        >
          Change
        </button>
      </div>

      {/* Capability pills */}
      <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-border">
        <CapPill
          icon={<Eye size={12} strokeWidth={2} />}
          label="Image uploads"
          enabled={enriched?.supportsVision ?? false}
        />
        <span className="text-muted-foreground/50 text-xs">·</span>
        <CapPill
          icon={<Wrench size={12} strokeWidth={2} />}
          label="Tool use"
          enabled={enriched?.supportsTools ?? false}
        />
        <span className="text-muted-foreground/50 text-xs">·</span>
        <CapPill
          icon={<Brain size={12} strokeWidth={2} />}
          label="Reasoning"
          enabled={enriched?.supportsReasoning ?? false}
        />
        {enriched?.ctx && (
          <>
            <span className="text-muted-foreground/50 text-xs">·</span>
            <span className="text-xs text-muted-foreground">{enriched.ctx}</span>
          </>
        )}
      </div>

      {/* Reasoning toggle (only when model advertises it) */}
      {enriched?.supportsReasoning && (
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border">
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-foreground font-medium">Enable reasoning</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Extended thinking before responding — uses more tokens
            </p>
          </div>
          <MiniToggle checked={reasoningEnabled} onChange={handleReasoningToggle} />
        </div>
      )}

      {/* Auto-compaction */}
      <div className="mt-3 pt-3 border-t border-border">
        {/* Toggle row */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-foreground font-medium">Auto-compact</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Summarize the conversation at 60% of the model&apos;s context limit
            </p>
          </div>
          <MiniToggle
            checked={assignment.autoCompact}
            onChange={handleAutoCompactToggle}
          />
        </div>

        {/* Compaction limit input */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-3">
          <label
            htmlFor="compact-limit-input"
            className="text-xs text-muted-foreground min-w-[150px]"
          >
            Compaction limit (tokens)
          </label>
          <input
            id="compact-limit-input"
            type="text"
            inputMode="numeric"
            disabled={!assignment.autoCompact}
            value={compactLimitInput}
            onChange={handleCompactLimitChange}
            placeholder={autoHint}
            className={cn(
              'w-full sm:w-[180px] px-[11px] py-2 rounded-sm',
              'bg-background border border-border text-foreground font-mono text-[13px]',
              'placeholder:text-muted-foreground',
              'outline-none focus:border-ring transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">empty = auto-detect</span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Image generation card
// ---------------------------------------------------------------------------

interface ImageGenCardProps {
  template: ModelTemplate;
  onOpenPicker: () => void;
}

function ImageGenCard({ template, onOpenPicker }: ImageGenCardProps) {
  const { assignment } = template;
  const val = assignment.imageGen;
  const modelRef = val !== null && val !== 'agent' ? val : null;
  const enriched = useEnrichedModel(modelRef);

  return (
    <Card>
      <p className="font-semibold text-[13px] text-foreground mb-2.5">Image generation</p>

      {val === null ? (
        /* Off state */
        <div className="flex items-center justify-between">
          <OffLine label="No model set — off" />
          <button
            type="button"
            onClick={onOpenPicker}
            className={cn(
              'flex-shrink-0 px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
              'bg-card border border-border text-foreground',
              'hover:bg-muted hover:border-muted-foreground/30',
            )}
          >
            Set a model
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              {val === 'agent' ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
                    {enriched?.name ?? modelRefLabel(assignment.agent)}
                  </span>
                  <span className="text-xs text-muted-foreground">— same as agent model</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
                    {enriched?.name ?? (modelRef ? modelRefLabel(modelRef) : '')}
                  </span>
                  {modelRef && (
                    <span className="text-xs font-mono text-muted-foreground">
                      {modelRef.provider}
                    </span>
                  )}
                </div>
              )}
              {val !== 'agent' && (enriched?.ctx || enriched?.price) && (
                <p className="text-xs font-mono text-muted-foreground mt-1">
                  {[enriched.ctx, enriched.price].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onOpenPicker}
              className={cn(
                'flex-shrink-0 px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
                'bg-card border border-border text-foreground',
                'hover:bg-muted hover:border-muted-foreground/30',
              )}
            >
              Change
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-2.5">
            Enabled — the agent can generate images during a build.
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Voice input card
// ---------------------------------------------------------------------------

interface VoiceInputCardProps {
  template: ModelTemplate;
  onOpenPicker: () => void;
}

function VoiceInputCard({ template, onOpenPicker }: VoiceInputCardProps) {
  const { assignment } = template;
  const val = assignment.voiceInput;
  const modelRef = val !== null && val !== 'browser' && val !== 'agent' ? val : null;
  const enriched = useEnrichedModel(modelRef);

  return (
    <Card>
      <p className="font-semibold text-[13px] text-foreground mb-2.5">Voice input</p>

      {val === null ? (
        /* Off state */
        <div className="flex items-center justify-between">
          <OffLine label="Off — no mic" />
          <button
            type="button"
            onClick={onOpenPicker}
            className={cn(
              'flex-shrink-0 px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
              'bg-card border border-border text-foreground',
              'hover:bg-muted hover:border-muted-foreground/30',
            )}
          >
            Set a model
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              {val === 'browser' ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
                    Browser / on-device
                  </span>
                </div>
              ) : val === 'agent' ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
                    {modelRefLabel(assignment.agent)}
                  </span>
                  <span className="text-xs text-muted-foreground">— same as agent model</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
                    {enriched?.name ?? (modelRef ? modelRefLabel(modelRef) : '')}
                  </span>
                  {modelRef && (
                    <span className="text-xs font-mono text-muted-foreground">
                      {modelRef.provider}
                    </span>
                  )}
                </div>
              )}
              {val !== 'browser' && (enriched?.ctx || enriched?.price) && (
                <p className="text-xs font-mono text-muted-foreground mt-1">
                  {[enriched.ctx, enriched.price].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onOpenPicker}
              className={cn(
                'flex-shrink-0 px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
                'bg-card border border-border text-foreground',
                'hover:bg-muted hover:border-muted-foreground/30',
              )}
            >
              Change
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-2.5">
            {val === 'browser'
              ? 'Click mic, talk, send. Runs in your browser — nothing to set up.'
              : 'Click mic, talk, send. Audio is sent to the provider.'}
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ModelsPane() {
  // `saved` is what's persisted; `template` is the working draft. Slot/compaction
  // edits mutate the draft only — nothing is written until "Save" commits it.
  const [saved, setSaved] = useState<ModelTemplate>(() => getActiveTemplate());
  const [template, setTemplate] = useState<ModelTemplate>(() => getActiveTemplate());
  const [templates, setTemplates] = useState<Record<string, ModelTemplate>>(
    () => configManager.getModelTemplates(),
  );
  const [activeId, setActiveId] = useState<string>(() => configManager.getDefaultTemplateId());
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, mode: null, slot: null });

  // Re-read from storage and reset the draft to match (after a save or switch).
  const refresh = useCallback(() => {
    const t = getActiveTemplate();
    setSaved(t);
    setTemplate(t);
    setTemplates(configManager.getModelTemplates());
    setActiveId(configManager.getDefaultTemplateId());
  }, []);

  // Apply an edit to the draft assignment (no persistence).
  const patchAssignment = useCallback((partial: Partial<ModelAssignment>) => {
    setTemplate((d) => ({ ...d, assignment: { ...d.assignment, ...partial } }));
  }, []);

  const isBuiltin = !!template.builtin;
  const isDirty = JSON.stringify(template.assignment) !== JSON.stringify(saved.assignment);

  function handleSaveToTemplate() {
    if (isBuiltin || !isDirty) return;
    configManager.saveModelTemplate(template);
    trackAgentProviderChange(saved.assignment, template.assignment);
    refresh();
  }

  // ---- Drawer helpers ----

  function openPicker(slot: DrawerSlot) {
    setDrawer({ open: true, mode: 'pick', slot });
  }

  function openSaveTemplate() {
    setDrawer({ open: true, mode: 'save-template', slot: null });
  }

  function closeDrawer() {
    setDrawer({ open: false, mode: null, slot: null });
  }

  // ---- Template selector ----

  function handleTemplateSelect(id: string) {
    configManager.setDefaultTemplateId(id);
    refresh();
  }

  // ---- Picker onPick handler ----

  function handlePick(value: ModelRef | 'agent' | 'browser' | null) {
    const { slot } = drawer;
    if (!slot) return;

    if (slot === 'agent') {
      if (value && typeof value === 'object') {
        patchAssignment({ agent: value });
      }
    } else if (slot === 'imageGen') {
      // value can be ModelRef | 'agent' | null
      patchAssignment({ imageGen: value === 'browser' ? null : (value as ModelRef | 'agent' | null) });
    } else if (slot === 'voiceInput') {
      // value can be ModelRef | 'agent' | 'browser' | null
      patchAssignment({ voiceInput: value === 'browser' ? 'browser' : (value as ModelRef | 'agent' | null) });
    }

    closeDrawer();
  }

  // ---- Save-template callback ----

  function handleTemplateSaved(newId: string) {
    configManager.setDefaultTemplateId(newId);
    closeDrawer();
    refresh();
  }

  // ---- Derive drawer props ----

  function drawerLabel(): string {
    if (drawer.mode === 'save-template') return 'Save as template';
    if (!drawer.slot) return '';
    return 'Model for';
  }

  function drawerTitle(): string {
    if (drawer.mode === 'save-template') return 'Name this setup';
    if (drawer.slot === 'agent') return 'Agent model';
    if (drawer.slot === 'imageGen') return 'Image generation';
    if (drawer.slot === 'voiceInput') return 'Voice input';
    return '';
  }

  function drawerScope(): string {
    if (drawer.mode === 'save-template') return 'Captures your current assignments as a reusable snapshot.';
    if (drawer.slot === 'agent') return 'Any text model — this is the model that reads, plans and writes.';
    if (drawer.slot === 'imageGen') return 'Models that produce images.';
    if (drawer.slot === 'voiceInput') return 'Any model that turns speech into text. Browser is free and needs no setup.';
    return '';
  }

  // Current value for the picker
  function pickerCurrentValue(): ModelRef | 'agent' | 'browser' | null {
    if (!drawer.slot) return null;
    if (drawer.slot === 'agent') return template.assignment.agent;
    if (drawer.slot === 'imageGen') return template.assignment.imageGen;
    if (drawer.slot === 'voiceInput') return template.assignment.voiceInput;
    return null;
  }

  const sortedTemplates = Object.values(templates).sort((a, b) => {
    if (a.builtin && !b.builtin) return -1;
    if (!a.builtin && b.builtin) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="pb-8">
      {/* ---- Active-template bar ---- */}
      <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-lg px-[18px] py-[13px] mb-6">
        <span className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground flex-shrink-0">
          Active template
        </span>
        <Select value={activeId} onValueChange={handleTemplateSelect}>
          <SelectTrigger size="sm" className="rounded-full gap-1.5 text-[13px] font-medium text-foreground min-w-0 max-w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortedTemplates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="hidden md:block flex-1" />

        {/* Save edits back to the active template — only for editable templates. */}
        {!isBuiltin && (
          <button
            type="button"
            onClick={handleSaveToTemplate}
            disabled={!isDirty}
            className={cn(
              'flex items-center gap-1.5 px-[13px] py-[6px] rounded-md text-xs font-medium transition-colors',
              isDirty
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
                : 'bg-transparent border border-border text-muted-foreground/50 cursor-not-allowed',
            )}
          >
            Save to &ldquo;{saved.name}&rdquo;
          </button>
        )}

        <button
          type="button"
          onClick={openSaveTemplate}
          className={cn(
            'flex items-center gap-1.5 px-[13px] py-[6px] rounded-md text-xs font-medium cursor-pointer transition-colors',
            'bg-transparent border border-border text-muted-foreground',
            'hover:bg-muted hover:text-foreground',
          )}
        >
          <BookmarkPlus size={13} strokeWidth={2} />
          Save as template
        </button>
      </div>

      {/* Built-in description / read-only hint */}
      {(template.description || isBuiltin) && (
        <p className="text-xs text-muted-foreground -mt-3 mb-6 px-1">
          {template.description}
          {isBuiltin && (
            <span className="text-muted-foreground/70">
              {template.description ? ' ' : ''}Built-in — use &ldquo;Save as template&rdquo; to make an editable copy.
            </span>
          )}
        </p>
      )}

      {/* ---- Agent model section ---- */}
      <div className="mb-[30px]">
        <SectionHead
          label="Agent model"
          required
          note="The model that reads, plans and writes. Its capabilities decide which features turn on."
        />
        <AgentCard
          template={template}
          onOpenPicker={() => openPicker('agent')}
          onAssignmentChange={patchAssignment}
        />
      </div>

      {/* ---- Modalities section ---- */}
      <div className="mb-[30px]">
        <SectionHead
          label="Modalities"
          note="Optional capabilities layered on the text agent. Add more as you need them."
        />
        <div className="flex flex-col gap-3">
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <ImageIcon size={13} strokeWidth={2} className="text-muted-foreground" />
              <span className="text-xs font-semibold tracking-[0.07em] uppercase text-muted-foreground">
                Image generation
              </span>
            </div>
            <ImageGenCard
              template={template}
              onOpenPicker={() => openPicker('imageGen')}
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Mic size={13} strokeWidth={2} className="text-muted-foreground" />
              <span className="text-xs font-semibold tracking-[0.07em] uppercase text-muted-foreground">
                Voice input
              </span>
            </div>
            <VoiceInputCard
              template={template}
              onOpenPicker={() => openPicker('voiceInput')}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3.5">
          More modalities — video input, read-aloud — slot in here later.
        </p>
      </div>

      {/* ---- Single Drawer instance ---- */}
      <Drawer
        open={drawer.open}
        mode={drawer.mode === 'pick' ? 'pick' : drawer.mode === 'save-template' ? 'save-template' : null}
        label={drawerLabel()}
        title={drawerTitle()}
        scope={drawerScope()}
        onClose={closeDrawer}
      >
        {drawer.mode === 'pick' && drawer.slot && (
          <ModelPicker
            slot={drawer.slot}
            currentValue={pickerCurrentValue()}
            onPick={handlePick}
            agentRef={template.assignment.agent}
          />
        )}
        {drawer.mode === 'save-template' && (
          <SaveTemplateBody
            template={template}
            onSaved={handleTemplateSaved}
            onCancel={closeDrawer}
          />
        )}
      </Drawer>
    </div>
  );
}
