import { TelemetryTracker } from './tracker';
import { TelemetryEventName, TelemetryEventProperties } from './events';

let tracker: TelemetryTracker | null = null;

export function initTelemetry(): void {
  if (tracker) return;
  tracker = new TelemetryTracker();
  tracker.init();
}

export function track(event: TelemetryEventName, properties?: TelemetryEventProperties): void {
  tracker?.track(event, properties);
}

/**
 * Whether telemetry is actually being sent. UI whose only purpose is to produce an event, such
 * as the "why did you stop?" ask, checks this so that someone who opted out is never asked to
 * feed a system they turned off. Being asked anyway would read as the opt-out not sticking.
 */
export function isTelemetryActive(): boolean {
  return tracker?.isActive() ?? false;
}

export function setTelemetryOptIn(value: boolean): void {
  tracker?.setOptIn(value);
}
