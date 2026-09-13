'use client';

import { useState, useEffect } from 'react';
import { configManager } from '@/lib/config/storage';
import { Switch } from '@/components/ui/switch';
import { useTheme } from 'next-themes';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { setTelemetryOptIn } from '@/lib/telemetry';
import { Palette } from 'lucide-react';
import { toast } from 'sonner';
import { emitViewChanged, writeLocalStudioView } from '@/lib/view-mode-event';
import { useStudioView } from '@/components/view-mode-provider';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { SettingRow } from '@/components/ui/setting-row';

export function AppearancePane() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Where the choice is kept differs: server mode holds it on the account so it follows the person
  // between devices, browser mode on the device because there is no account to hold it.
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  /**
   * Read from context, which already has the answer: server mode seeds it during the page's own
   * server render and browser mode reads it from storage, so it is there on the first paint.
   *
   * Fetching it here instead left the row out of the first render and dropped it in above Theme a
   * round trip later, moving everything below it.
   */
  const studioView = useStudioView();
  /**
   * The choice being saved, shown until context catches up.
   *
   * Server mode writes to the account and then announces it, so the refreshed value arrives a
   * request after the press; without this the toggle would sit on the old answer in between.
   */
  const [pendingView, setPendingView] = useState<boolean | null>(null);
  const [savingView, setSavingView] = useState(false);
  const [telemetryOptIn, setTelemetryOptInState] = useState(() =>
    configManager.getSettings().telemetryOptIn !== false
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (pendingView !== null && studioView === pendingView) setPendingView(null);
  }, [studioView, pendingView]);

  const changeView = async (studio: boolean) => {
    if (!isServerMode) {
      // Local, synchronous, and it announces itself, so context has the new value already.
      writeLocalStudioView(studio);
      return;
    }
    setPendingView(studio);
    setSavingView(true);
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studioView: studio }),
      });
      if (!res.ok) throw new Error('Failed to change the view');
      emitViewChanged();
    } catch {
      setPendingView(null);
      toast.error('Could not change the view');
    } finally {
      setSavingView(false);
    }
  };

  return (
    <Section>
      <SectionHeader icon={Palette} title="Appearance" />
      <SectionBody className="px-4 py-1">
        <SettingRow
          title="Interface"
          description="The studio is the full editor. The simple view is projects and deployments, and a project opens straight into quick edit."
        >
          <ToggleGroup
            type="single"
            value={(pendingView ?? studioView) ? 'studio' : 'simple'}
            onValueChange={(v) => { if (v && !savingView) changeView(v === 'studio'); }}
            disabled={savingView}
          >
            <ToggleGroupItem value="studio">Studio</ToggleGroupItem>
            <ToggleGroupItem value="simple">Simple</ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>

        <SettingRow title="Theme" description="Interface color scheme">
          <ToggleGroup
            type="single"
            value={mounted ? (theme || 'dark') : 'dark'}
            onValueChange={(value: string) => {
              if (value) {
                setTheme(value);
                configManager.setSetting('theme', value as 'light' | 'dark' | 'system');
              }
            }}
          >
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="system">System</ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>

        <SettingRow
          title="Anonymous usage analytics"
          description="Share anonymous usage data to help improve OSW Studio"
        >
          <Switch
            id="telemetry"
            checked={telemetryOptIn}
            onCheckedChange={(checked) => {
              setTelemetryOptInState(checked);
              setTelemetryOptIn(checked);
            }}
          />
        </SettingRow>
      </SectionBody>
    </Section>
  );
}
