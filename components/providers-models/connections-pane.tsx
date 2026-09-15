'use client';

import React, { useState, useCallback } from 'react';
import { Plus, Search, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eye, EyeOff, Loader2, ExternalLink, MoreVertical, Pencil, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import { track } from '@/lib/telemetry';
import { validateApiKey as checkApiKey } from '@/lib/llm/llm-client';
import { getAllProviders, getOfferableProviders, getProvider, getProviderArchetype } from '@/lib/llm/providers/registry';
import { isProviderConnected } from '@/lib/llm/providers/connection-status';
import { assertPublicHttpUrl } from '@/lib/llm/providers/url-safety';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { ConnectionBadge } from '@/components/settings/connection-badge';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';
import { CodexAuthPanel } from '@/components/settings/codex-auth-panel';
import { HFAuthPanel } from '@/components/settings/hf-auth-panel';
import { Drawer } from './drawer';
import { SearchConnectionsSection } from './search-connections';
import type { ProviderId } from '@/lib/llm/providers/types';
import { disconnectCodex } from '@/lib/auth/codex-auth';
import { cn, logger } from '@/lib/utils';
import {
  CustomHeadersEditor,
  headerRowsFrom,
  headersFromRows,
  unusableHeaderNames,
  type HeaderRow,
} from './custom-headers-editor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Notify the rest of the app that a provider's key/connection state changed. */
function emitApiKeyUpdate(provider: string, hasKey: boolean) {
  window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey } }));
}

/** Masked credential for display in connection rows. */
function maskedCred(id: ProviderId): string {
  const cfg = getProvider(id);
  const archetype = getProviderArchetype(id);
  if (archetype === 'local' || archetype === 'custom') return cfg.baseUrl ?? '';
  if (id === 'huggingface') {
    const auth = configManager.getHFAuth();
    if (auth?.username) return auth.username;
    const key = configManager.getProviderApiKey(id);
    return key ? `···${key.slice(-4)}` : '';
  }
  if (id === 'openai-codex') {
    const auth = configManager.getCodexAuth();
    return auth?.user_email ?? 'ChatGPT';
  }
  const key = configManager.getProviderApiKey(id);
  return key ? `···${key.slice(-4)}` : '';
}

// ---------------------------------------------------------------------------
// Connect-config body
// ---------------------------------------------------------------------------

interface ConnectConfigBodyProps {
  providerId: ProviderId;
  onConnected: () => void;
  onBack: () => void;
}

