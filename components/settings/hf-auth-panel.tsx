'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { ConnectionBadge } from '@/components/settings/connection-badge';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import { validateApiKey } from '@/lib/llm/llm-client';
import { whoAmI } from '@huggingface/hub';
import { checkHFCapabilities, loginHF } from '@/lib/auth/hf-auth';
import type { HFCapabilities } from '@/lib/auth/hf-auth';
import { track } from '@/lib/telemetry';

interface HFAuthPanelProps {
  onAuthChange?: () => void;
}

export function HFAuthPanel({ onAuthChange }: HFAuthPanelProps) {
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [oauthUsername, setOauthUsername] = useState<string>();
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(() => !!configManager.getHFAuth());
  const capabilitiesRef = useRef<HFCapabilities | null>(null);

  const dispatchAuthEvent = useCallback((hasKey: boolean) => {
    onAuthChange?.();
    window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
      detail: { provider: 'huggingface', hasKey }
    }));
  }, [onAuthChange]);

  // Check OAuth capabilities on mount, sync stored auth state
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Check stored auth (may have been set by app-level OAuth handler)
      const hfAuth = configManager.getHFAuth();
      if (hfAuth) {
        setIsConnected(true);
        if (hfAuth.username) setOauthUsername(hfAuth.username);
      }

      // Fetch capabilities
      try {
        const capabilities = await checkHFCapabilities();
        if (cancelled) return;
        capabilitiesRef.current = capabilities;
        setOauthAvailable(capabilities.oauthAvailable);
      } catch {
        // Network error — leave state as-is
      }
    }

    init();

    // Listen for auth changes from app-level OAuth handler
    const handleAuthUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.provider === 'huggingface') {
        const hfAuth = configManager.getHFAuth();
        setIsConnected(detail.hasKey);
        if (hfAuth?.username) setOauthUsername(hfAuth.username);
      }
    };
    window.addEventListener('apiKeyUpdated', handleAuthUpdate);

    return () => {
      cancelled = true;
      window.removeEventListener('apiKeyUpdated', handleAuthUpdate);
    };
  }, []);

  const handleOAuthLogin = async () => {
    // Fetch capabilities if we don't have them yet
    let caps = capabilitiesRef.current;
    if (!caps) {
      try {
        caps = await checkHFCapabilities();
        capabilitiesRef.current = caps;
      } catch {
        toast.error('Failed to connect. Please try again.');
        return;
      }
    }

    if (!caps.clientId) {
      toast.error('OAuth is not configured on this instance.');
      return;
    }

    await loginHF(caps.clientId, caps.scopes);
  };

  const handleConnect = async () => {
    const key = tokenInput.trim();
    if (!key) {
      toast.error('Please enter an access token');
      return;
    }
    setIsConnecting(true);
    try {
      const isValid = await validateApiKey(key, 'huggingface');
      if (isValid) {
        // Capture the username so token-paste connections can also deploy to a Space
        // (which needs <username>/<slug>). Best-effort: connection still succeeds if this fails.
        let username: string | undefined;
        try {
          const me = await whoAmI({ accessToken: key });
          username = me?.name;
        } catch { /* leave undefined */ }
        configManager.setHFAuth({ access_token: key, username });
        setIsConnected(true);
        setTokenInput('');
        toast.success('Connected to HuggingFace');
        track('connection_added', { provider: 'huggingface', method: 'key' });
        dispatchAuthEvent(true);
      } else {
        toast.error('Invalid token. Check that it has "Inference Providers" permission.');
      }
    } catch {
      toast.error('Failed to validate token. Please try again.');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setIsLoading(true);
    try {
      configManager.clearHFAuth();
      configManager.clearModelCache('huggingface');
      setIsConnected(false);
      setOauthUsername(undefined);
      setTokenInput('');
      toast.success('Disconnected from HuggingFace');
      track('connection_removed', { provider: 'huggingface' });
      dispatchAuthEvent(false);
    } catch {
      toast.error('Failed to disconnect. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // --- Connected state (OAuth or validated API key) ---
  if (isConnected) {
    return (
      <div className="space-y-3">
        <ConnectionBadge
          method={oauthUsername ? 'OAuth' : 'API Key'}
          extra={oauthUsername}
          info={
            <>
              Free tier: $0.10/month in free inference credits.{' '}
              <a
                href="https://huggingface.co/pricing"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                Upgrade <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </>
          }
          onDisconnect={handleDisconnect}
          disconnecting={isLoading}
        />
      </div>
    );
  }

  // --- Unauthenticated state ---
  return (
    <div className="space-y-3">
      <Label>HuggingFace Authentication</Label>
      <p className="text-xs text-muted-foreground">
        Use your HuggingFace account for free AI inference ($0.10/month free credits).
      </p>

      {/* OAuth button — only on HF Spaces */}
      {oauthAvailable && (
        <>
          <Button
            onClick={handleOAuthLogin}
            className="w-full gap-2"
            variant="outline"
          >
            Sign in with HuggingFace
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                Or use an access token
              </span>
            </div>
          </div>
        </>
      )}

      {/* API key input — always available */}
      <div>
        <Label htmlFor="hf-token" className="text-xs">Access Token</Label>
        <div className="flex gap-2 mt-1.5">
          <div className="relative flex-1">
            <Input
              id="hf-token"
              type={showToken ? 'text' : 'password'}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && tokenInput.trim()) handleConnect(); }}
              placeholder="hf_..."
              className="pr-10"
              disabled={isConnecting}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => setShowToken(!showToken)}
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <Button
            onClick={handleConnect}
            disabled={isConnecting || !tokenInput.trim()}
            size="sm"
          >
            {isConnecting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </div>
      </div>

      <div className="p-3 border rounded-md bg-muted/50 text-xs text-muted-foreground space-y-2">
        <p className="font-medium">How to get an access token:</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>
            Go to{' '}
            <a
              href="https://huggingface.co/settings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              huggingface.co/settings/tokens <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </li>
          <li>Create a new token with &quot;Make calls to Inference Providers&quot; permission</li>
          <li>Paste the token above and click Connect</li>
        </ol>
        {!oauthAvailable && (
          <p className="text-muted-foreground/70 mt-1">
            OAuth sign-in is available when deployed on HuggingFace Spaces.
          </p>
        )}
      </div>
    </div>
  );
}
