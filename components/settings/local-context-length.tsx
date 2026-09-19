'use client';

import React, { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { configManager } from '@/lib/config/storage';
import { DEFAULT_LOCAL_CONTEXT_LENGTH, LOCAL_CONTEXT_APPLIED, LOCAL_CONTEXT_HELP } from '@/lib/llm/local-context';
import type { ProviderId } from '@/lib/llm/providers/types';

interface LocalContextLengthProps {
  providerId: ProviderId;
}

/**
 * The context length a local provider is loaded with. Applied at load for servers that
 * take it per request (Ollama); for the others it has to match how the server was
 * started, and either way it bounds compaction so the conversation never outgrows the
 * window. Empty means the default.
 */
export function LocalContextLength({ providerId }: LocalContextLengthProps) {
  const [value, setValue] = useState(() => {
    const stored = configManager.getLocalContextLength(providerId);
    return stored ? String(stored) : '';
  });

  const commit = (raw: string) => {
    const digits = raw.replace(/[^\d]/g, '');
    setValue(digits);
    const parsed = parseInt(digits, 10);
    configManager.setLocalContextLength(providerId, Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
  };

  const applied = LOCAL_CONTEXT_APPLIED[providerId] === true;

  return (
    <div data-testid="local-context-length">
      <Label htmlFor={`context-length-${providerId}`}>
        Context length
        <span className="text-muted-foreground text-xs ml-1">(tokens)</span>
      </Label>
      <Input
        id={`context-length-${providerId}`}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => commit(e.target.value)}
        placeholder={String(DEFAULT_LOCAL_CONTEXT_LENGTH)}
        className="mt-2 font-mono w-full sm:w-[180px]"
      />
      <p className="text-xs text-muted-foreground mt-2">
        {LOCAL_CONTEXT_HELP[providerId] ?? 'Set to the context length the server runs with.'}
        {applied ? '' : ' OSW Studio compacts the conversation to stay inside it.'}
      </p>
    </div>
  );
}