function ConnectConfigBody({ providerId, onConnected, onBack }: ConnectConfigBodyProps) {
  const providerConfig = getProvider(providerId);
  const archetype = getProviderArchetype(providerId);

  const [currentApiKey, setCurrentApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [validatingKey, setValidatingKey] = useState(false);
  const [testing, setTesting] = useState(false);

  const dispatchApiKeyEvent = useCallback((hasKey: boolean) => {
    emitApiKeyUpdate(providerId, hasKey);
  }, [providerId]);

  const handleConnect = async () => {
    const key = currentApiKey.trim();
    if (!key) {
      toast.error('Please enter an API key');
      return;
    }
    setValidatingKey(true);
    try {
      const isValid = await checkApiKey(key, providerId);
      if (isValid) {
        configManager.setProviderApiKey(providerId, key);
        configManager.clearModelCache(providerId);
        track('connection_added', { provider: providerId, method: 'key' });
        toast.success(`Connected to ${providerConfig.name}!`);
        dispatchApiKeyEvent(true);
        onConnected();
      } else {
        toast.error('Invalid API key. Please check and try again.');
      }
    } catch {
      toast.error('Failed to validate API key');
    } finally {
      setValidatingKey(false);
    }
  };

  const handleLocalConnect = async () => {
    // Save the optional key first so the discovery fetch uses it, then probe the
    // local server. Caching its models on success is what marks it "connected".
    configManager.setProviderApiKey(providerId, currentApiKey.trim());
    configManager.clearModelCache(providerId);
    setTesting(true);
    try {
      const models = await loadProviderModels(providerId);
      if (models.length > 0) {
        track('connection_added', { provider: providerId, method: 'local' });
        toast.success(`Connected to ${providerConfig.name} · ${models.length} model${models.length === 1 ? '' : 's'}`);
        dispatchApiKeyEvent(!!currentApiKey.trim());
        onConnected();
      } else {
        toast.error(`Couldn't reach ${providerConfig.name}${providerConfig.baseUrl ? ` at ${providerConfig.baseUrl}` : ''}. Is the server running?`);
      }
    } catch {
      toast.error(`Couldn't reach ${providerConfig.name}. Is the server running?`);
    } finally {
      setTesting(false);
    }
  };

  // --- subscription (Codex OAuth) ---
  if (archetype === 'subscription') {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <CodexAuthPanel
          onAuthChange={() => {
            dispatchApiKeyEvent(!!configManager.getProviderApiKey(providerId));
            onConnected();
          }}
        />
      </div>
    );
  }

  // --- OAuth cloud (HuggingFace) ---
  if (archetype === 'cloud' && providerConfig.usesOAuth) {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <HFAuthPanel
          onAuthChange={() => {
            dispatchApiKeyEvent(!!configManager.getProviderApiKey(providerId));
            onConnected();
          }}
        />
      </div>
    );
  }

  // --- local ---
  if (archetype === 'local') {
    return (
      <div className="px-[18px] py-4 space-y-4">

        <div className="p-3 border rounded-md bg-muted/50 text-sm text-muted-foreground space-y-1">
          <p className="font-medium">Local Provider</p>
          <p>Make sure {providerConfig.name} is running on your machine.</p>
          {providerConfig.baseUrl && (
            <p>
              Default endpoint:{' '}
              <code className="text-xs">{providerConfig.baseUrl}</code>
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="local-key">
            API Key
            <span className="text-muted-foreground text-xs ml-1">(optional)</span>
          </Label>
          <div className="flex gap-2 mt-2">
            <div className="relative flex-1">
              <Input
                id="local-key"
                type={showApiKey ? 'text' : 'password'}
                value={currentApiKey}
                onChange={(e) => setCurrentApiKey(e.target.value)}
                placeholder={providerConfig.apiKeyPlaceholder || 'Only if your server requires auth'}
                className="pr-10"
              />
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            API key is optional for {providerConfig.name}. Only needed if you&apos;ve configured authentication on your local server.
          </p>
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onBack} disabled={testing}>
            Back
          </Button>
          <Button size="sm" onClick={handleLocalConnect} disabled={testing}>
            {testing ? 'Testing…' : 'Test & connect'}
          </Button>
        </div>
      </div>
    );
  }

  // --- cloud / aggregator (API key required) ---
  return (
    <div className="px-[18px] py-4 space-y-4">

      <div>
        <Label htmlFor="cloud-key">{providerConfig.name} API Key</Label>
        <div className="flex gap-2 mt-2">
          <div className="relative flex-1">
            <Input
              id="cloud-key"
              type={showApiKey ? 'text' : 'password'}
              value={currentApiKey}
              onChange={(e) => { setCurrentApiKey(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && currentApiKey.trim()) handleConnect(); }}
              placeholder={providerConfig.apiKeyPlaceholder || 'API Key'}
              className="pr-10"
              disabled={validatingKey}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => setShowApiKey(!showApiKey)}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <Button
            onClick={handleConnect}
            disabled={validatingKey || !currentApiKey.trim()}
            size="sm"
          >
            {validatingKey ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </div>
        {providerConfig.apiKeyHelpUrl && (
          <p className="text-sm text-muted-foreground mt-2">
            Get your API key from{' '}
            <a
              href={providerConfig.apiKeyHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              {providerConfig.name} <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        )}
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect-custom body (OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

interface ConnectCustomBodyProps {
  onConnected: () => void;
  onBack: () => void;
}

function ConnectCustomBody({ onConnected, onBack }: ConnectCustomBodyProps) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [currentApiKey, setCurrentApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [requireApiKey, setRequireApiKey] = useState(true);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [testing, setTesting] = useState(false);

  const dispatchApiKeyEvent = useCallback((provider: string, hasKey: boolean) => {
    emitApiKeyUpdate(provider, hasKey);
  }, []);

  const handleConnect = async () => {
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim();
    if (!trimmedName) {
      toast.error('Please enter a provider name');
      return;
    }
    if (!trimmedUrl) {
      toast.error('Please enter an API endpoint URL');
      return;
    }
    if (requireApiKey && !currentApiKey.trim()) {
      toast.error('Please enter an API token');
      return;
    }
    // External-only: custom endpoints must be public. Reject loopback/private/non-http
    // before persisting anything.
    try {
      assertPublicHttpUrl(trimmedUrl);
    } catch {
      toast.error('Only external (public) endpoints are supported. Local or private addresses aren’t allowed for custom providers.');
      return;
    }

    const id = configManager.generateCustomProviderId(trimmedName);
    const badNames = unusableHeaderNames(headerRows);
    if (badNames.length > 0) {
      toast.error(`Remove these headers first, they can't all be sent: ${badNames.join(', ')}`);
      return;
    }

    const cfg = configManager.buildCustomProviderConfig(
      id,
      trimmedName,
      trimmedUrl,
      requireApiKey,
      headersFromRows(headerRows)
    );

    const key = currentApiKey.trim();
    setTesting(true);
    // Persist the connection regardless of model discovery — some valid OpenAI-compatible
    // endpoints don't expose /models. We probe afterwards and surface the outcome.
    configManager.saveCustomProvider(id, cfg);
    if (key) configManager.setProviderApiKey(id, key);
    configManager.clearModelCache(id);
    track('connection_added', { provider: 'custom', method: 'custom' });
    try {
      const models = await loadProviderModels(id);
      if (models.length > 0) {
        toast.success(`Connected to ${cfg.name} · ${models.length} model${models.length === 1 ? '' : 's'}`);
      } else {
        toast.warning(`Added ${cfg.name}, but no models were listed. The endpoint may not expose /models — check the URL and token, or pick a model manually.`);
      }
    } catch (err) {
      logger.error(`[custom-provider] ${trimmedName} model discovery failed:`, err);
      toast.warning(`Added ${cfg.name}, but couldn't reach its model list. Check the endpoint URL and token.`);
    } finally {
      setTesting(false);
      dispatchApiKeyEvent(id, !!key);
      onConnected();
    }
  };

  return (
    <div className="px-[18px] py-4 space-y-4">
      <div>
        <Label htmlFor="custom-name">Provider name</Label>
        <Input
          id="custom-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., My provider"
          className="mt-2"
          disabled={testing}
        />
      </div>

      <div>
        <Label htmlFor="custom-url">API endpoint</Label>
        <Input
          id="custom-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          className="mt-2"
          disabled={testing}
        />
        <p className="text-xs text-muted-foreground mt-2">
          Base URL for an OpenAI-compatible API. The app will append{' '}
          <code className="text-xs">/chat/completions</code> and{' '}
          <code className="text-xs">/models</code>. Only external (public) endpoints
          are supported — local addresses aren’t allowed.
        </p>
      </div>

      <div>
        <Label htmlFor="custom-key">
          API token
          <span className="text-muted-foreground text-xs ml-1">({requireApiKey ? 'required' : 'optional'})</span>
        </Label>
        <div className="flex gap-2 mt-2">
          <div className="relative flex-1">
            <Input
              id="custom-key"
              type={showApiKey ? 'text' : 'password'}
              value={currentApiKey}
              onChange={(e) => setCurrentApiKey(e.target.value)}
              placeholder="sk-..."
              className="pr-10"
              disabled={testing}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => setShowApiKey(!showApiKey)}
              disabled={testing}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      <CustomHeadersEditor
        rows={headerRows}
        onChange={setHeaderRows}
        disabled={testing}
        idPrefix="custom"
      />

      <div className="flex items-center justify-between">
        <Label htmlFor="custom-require-key" className="text-sm font-normal cursor-pointer">
          Require API token
        </Label>
        <Switch
          id="custom-require-key"
          checked={requireApiKey}
          onCheckedChange={setRequireApiKey}
          disabled={testing}
        />
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={testing}>
          Back
        </Button>
        <Button size="sm" onClick={handleConnect} disabled={testing || !name.trim() || !baseUrl.trim() || (requireApiKey && !currentApiKey.trim())}>
          {testing ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
              Testing…
            </>
          ) : (
            'Test & connect'
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect-choose body
// ---------------------------------------------------------------------------

interface ConnectChooseBodyProps {
  onChoose: (id: ProviderId) => void;
  onChooseCustom: () => void;
}

function ConnectChooseBody({ onChoose, onChooseCustom }: ConnectChooseBodyProps) {
  const [query, setQuery] = useState('');

  const allProviders = getOfferableProviders();
  const unconnected = allProviders.filter((p) => !isProviderConnected(p.id));

  const filtered = query.trim()
    ? unconnected.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.description.toLowerCase().includes(query.toLowerCase())
      )
    : unconnected;

  const customCard = (
    <button
      key="__custom__"
      type="button"
      onClick={onChooseCustom}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-colors',
        'hover:bg-muted border border-transparent hover:border-border',
        'cursor-pointer'
      )}
    >
      <div className="w-[34px] h-[34px] rounded-sm bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        +
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">Custom / OpenAI compatible</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-muted border border-border text-muted-foreground">
            Custom endpoint
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Add any OpenAI-compatible API endpoint.
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
    </button>
  );

  const archetypeLabel: Record<string, string> = {
    aggregator: 'API key',
    cloud: 'API key',
    subscription: 'Subscription',
    local: 'Local endpoint',
    custom: 'Custom endpoint',
  };

  return (
    <div className="px-[18px] py-4 space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          placeholder="Search providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Provider list */}
      <div className="space-y-1 pt-1">
        {!query.trim() && customCard}
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No providers match.</p>
        ) : (
          filtered.map((p) => {
            const archetype = getProviderArchetype(p.id);
            const label = archetypeLabel[archetype] ?? archetype;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChoose(p.id)}
                className={cn(
                  'w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-colors',
                  'hover:bg-muted border border-transparent hover:border-border',
                  'cursor-pointer'
                )}
              >
                {/* Icon / initials */}
                <div className="w-[34px] h-[34px] rounded-sm bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
                  {p.name.slice(0, 2).toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{p.name}</span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-muted border border-border text-muted-foreground">
                      {label}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{p.description}</div>
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection row
// ---------------------------------------------------------------------------

interface ConnectionRowProps {
  providerId: ProviderId;
  onDisconnect: () => void;
  onEdit: () => void;
  onRevalidate: () => Promise<void>;
}

function ConnectionRow({ providerId, onDisconnect, onEdit, onRevalidate }: ConnectionRowProps) {
  const cfg = getProvider(providerId);
  const cred = maskedCred(providerId);
  const [revalidating, setRevalidating] = useState(false);

  const handleRevalidate = async () => {
    setRevalidating(true);
    try { await onRevalidate(); } finally { setRevalidating(false); }
  };

  return (
    <div className="flex items-center gap-3 bg-card border border-border rounded-md px-4 py-3">
      {/* Icon / initials */}
      <div className="w-[36px] h-[36px] rounded-md bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        {cfg.name.slice(0, 2).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{cfg.name}</div>
        {cred && (
          <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{cred}</div>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <div className="h-1.5 w-1.5 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
        <span className="text-xs font-semibold text-green-500 mr-1">Connected</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" title="Connection options" disabled={revalidating}>
              {revalidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void handleRevalidate(); }}>
              <RefreshCw className="h-4 w-4" />
              Revalidate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDisconnect} className="text-destructive focus:text-destructive">
              <Unplug className="h-4 w-4" />
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit-config body (for existing connections)
// ---------------------------------------------------------------------------

interface EditConfigBodyProps {
  providerId: ProviderId;
  onDone: () => void;
  onDisconnected: () => void;
}

function EditConfigBody({ providerId, onDone, onDisconnected }: EditConfigBodyProps) {
  const providerConfig = getProvider(providerId);
  const archetype = getProviderArchetype(providerId);
  const isCustom = archetype === 'custom';
  const [disconnecting, setDisconnecting] = useState(false);

  // Editable fields for custom providers
  const [customName, setCustomName] = useState(isCustom ? providerConfig.name : '');
  const [customUrl, setCustomUrl] = useState(isCustom ? providerConfig.baseUrl || '' : '');
  const [customKey, setCustomKey] = useState(() => configManager.getProviderApiKey(providerId) || '');
  const [showCustomKey, setShowCustomKey] = useState(false);
  const [customRequireKey, setCustomRequireKey] = useState(isCustom ? providerConfig.apiKeyRequired : true);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(
    () => (isCustom ? headerRowsFrom(providerConfig.customHeaders) : [])
  );
  const [savingCustom, setSavingCustom] = useState(false);

  const dispatchApiKeyEvent = useCallback((hasKey: boolean) => {
    emitApiKeyUpdate(providerId, hasKey);
  }, [providerId]);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      if (providerId === 'openai-codex') {
        await disconnectCodex();
        configManager.clearCodexAuth();
        configManager.clearModelCache('openai-codex');
      } else if (providerId === 'huggingface') {
        configManager.clearHFAuth();
        configManager.clearModelCache('huggingface');
      } else {
        configManager.setProviderApiKey(providerId, '');
        configManager.clearModelCache(providerId);
      }
      if (isCustom) {
        configManager.removeCustomProvider(providerId);
      }
      track('connection_removed', { provider: isCustom ? 'custom' : providerId });
      toast.success(`Disconnected from ${providerConfig.name}`);
      dispatchApiKeyEvent(false);
      onDisconnected();
    } catch {
      toast.error('Failed to disconnect. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSaveCustom = async () => {
    const name = customName.trim();
    const url = customUrl.trim();
    if (!name || !url) {
      toast.error('Name and endpoint URL are required');
      return;
    }
    try {
      assertPublicHttpUrl(url);
    } catch {
      toast.error('Only external (public) endpoints are supported. Local or private addresses aren’t allowed for custom providers.');
      return;
    }
    const badNames = unusableHeaderNames(headerRows);
    if (badNames.length > 0) {
      toast.error(`Remove these headers first, they can't all be sent: ${badNames.join(', ')}`);
      return;
    }
    setSavingCustom(true);
    try {
      // Passed on every save. Without them an edit to any other field would rebuild the config
      // without its headers and drop them.
      const cfg = configManager.buildCustomProviderConfig(
        providerId,
        name,
        url,
        customRequireKey,
        headersFromRows(headerRows)
      );
      configManager.saveCustomProvider(providerId, cfg);
      configManager.setProviderApiKey(providerId, customKey.trim());
      configManager.clearModelCache(providerId);
      const models = await loadProviderModels(providerId);
      toast.success(
        models.length > 0
          ? `Updated ${cfg.name} · ${models.length} model${models.length === 1 ? '' : 's'}`
          : `Updated ${cfg.name}`
      );
      dispatchApiKeyEvent(!!customKey.trim());
      onDone();
    } catch {
      toast.error('Failed to update custom provider');
    } finally {
      setSavingCustom(false);
    }
  };

  // For OAuth providers, render their auth panel (which has built-in disconnect)
  if (archetype === 'subscription') {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <CodexAuthPanel
          onAuthChange={() => {
            const hasKey = !!configManager.getProviderApiKey(providerId);
            dispatchApiKeyEvent(hasKey);
            if (!hasKey) onDisconnected();
          }}
        />
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  if (archetype === 'cloud' && providerConfig.usesOAuth) {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <HFAuthPanel
          onAuthChange={() => {
            const hasKey = !!configManager.getProviderApiKey(providerId);
            dispatchApiKeyEvent(hasKey);
            if (!hasKey) onDisconnected();
          }}
        />
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  // custom: editable name, endpoint, key, and disconnect/delete
  if (isCustom) {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <div>
          <Label htmlFor="edit-custom-name">Provider name</Label>
          <Input
            id="edit-custom-name"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            className="mt-2"
            disabled={savingCustom}
          />
        </div>

        <div>
          <Label htmlFor="edit-custom-url">API endpoint</Label>
          <Input
            id="edit-custom-url"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            className="mt-2"
            disabled={savingCustom}
          />
        </div>

        <div>
          <Label htmlFor="edit-custom-key">API token</Label>
          <div className="flex gap-2 mt-2">
            <div className="relative flex-1">
              <Input
                id="edit-custom-key"
                type={showCustomKey ? 'text' : 'password'}
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder={customRequireKey ? 'Required' : 'Optional'}
                className="pr-10"
                disabled={savingCustom}
              />
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => setShowCustomKey(!showCustomKey)}
                disabled={savingCustom}
              >
                {showCustomKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        <CustomHeadersEditor
          rows={headerRows}
          onChange={setHeaderRows}
          disabled={savingCustom}
          idPrefix="edit-custom"
        />

        <div className="flex items-center justify-between">
          <Label htmlFor="edit-custom-require-key" className="text-sm font-normal cursor-pointer">
            Require API token
          </Label>
          <Switch
            id="edit-custom-require-key"
            checked={customRequireKey}
            onCheckedChange={setCustomRequireKey}
            disabled={savingCustom}
          />
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting || savingCustom}
          >
            {disconnecting ? 'Deleting…' : 'Delete'}
          </Button>
          <Button
            size="sm"
            onClick={handleSaveCustom}
            disabled={savingCustom || !customName.trim() || !customUrl.trim()}
          >
            {savingCustom ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
        </div>
      </div>
    );
  }

  // local: show read-only endpoint info + disconnect
  if (archetype === 'local') {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <ConnectionBadge
          method="Local"
          extra={providerConfig.baseUrl}
          onDisconnect={handleDisconnect}
          disconnecting={disconnecting}
        />
        <p className="text-xs text-muted-foreground">
          Local providers are always available when running. Disconnect removes them from the connections list.
        </p>
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  // cloud / aggregator: show current key badge + option to replace or disconnect
  const existingKey = configManager.getProviderApiKey(providerId);
  return (
    <div className="px-[18px] py-4 space-y-4">
      <ConnectionBadge
        method="API Key"
        extra={existingKey ? `···${existingKey.slice(-4)}` : undefined}
        info={
          providerConfig.apiKeyHelpUrl ? (
            <a
              href={providerConfig.apiKeyHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              Manage on {providerConfig.name} <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ) : undefined
        }
        onDisconnect={handleDisconnect}
        disconnecting={disconnecting}
      />
      <div className="flex justify-end pt-2">
        <Button size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer mode type
// ---------------------------------------------------------------------------

type ConnDrawerMode = 'connect-choose' | 'connect-config' | 'connect-custom' | 'edit-config' | null;

// ---------------------------------------------------------------------------
// Main ConnectionsPane
// ---------------------------------------------------------------------------

export function ConnectionsPane() {
  // Bumped after connect/disconnect to force a re-render that re-evaluates which
  // providers are connected. The value itself is unused — only the update matters.
  const [, setConnVersion] = useState(0);
  const refresh = useCallback(() => setConnVersion((v) => v + 1), []);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<ConnDrawerMode>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId | null>(null);

  const openAddDrawer = () => {
    setDrawerMode('connect-choose');
    setSelectedProviderId(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (id: ProviderId) => {
    setSelectedProviderId(id);
    setDrawerMode('edit-config');
    setDrawerOpen(true);
  };

  // Drop the cached model list and re-fetch it (also picks up new capability
  // fields like output modalities). Implicitly re-checks the key — a fetch with
  // a bad key returns no models.
  const handleRevalidate = async (id: ProviderId) => {
    const cfg = getProvider(id);
    configManager.clearModelCache(id);
    try {
      const models = await loadProviderModels(id);
      if (models.length > 0) {
        toast.success(`Refreshed ${models.length} model${models.length !== 1 ? 's' : ''} for ${cfg.name}`);
      } else {
        toast.error(`No models returned for ${cfg.name}. Check the connection.`);
      }
    } catch {
      toast.error(`Failed to refresh ${cfg.name} models`);
    }
  };

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setDrawerMode(null);
    setSelectedProviderId(null);
  }, []);

  const handleDisconnect = async (id: ProviderId) => {
    const cfg = getProvider(id);
    const isCustom = getProviderArchetype(id) === 'custom';
    try {
      if (id === 'openai-codex') {
        await disconnectCodex();
        configManager.clearCodexAuth();
        configManager.clearModelCache('openai-codex');
      } else if (id === 'huggingface') {
        configManager.clearHFAuth();
        configManager.clearModelCache('huggingface');
      } else {
        configManager.setProviderApiKey(id, '');
        configManager.clearModelCache(id);
      }
      if (isCustom) {
        configManager.removeCustomProvider(id);
      }
      track('connection_removed', { provider: isCustom ? 'custom' : id });
      toast.success(`Disconnected from ${cfg.name}`);
      emitApiKeyUpdate(id, false);
      refresh();
    } catch {
      toast.error('Failed to disconnect. Please try again.');
    }
  };

  const showLocalProviders = !process.env.NEXT_PUBLIC_GATEWAY_URL;
  const allProviders = getAllProviders();
  const connectedProviders = allProviders.filter((p) => isProviderConnected(p.id));

  const cloudProviders = connectedProviders.filter((p) => {
    const arch = getProviderArchetype(p.id);
    return arch !== 'local' && arch !== 'custom';
  });
  const customProviders = connectedProviders.filter((p) => getProviderArchetype(p.id) === 'custom');
  const localProviders = connectedProviders.filter((p) => {
    const arch = getProviderArchetype(p.id);
    return arch === 'local';
  });

  // Drawer title/label/scope
  let drawerLabel: string | undefined;
  let drawerTitle: string | undefined;
  let drawerScope: string | undefined;

  if (drawerMode === 'connect-choose') {
    drawerLabel = 'Add a provider';
    drawerTitle = 'Choose a provider';
    drawerScope = 'Cloud, subscription, local, or a custom OpenAI-compatible endpoint.';
  } else if (drawerMode === 'connect-custom') {
    drawerLabel = '← Back';
    drawerTitle = 'Custom provider';
    drawerScope = 'Connect any OpenAI-compatible API endpoint.';
  } else if (drawerMode === 'connect-config' && selectedProviderId) {
    drawerLabel = '← Back';
    drawerTitle = getProvider(selectedProviderId).name;
    drawerScope = getProvider(selectedProviderId).description;
  } else if (drawerMode === 'edit-config' && selectedProviderId) {
    drawerLabel = 'Edit connection';
    drawerTitle = getProvider(selectedProviderId).name;
    drawerScope = `Connected`;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* AI section */}
      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">AI</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Inference providers. When multiple are connected, the model you pick (globally or per project) decides which one is used.
            </p>
          </div>
          <Button
            variant="default"
            size="sm"
            autoFocus={connectedProviders.length === 0}
            className={cn(
              'gap-1.5 shrink-0',
              // Nothing connected yet: make the primary next step obvious.
              connectedProviders.length === 0 && 'ring-2 ring-primary/70 animate-ring-opacity',
            )}
            onClick={openAddDrawer}
          >
            <Plus className="h-3.5 w-3.5" />
            Add a provider
          </Button>
        </div>

        {/* Cloud section */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Cloud
          </p>
        {cloudProviders.length === 0 ? (
          <p className="text-sm text-muted-foreground py-1 pl-1">None yet.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {cloudProviders.map((p) => (
              <ConnectionRow
                key={p.id}
                providerId={p.id}
                onDisconnect={() => handleDisconnect(p.id)}
                onEdit={() => openEditDrawer(p.id)}
                onRevalidate={() => handleRevalidate(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Custom section */}
      {customProviders.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Custom
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {customProviders.map((p) => (
              <ConnectionRow
                key={p.id}
                providerId={p.id}
                onDisconnect={() => handleDisconnect(p.id)}
                onEdit={() => openEditDrawer(p.id)}
                onRevalidate={() => handleRevalidate(p.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Local section — hidden on the managed gateway (no local inference there) */}
      {showLocalProviders && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Local
          </p>
          {localProviders.length === 0 ? (
            <p className="text-sm text-muted-foreground py-1 pl-1">None yet.</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {localProviders.map((p) => (
                <ConnectionRow
                  key={p.id}
                  providerId={p.id}
                  onDisconnect={() => handleDisconnect(p.id)}
                  onEdit={() => openEditDrawer(p.id)}
                  onRevalidate={() => handleRevalidate(p.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      </div>

      {/* Separator between AI and Search */}
      <div className="border-t border-border" />

      {/* Search section */}
      <SearchConnectionsSection />

      {/* Drawer */}
      <Drawer
        open={drawerOpen}
        mode={drawerMode as 'connect-choose' | 'connect-config' | 'connect-custom' | null}
        label={drawerLabel}
        onLabelClick={drawerMode === 'connect-config' || drawerMode === 'connect-custom' ? () => {
          setDrawerMode('connect-choose');
          setSelectedProviderId(null);
        } : undefined}
        title={drawerTitle}
        scope={drawerScope}
        onClose={closeDrawer}
      >
        {drawerMode === 'connect-choose' && (
          <ConnectChooseBody
            onChoose={(id) => {
              setSelectedProviderId(id);
              if (getProviderArchetype(id) === 'custom') {
                setDrawerMode('edit-config');
              } else {
                setDrawerMode('connect-config');
              }
            }}
            onChooseCustom={() => {
              setDrawerMode('connect-custom');
            }}
          />
        )}

        {drawerMode === 'connect-custom' && (
          <ConnectCustomBody
            onConnected={() => {
              refresh();
              closeDrawer();
            }}
            onBack={() => {
              setDrawerMode('connect-choose');
            }}
          />
        )}

        {drawerMode === 'connect-config' && selectedProviderId && (
          <ConnectConfigBody
            key={selectedProviderId}
            providerId={selectedProviderId}
            onConnected={() => {
              refresh();
              closeDrawer();
            }}
            onBack={() => {
              setDrawerMode('connect-choose');
              setSelectedProviderId(null);
            }}
          />
        )}

        {drawerMode === 'edit-config' && selectedProviderId && (
          <EditConfigBody
            key={selectedProviderId}
            providerId={selectedProviderId}
            onDone={() => {
              refresh();
              closeDrawer();
            }}
            onDisconnected={() => {
              refresh();
              closeDrawer();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}
