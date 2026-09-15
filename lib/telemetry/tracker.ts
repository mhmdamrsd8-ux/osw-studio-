import { TelemetryEvent, TelemetryEventName, TelemetryEventProperties } from './events';
import {
  TELEMETRY_ENDPOINT,
  TELEMETRY_TOKEN,
  TELEMETRY_ENABLED,
  TELEMETRY_DEBUG,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_SIZE,
  MAX_RETRIES,
  RETRY_BASE_MS,
  HEARTBEAT_INTERVAL_MS,
  detectDeploymentType,
  getAppVersion,
  detectOsPlatform,
  getManagedContext,
} from './config';
import { configManager } from '@/lib/config/storage';

const VISITOR_ID_KEY = 'osw-telemetry-vid';

function getOrCreateVisitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(VISITOR_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

export class TelemetryTracker {
  private queue: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private optedIn = true;
  private initialized = false;
  private sessionStartTime = 0;
  private flushing = false;
  private visitorId = 'unknown';
  private deploymentType = 'browser';
  private osPlatform = 'unknown';
  private appVersion = 'unknown';
  private managedContext: Record<string, string> | null = null;

  init(): void {
    try {
      if (typeof window === 'undefined') return;
      if (this.initialized) return;
      if (!TELEMETRY_ENABLED) return;

      this.optedIn = configManager.getSettings().telemetryOptIn !== false;
      this.visitorId = getOrCreateVisitorId();
      this.deploymentType = detectDeploymentType();
      this.osPlatform = detectOsPlatform();
      this.appVersion = getAppVersion();
      this.managedContext = getManagedContext();
      this.sessionStartTime = Date.now();
      this.initialized = true;

      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);

      this.heartbeatTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
          this.track('heartbeat', { uptime_ms: Date.now() - this.sessionStartTime });
        }
      }, HEARTBEAT_INTERVAL_MS);

      window.addEventListener('beforeunload', this.handleUnload);
      document.addEventListener('visibilitychange', this.handleVisibility);

      this.debug('Telemetry initialized', { optedIn: this.optedIn });
    } catch {
      // silently ignore
    }
  }

  track(event: TelemetryEventName, properties?: TelemetryEventProperties): void {
    try {
      if (!this.initialized || !this.optedIn || !TELEMETRY_ENABLED) return;

      const entry: TelemetryEvent = {
        event,
        timestamp: Date.now(),
        fields: {
          vid: this.visitorId,
          deployment_type: this.deploymentType,
          os_platform: this.osPlatform,
          app_version: this.appVersion,
          ...(this.managedContext ?? {}),
          ...(properties ?? {}),
        },
      };

      this.queue.push(entry);
      this.debug('track', entry);

      if (this.queue.length >= MAX_BATCH_SIZE) {
        this.flush();
      }
    } catch {
      // silently ignore
    }
  }

  /** The same test `track` applies before sending. Anything that only exists to feed telemetry should ask this first. */
  isActive(): boolean {
    return this.initialized && this.optedIn && TELEMETRY_ENABLED;
  }

  setOptIn(value: boolean): void {
    try {
      if (!value && this.optedIn) {
        this.track('telemetry_disabled');
        if (this.flushing) {
          this.beaconFlush();
        } else {
          this.flush();
        }
      }
      this.optedIn = value;
      configManager.setSetting('telemetryOptIn', value);
      if (!value) {
        this.queue = [];
        try { localStorage.removeItem(VISITOR_ID_KEY); } catch {}
        this.visitorId = 'unknown';
      } else {
        this.visitorId = getOrCreateVisitorId();
      }
    } catch {
      // silently ignore
    }
  }

  async flush(): Promise<void> {
    try {
      if (this.queue.length === 0 || this.flushing) return;
      this.flushing = true;

      const batch = this.queue.splice(0);
      let attempt = 0;
      let success = false;

      while (attempt < MAX_RETRIES && !success) {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (TELEMETRY_TOKEN) {
            headers['Authorization'] = `Bearer ${TELEMETRY_TOKEN}`;
          }
          const res = await fetch(TELEMETRY_ENDPOINT, {
            method: 'POST',
            headers,
            body: JSON.stringify({ events: batch }),
            credentials: 'omit',
          });
          if (res.ok) {
            success = true;
            this.debug(`Flushed ${batch.length} events`);
          } else {
            attempt++;
            if (attempt < MAX_RETRIES) {
              await this.sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
            }
          }
        } catch {
          attempt++;
          if (attempt < MAX_RETRIES) {
            await this.sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
          }
        }
      }

      if (!success) {
        this.debug(`Dropped ${batch.length} events after ${MAX_RETRIES} retries`);
      }
    } catch {
      // silently ignore
    } finally {
      this.flushing = false;
    }
  }

  private handleUnload = () => {
    this.beaconFlush();
  };

  private handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      this.beaconFlush();
    }
  };

  private beaconFlush(): void {
    if (this.queue.length === 0) return;
    try {
      const body: Record<string, unknown> = { events: this.queue.splice(0) };
      if (TELEMETRY_TOKEN) {
        body.token = TELEMETRY_TOKEN;
      }
      const json = JSON.stringify(body);
      // Use fetch with keepalive instead of sendBeacon to avoid CORS
      // issues (sendBeacon sends with credentials: 'include' by default,
      // which is incompatible with Access-Control-Allow-Origin: *)
      fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // silently ignore
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private debug(...args: unknown[]): void {
    if (TELEMETRY_DEBUG) {
      // eslint-disable-next-line no-console
      console.debug('[telemetry]', ...args);
    }
  }
}
