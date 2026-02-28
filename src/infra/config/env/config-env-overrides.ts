type EnvValueType = 'string' | 'boolean' | 'number' | 'json';

interface EnvSpec {
  path: string;
  type: EnvValueType;
}

function normalizeEnvSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

export function envVarNameFromPath(path: string): string {
  const key = path
    .split('.')
    .map(normalizeEnvSegment)
    .filter((segment) => segment.length > 0)
    .join('_');
  return `TAKT_${key}`;
}

function parseEnvValue(envKey: string, raw: string, type: EnvValueType): unknown {
  if (type === 'string') {
    return raw;
  }
  if (type === 'boolean') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new Error(`${envKey} must be one of: true, false`);
  }
  if (type === 'number') {
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      throw new Error(`${envKey} must be a number`);
    }
    return value;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${envKey} must be valid JSON`);
  }
}

function setNested(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    const next = current[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (!leaf) return;
  current[leaf] = value;
}

function applyEnvOverrides(target: Record<string, unknown>, specs: readonly EnvSpec[]): void {
  for (const spec of specs) {
    const envKey = envVarNameFromPath(spec.path);
    const raw = process.env[envKey];
    if (raw === undefined) continue;
    const parsedValue = parseEnvValue(envKey, raw, spec.type);
    setNested(target, spec.path, parsedValue);
  }
}

const GLOBAL_ENV_SPECS: readonly EnvSpec[] = [
  { path: 'language', type: 'string' },
  { path: 'log_level', type: 'string' },
  { path: 'provider', type: 'string' },
  { path: 'model', type: 'string' },
  { path: 'observability', type: 'json' },
  { path: 'observability.provider_events', type: 'boolean' },
  { path: 'analytics', type: 'json' },
  { path: 'analytics.enabled', type: 'boolean' },
  { path: 'analytics.events_path', type: 'string' },
  { path: 'analytics.retention_days', type: 'number' },
  { path: 'worktree_dir', type: 'string' },
  { path: 'auto_pr', type: 'boolean' },
  { path: 'draft_pr', type: 'boolean' },
  { path: 'disabled_builtins', type: 'json' },
  { path: 'enable_builtin_pieces', type: 'boolean' },
  { path: 'anthropic_api_key', type: 'string' },
  { path: 'openai_api_key', type: 'string' },
  { path: 'codex_cli_path', type: 'string' },
  { path: 'claude_cli_path', type: 'string' },
  { path: 'cursor_cli_path', type: 'string' },
  { path: 'opencode_api_key', type: 'string' },
  { path: 'cursor_api_key', type: 'string' },
  { path: 'pipeline', type: 'json' },
  { path: 'pipeline.default_branch_prefix', type: 'string' },
  { path: 'pipeline.commit_message_template', type: 'string' },
  { path: 'pipeline.pr_body_template', type: 'string' },
  { path: 'minimal_output', type: 'boolean' },
  { path: 'bookmarks_file', type: 'string' },
  { path: 'piece_categories_file', type: 'string' },
  { path: 'persona_providers', type: 'json' },
  { path: 'provider_options', type: 'json' },
  { path: 'provider_options.codex.network_access', type: 'boolean' },
  { path: 'provider_options.opencode.network_access', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.allow_unsandboxed_commands', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.excluded_commands', type: 'json' },
  { path: 'provider_profiles', type: 'json' },
  { path: 'runtime', type: 'json' },
  { path: 'runtime.prepare', type: 'json' },
  { path: 'branch_name_strategy', type: 'string' },
  { path: 'prevent_sleep', type: 'boolean' },
  { path: 'notification_sound', type: 'boolean' },
  { path: 'notification_sound_events', type: 'json' },
  { path: 'notification_sound_events.iteration_limit', type: 'boolean' },
  { path: 'notification_sound_events.piece_complete', type: 'boolean' },
  { path: 'notification_sound_events.piece_abort', type: 'boolean' },
  { path: 'notification_sound_events.run_complete', type: 'boolean' },
  { path: 'notification_sound_events.run_abort', type: 'boolean' },
  { path: 'interactive_preview_movements', type: 'number' },
  { path: 'verbose', type: 'boolean' },
  { path: 'concurrency', type: 'number' },
  { path: 'task_poll_interval_ms', type: 'number' },
  { path: 'auto_fetch', type: 'boolean' },
  { path: 'base_branch', type: 'string' },
];

const PROJECT_ENV_SPECS: readonly EnvSpec[] = [
  { path: 'piece', type: 'string' },
  { path: 'provider', type: 'string' },
  { path: 'verbose', type: 'boolean' },
  { path: 'concurrency', type: 'number' },
  { path: 'analytics', type: 'json' },
  { path: 'analytics.enabled', type: 'boolean' },
  { path: 'analytics.events_path', type: 'string' },
  { path: 'analytics.retention_days', type: 'number' },
  { path: 'provider_options', type: 'json' },
  { path: 'provider_options.codex.network_access', type: 'boolean' },
  { path: 'provider_options.opencode.network_access', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.allow_unsandboxed_commands', type: 'boolean' },
  { path: 'provider_options.claude.sandbox.excluded_commands', type: 'json' },
  { path: 'provider_profiles', type: 'json' },
  { path: 'base_branch', type: 'string' },
  { path: 'claude_cli_path', type: 'string' },
  { path: 'codex_cli_path', type: 'string' },
  { path: 'cursor_cli_path', type: 'string' },
];

export function applyGlobalConfigEnvOverrides(target: Record<string, unknown>): void {
  applyEnvOverrides(target, GLOBAL_ENV_SPECS);
}

export function applyProjectConfigEnvOverrides(target: Record<string, unknown>): void {
  applyEnvOverrides(target, PROJECT_ENV_SPECS);
}
