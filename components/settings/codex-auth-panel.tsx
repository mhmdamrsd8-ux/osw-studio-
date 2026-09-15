'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, LogIn } from 'lucide-react';
import { ConnectionBadge } from '@/components/settings/connection-badge';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import {
  type CodexLoginInfo,
  startCodexLogin,
  completeCodexLogin,
  pollCodexLogin,
  disconnectCodex,
  checkCodexStatus,
} from '@/lib/auth/codex-auth';
import { track } from '@/lib/telemetry';

interface CodexAuthPanelProps {
  onAuthChange?: () => void;
}

export function CodexAuthPanel({ onAuthChange }: CodexAuthPanelProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(() =>
    !!configManager.getCodexAuth()
  );
  const [login, setLogin] = useState<CodexLoginInfo | null>(null);
  const [redirectUrl, setRedirectUrl] = useState('');
  const [isCompletingRedirect, setIsCompletingRedirect] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const auth = configManager.getCodexAuth();

  const dispatchAuthEvent = useCallback((hasKey: boolean) => {
    onAuthChange?.();
    window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
      detail: { provider: 'openai-codex', hasKey }
    }));
  }, [onAuthChange]);

  // Reconcile localStorage vs HttpOnly cookie on mount
  useEffect(() => {
    let cancelled = false;

    async function reconcile() {
      try {
        const hasCookie = await checkCodexStatus();
        if (cancelled) return;

        const localAuth = configManager.getCodexAuth();

        if (localAuth && !hasCookie) {
          configManager.clearCodexAuth();
          if (!cancelled) {
            setIsAuthenticated(false);
            dispatchAuthEvent(false);
          }
        } else if (!localAuth && hasCookie) {
          await disconnectCodex();
          if (!cancelled) {
            setIsAuthenticated(false);
            dispatchAuthEvent(false);
          }
        }
      } catch {
        // Network error — leave state as-is
      }
    }

    reconcile();
    return () => { cancelled = true; };
  }, [dispatchAuthEvent]);

  const finishLogin = useCallback((auth: NonNullable<ReturnType<typeof configManager.getCodexAuth>>) => {
    configManager.setCodexAuth(auth);
    setIsAuthenticated(true);
    setLogin(null);
    setRedirectUrl('');
    setIsCompletingRedirect(false);
    setIsLoading(false);
    toast.success('Connected to ChatGPT. Tokens will refresh automatically.');
    track('connection_added', { provider: 'openai-codex', method: 'oauth' });
    dispatchAuthEvent(true);
  }, [dispatchAuthEvent]);

  useEffect(() => {
    if (!login || login.manualCallback) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const auth = await pollCodexLogin();
        if (cancelled) return;
        if (!auth) {
          timer = setTimeout(poll, 1000);
          return;
        }

        finishLogin(auth);
      } catch (error) {
        if (cancelled) return;
        setLogin(null);
        setIsLoading(false);
        toast.error(error instanceof Error ? error.message : 'ChatGPT login failed');
      }
    };

    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login, finishLogin]);

  const handleLogin = async () => {
    setIsLoading(true);
    try {
      const nextLogin = await startCodexLogin();
      setLogin(nextLogin);
      setIsLoading(!nextLogin.manualCallback);
      window.open(nextLogin.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setIsLoading(false);
      toast.error(error instanceof Error ? error.message : 'Failed to start ChatGPT login');
    }
  };

  const handleManualCallback = async () => {
    setIsCompletingRedirect(true);
    try {
      finishLogin(await completeCodexLogin(redirectUrl.trim()));
    } catch (error) {
      setIsCompletingRedirect(false);
      toast.error(error instanceof Error ? error.message : 'Failed to complete ChatGPT login');
    }
  };

  const handleCancelLogin = async () => {
    setLogin(null);
    setRedirectUrl('');
    setIsCompletingRedirect(false);
    setIsLoading(false);
    await disconnectCodex().catch(() => {});
  };

  const handleDisconnect = async () => {
    setIsLoading(true);
    try {
      await disconnectCodex();
      configManager.clearModelCache('openai-codex');
      setIsAuthenticated(false);
      toast.success('Disconnected from ChatGPT');
      track('connection_removed', { provider: 'openai-codex' });
      dispatchAuthEvent(false);
    } catch {
      toast.error('Failed to disconnect. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const formatExpiry = () => {
    if (!auth?.expires_at) return '';
    const diff = auth.expires_at - Math.floor(Date.now() / 1000);
    if (diff <= 0) return 'Expired (will auto-refresh)';
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  if (isAuthenticated && auth) {
    return (
      <div className="space-y-3">
        <ConnectionBadge
          method="ChatGPT"
          extra={auth.user_email}
          info={auth.expires_at ? `Expires in ${formatExpiry()}` : undefined}
          onDisconnect={handleDisconnect}
          disconnecting={isLoading}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Label>ChatGPT Authentication</Label>
      <p className="text-xs text-muted-foreground">
        Login to your ChatGPT Plus/Pro subscription in browser instead of using an API key. Tokens are created and refreshed automatically once connected. No Codex CLI or device authorization is required.
      </p>

      {!login && (
        <div className="p-3 border rounded-md bg-muted/50 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Remote / self-hosted installation</p>
          <p>
            After ChatGPT approval, the localhost redirect tab will fail to load. Copy its full address-bar URL into a field shown below here after you have started the sign-in.
          </p>
        </div>
      )}

      {login ? (
        <div className="p-3 border rounded-md bg-muted/50 space-y-3">
          <p className="text-xs text-muted-foreground">
            If automatic redirection to OSW Studio fails after completing the ChatGPT login in the other browser tab, copy it's full redirect URL from the browser address bar into the field below.
          </p>
          {!login.manualCallback && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for authorization…
            </div>
          )}
          <Label htmlFor="codex-redirect-url" className="text-xs">Browser redirect URL</Label>
          <Input
            id="codex-redirect-url"
            value={redirectUrl}
            onChange={(event) => setRedirectUrl(event.target.value)}
            placeholder="http://localhost:1455/auth/callback?code=…"
            disabled={isCompletingRedirect}
          />
          <Button
            className="w-full"
            onClick={handleManualCallback}
            disabled={isCompletingRedirect || !redirectUrl.trim()}
          >
            {isCompletingRedirect && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Complete sign-in
          </Button>
          <div className="text-center">
            <Button size="sm" variant="ghost" onClick={handleCancelLogin}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button onClick={handleLogin} disabled={isLoading} className="w-full gap-2">
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          Sign in with ChatGPT
        </Button>
      )}
    </div>
  );
}
