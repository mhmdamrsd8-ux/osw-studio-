import { track } from '@/lib/telemetry';
import { configManager } from '@/lib/config/storage';
import type { ModelAssignment } from '@/lib/llm/models/assignment';

/**
 * `provider_selected`, emitted where a provider is actually chosen now.
 *
 * `ModelSettingsPanel` also emits it, but that component is rendered only by the internal
 * `/test-generation` page, so an event fired from there alone reads in the analytics as nobody
 * setting up a provider. The choice happens in the models dialog, on a slot edit or a template
 * switch, so those sites call this.
 *
 * Fires only when the agent's provider changes, not on every model pick: `model_selected` covers
 * the model. `has_api_key` is a boolean, never the key.
 */
export function trackAgentProviderChange(before: ModelAssignment | null | undefined, after: ModelAssignment | null | undefined): void {
  const from = before?.agent?.provider;
  const to = after?.agent?.provider;
  if (!to || to === from) return;
  track('provider_selected', { provider: to, has_api_key: !!configManager.getProviderApiKey(to) });
}
