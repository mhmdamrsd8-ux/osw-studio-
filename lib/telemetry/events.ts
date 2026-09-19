/**
 * Single source of truth for telemetry events. The type union and the
 * disclosure dialog's "what will be collected" list both derive from this
 * catalog, so an event cannot be disclosed without existing or exist without
 * being disclosed.
 */

export const DISCLOSURE_CATEGORIES = [
  { id: 'usage', label: 'App usage' },
  { id: 'generation', label: 'AI generation' },
  { id: 'projects', label: 'Projects and deployments' },
  { id: 'features', label: 'Feature usage' },
] as const;

export type DisclosureCategoryId = (typeof DISCLOSURE_CATEGORIES)[number]['id'];

export interface TelemetryEventDef {
  /** Grouping for the disclosure dialog. */
  category: DisclosureCategoryId;
  /** User-facing line rendered in the disclosure dialog. */
  disclosure: string;
}

export const EVENT_CATALOG = {
  // usage
  session_start:      { category: 'usage', disclosure: 'When a session starts, the site that linked here (hostname only) and any utm_source/medium/campaign tag in the address' },
  pageview:           { category: 'usage', disclosure: 'Which views are visited (e.g. dashboard, workspace, settings)' },
  heartbeat:          { category: 'usage', disclosure: 'Session heartbeats (how long the app is open)' },
  telemetry_accepted: { category: 'usage', disclosure: 'That the analytics notice was acknowledged' },
  telemetry_disabled: { category: 'usage', disclosure: 'That analytics were turned off (final event before stopping)' },
  tour_started:       { category: 'usage', disclosure: 'Whether the guided tour is started, completed, or exited early (and at which step)' },
  tour_completed:     { category: 'usage', disclosure: 'Whether the guided tour is started, completed, or exited early (and at which step)' },
  tour_abandoned:     { category: 'usage', disclosure: 'Whether the guided tour is started, completed, or exited early (and at which step)' },

  // generation
  provider_selected:  { category: 'generation', disclosure: 'Which AI providers are selected (and whether a key is set, never the key)' },
  model_selected:     { category: 'generation', disclosure: 'Which AI models are selected' },
  task_started:       { category: 'generation', disclosure: 'When a generation task starts' },
  task_complete:      { category: 'generation', disclosure: 'Whether tasks succeed, with duration and tool/turn counts (not what was asked)' },
  task_fail:          { category: 'generation', disclosure: 'Whether tasks fail and why in broad terms (api error vs stopped), how long the task ran, never the error message itself' },
  task_nudged:        { category: 'generation', disclosure: 'How often the AI needs a reminder to finish properly' },
  tool_call:          { category: 'generation', disclosure: 'Which tools the AI uses, whether they work, and how long they take (never file paths, arguments, or contents)' },
  api_error:          { category: 'generation', disclosure: 'API and tool error types (not error messages)' },
  compaction_fired:   { category: 'generation', disclosure: 'Whether conversation compaction ran, with token counts only (not messages)' },
  agent_spawned:      { category: 'generation', disclosure: 'When the AI delegates to a sub-agent (explore, plan, task)' },
  skill_read:         { category: 'generation', disclosure: 'Whether the AI consulted a skill file (built-in skill names only; custom skills are counted anonymously)' },
  ask_response:       { category: 'generation', disclosure: 'Whether AI questions are answered by tapping an option or typing' },
  approval_response:  { category: 'generation', disclosure: 'Whether a paused server-side permission request was allowed or denied' },

  // projects
  project_create:     { category: 'projects', disclosure: 'Which creation flow and runtime are used when a project is created (e.g. quick vs. describe, static vs. react)' },
  project_open:       { category: 'projects', disclosure: 'When a project is opened, deleted, exported, or imported (never its name or contents; export format only)' },
  project_delete:     { category: 'projects', disclosure: 'When a project is opened, deleted, exported, or imported (never its name or contents; export format only)' },
  project_export:     { category: 'projects', disclosure: 'When a project is opened, deleted, exported, or imported (never its name or contents; export format only)' },
  project_import:     { category: 'projects', disclosure: 'When a project is opened, deleted, exported, or imported (never its name or contents; export format only)' },
  runtime_switch:     { category: 'projects', disclosure: 'When a project runtime is switched (e.g. static to react)' },
  deployment_create:  { category: 'projects', disclosure: 'When deployments are created, published, or deleted, and whether a custom domain is configured (not the domain)' },
  deployment_publish: { category: 'projects', disclosure: 'When deployments are created, published, or deleted, and whether a custom domain is configured (not the domain)' },
  deployment_delete:  { category: 'projects', disclosure: 'When deployments are created, published, or deleted, and whether a custom domain is configured (not the domain)' },
  custom_domain_set:  { category: 'projects', disclosure: 'When deployments are created, published, or deleted, and whether a custom domain is configured (not the domain)' },
  backend_feature_enabled: { category: 'projects', disclosure: 'Which kinds of backend features are enabled (e.g. database, functions)' },
  sync_manual:        { category: 'projects', disclosure: 'Manual server sync usage by item type and direction (never item names or contents)' },
  sync_fail:          { category: 'projects', disclosure: 'Whether server sync operations fail (not the data involved)' },

  // features
  mode_switch:        { category: 'features', disclosure: 'Switches between Chat, Code, and Interview modes' },
  quick_edit_opened:  { category: 'features', disclosure: 'When a project is opened in quick edit' },
  stop_reason_shown:  { category: 'generation', disclosure: 'That the "why did you stop?" question was shown after a task was stopped, and which of its fixed answers was picked, if any' },
  stop_reason:        { category: 'generation', disclosure: 'That the "why did you stop?" question was shown after a task was stopped, and which of its fixed answers was picked, if any' },
  interview_started:  { category: 'features', disclosure: 'Interview usage: which built-in template is used (custom templates counted anonymously) and whether interviews complete' },
  interview_completed:{ category: 'features', disclosure: 'Interview usage: which built-in template is used (custom templates counted anonymously) and whether interviews complete' },
  interview_abandoned:{ category: 'features', disclosure: 'Interview usage: which built-in template is used (custom templates counted anonymously) and whether interviews complete' },
  handoff_used:       { category: 'features', disclosure: 'Whether the interview handoff button is used' },
  skill_created:      { category: 'features', disclosure: 'That custom skills or templates are created or deleted (counts only, never names or contents)' },
  skill_deleted:      { category: 'features', disclosure: 'That custom skills or templates are created or deleted (counts only, never names or contents)' },
  interview_template_created: { category: 'features', disclosure: 'That custom skills or templates are created or deleted (counts only, never names or contents)' },
  interview_template_deleted: { category: 'features', disclosure: 'That custom skills or templates are created or deleted (counts only, never names or contents)' },
  model_template_created:     { category: 'features', disclosure: 'That custom skills or templates are created or deleted (counts only, never names or contents)' },
  model_template_deleted:     { category: 'features', disclosure: 'That custom skills or templates are created or deleted (counts only, never names or contents)' },
  preflight_result:   { category: 'features', disclosure: 'Whether a local model server check passed and which checks failed (never endpoints or model names)' },
  connection_added:   { category: 'features', disclosure: 'Which provider connections are added or removed and how (sign-in, pasted key, local server; never keys or endpoints)' },
  connection_removed: { category: 'features', disclosure: 'Which provider connections are added or removed (never keys or endpoints)' },
  image_attached:     { category: 'features', disclosure: 'Whether an image was attached to a chat message (not the image itself)' },
  voice_input_used:   { category: 'features', disclosure: 'Whether voice input is used and how the clip is handled (never audio or transcripts)' },
  code_edited:        { category: 'features', disclosure: 'Whether project code was edited by hand during a session (a yes/no, nothing about the edits)' },
  checkpoint_restore: { category: 'features', disclosure: 'Whether checkpoints are restored or changes discarded' },
  changes_discarded:  { category: 'features', disclosure: 'Whether checkpoints are restored or changes discarded' },
} as const satisfies Record<string, TelemetryEventDef>;

export type TelemetryEventName = keyof typeof EVENT_CATALOG;

export type TelemetryEventProperties = Record<string, unknown>;

export interface TelemetryEvent {
  event: TelemetryEventName;
  timestamp: number;
  fields: Record<string, unknown>;
}

/** Deduplicated disclosure lines per category, in catalog order. */
export function getDisclosureLines(): { label: string; lines: string[] }[] {
  return DISCLOSURE_CATEGORIES.map(cat => {
    const lines: string[] = [];
    for (const def of Object.values(EVENT_CATALOG)) {
      if (def.category === cat.id && !lines.includes(def.disclosure)) lines.push(def.disclosure);
    }
    return { label: cat.label, lines };
  }).filter(g => g.lines.length > 0);
}
