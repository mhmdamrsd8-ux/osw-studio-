/** Shape returned by `POST /api/ollama/preflight`; the settings pane renders it. */

export interface PreflightCheck {
  id: 'reachable' | 'models' | 'model_pulled' | 'tools' | 'context';
  ok: boolean;
  detail: string;
  fix?: string;
  /** Set on the unreachable row when this instance is hosted and cannot reach the user's machine at all. */
  hosted?: true;
  /** Set on the context row when the model's limit is below the configured context length. */
  capped?: true;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  version?: string;
  models: string[];
}

