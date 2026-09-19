'use client';

import { useEffect, useState, useCallback } from 'react';
import { initTelemetry, track } from '@/lib/telemetry';
import { markSessionStartedOnce } from '@/lib/telemetry/session-guard';
import { sessionStartFields } from '@/lib/telemetry/session-fields';
import { configManager } from '@/lib/config/storage';
import { TelemetryDisclosure } from '@/components/telemetry-disclosure';

/**
 * Initializes telemetry and shows the first-run disclosure. Mounted by both
 * the browser-mode SPA (StudioApp) and the server-mode PageWrapper so every
 * deployment mode reports. The key's version re-shows the updated disclosure
 * once to users who saw an older one; users who opted out are never re-prompted.
 */
const DISCLOSED_KEY = 'osw-telemetry-disclosed-v4';

export function TelemetryBootstrap() {
  const [showDisclosure, setShowDisclosure] = useState(false);

  useEffect(() => {
    initTelemetry();
    // Once per page load, even though PageWrapper remounts on every server-mode
    // route navigation.
    if (markSessionStartedOnce()) {
      track('session_start', sessionStartFields(document.referrer, window.location.search, window.location.hostname));
    }
    try {
      const optedOut = configManager.getSettings().telemetryOptIn === false;
      if (!optedOut && !localStorage.getItem(DISCLOSED_KEY)) setShowDisclosure(true);
    } catch { /* never block the app on telemetry */ }
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISCLOSED_KEY, 'true');
    setShowDisclosure(false);
  }, []);

  return <TelemetryDisclosure open={showDisclosure} onDismiss={dismiss} />;
}
