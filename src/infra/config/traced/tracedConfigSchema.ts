import type { Origin, SchemaShape } from 'traced-config';
import {
  GLOBAL_ENV_SPECS,
  PROJECT_ENV_SPECS,
  envVarNameFromPath,
  type EnvSpec,
  type EnvValueType,
} from '../env/config-env-overrides.js';
import {
  PROVIDER_OPTIONS_TRACKED_KEYS,
} from '../providerOptionsContract.js';

const PROJECT_TRACKED_KEYS = [
  'language',
  'provider',
  'model',
  'logging',
  'worktree_dir',
  'allow_git_hooks',
  'allow_git_filters',
  'vcs_provider',
  'auto_pr',
  'draft_pr',
  'disabled_builtins',
  'enable_builtin_pieces',
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'google_api_key',
  'groq_api_key',
  'openrouter_api_key',
  'codex_cli_path',
  'claude_cli_path',
  'cursor_cli_path',
  'copilot_cli_path',
  'copilot_github_token',
  'opencode_api_key',
  'cursor_api_key',
  'bookmarks_file',
  'piece_categories_file',
  'submodules',
  'with_submodules',
  'concurrency',
  'pipeline',
  'pipeline.default_branch_prefix',
  'pipeline.commit_message_template',
  'pipeline.pr_body_template',
  'takt_providers',
  'persona_providers',
  'branch_name_strategy',
  'minimal_output',
  'task_poll_interval_ms',
  'interactive_preview_movements',
  'interactive_preview_steps',
  'analytics',
  'analytics.enabled',
  'analytics.events_path',
  'analytics.retention_days',
  'provider_profiles',
  'base_branch',
  'piece_overrides',
  'runtime',
  'runtime.prepare',
  'piece_runtime_prepare',
  'piece_runtime_prepare.custom_scripts',
  'piece_arpeggio',
  'piece_arpeggio.custom_data_source_modules',
  'piece_arpeggio.custom_merge_inline_js',
  'piece_arpeggio.custom_merge_files',
  'sync_conflict_resolver',
  'sync_conflict_resolver.auto_approve_tools',
  'piece_mcp_servers',
  'piece_mcp_servers.stdio',
  'piece_mcp_servers.sse',
  'piece_mcp_servers.http',
  'prevent_sleep',
  'notification_sound',
  'notification_sound_events',
  'auto_fetch',
  ...PROVIDER_OPTIONS_TRACKED_KEYS,
] as const;

const GLOBAL_TRACKED_KEYS = [
  'language',
  'provider',
  'model',
  'logging',
  'logging.level',
  'logging.trace',
  'logging.debug',
  'logging.provider_events',
  'logging.usage_events',
  'analytics',
  'analytics.enabled',
  'analytics.events_path',
  'analytics.retention_days',
  'worktree_dir',
  'allow_git_hooks',
  'allow_git_filters',
  'vcs_provider',
  'auto_pr',
  'draft_pr',
  'disabled_builtins',
  'enable_builtin_pieces',
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'google_api_key',
  'groq_api_key',
  'openrouter_api_key',
  'codex_cli_path',
  'claude_cli_path',
  'cursor_cli_path',
  'copilot_cli_path',
  'copilot_github_token',
  'opencode_api_key',
  'cursor_api_key',
  'bookmarks_file',
  'piece_categories_file',
  'provider_profiles',
  'piece_overrides',
  'pipeline',
  'takt_providers',
  'persona_providers',
  'branch_name_strategy',
  'minimal_output',
  'concurrency',
  'task_poll_interval_ms',
  'interactive_preview_movements',
  'interactive_preview_steps',
  'runtime',
  'runtime.prepare',
  'piece_runtime_prepare',
  'piece_runtime_prepare.custom_scripts',
  'piece_arpeggio',
  'piece_arpeggio.custom_data_source_modules',
  'piece_arpeggio.custom_merge_inline_js',
  'piece_arpeggio.custom_merge_files',
  'sync_conflict_resolver',
  'sync_conflict_resolver.auto_approve_tools',
  'piece_mcp_servers',
  'piece_mcp_servers.stdio',
  'piece_mcp_servers.sse',
  'piece_mcp_servers.http',
  'prevent_sleep',
  'notification_sound',
  'notification_sound_events',
  'notification_sound_events.iteration_limit',
  'notification_sound_events.piece_complete',
  'notification_sound_events.piece_abort',
  'notification_sound_events.run_complete',
  'notification_sound_events.run_abort',
  'auto_fetch',
  'base_branch',
  ...PROVIDER_OPTIONS_TRACKED_KEYS,
] as const;

const GLOBAL_DEFAULTS = new Map<string, unknown>([
  ['language', 'en'],
  ['provider', 'claude'],
  ['disabled_builtins', []],
  ['auto_fetch', false],
]);

export type TracedOrigin = Origin;

function envTypeToFormat(type: EnvValueType): unknown {
  if (type === 'boolean') return Boolean;
  if (type === 'number') return Number;
  if (type === 'json') return 'json';
  return String;
}

function buildTracedSchema(
  keys: readonly string[],
  envSpecs: readonly EnvSpec[],
  defaults: ReadonlyMap<string, unknown>,
  fileOrigin: 'global' | 'local',
): SchemaShape {
  const envSpecByPath = new Map(envSpecs.map((spec) => [spec.path, spec]));
  const schema: SchemaShape = {};

  for (const key of keys) {
    const envSpec = envSpecByPath.get(key);
    schema[key] = {
      default: defaults.get(key),
      doc: key,
      format: envSpec ? envTypeToFormat(envSpec.type) : undefined,
      env: envVarNameFromPath(key),
      sources: {
        global: fileOrigin === 'global',
        local: fileOrigin === 'local',
        env: envSpec !== undefined,
        cli: false,
      },
    };
  }

  return schema;
}

const globalTracedSchema = buildTracedSchema(
  GLOBAL_TRACKED_KEYS,
  GLOBAL_ENV_SPECS,
  GLOBAL_DEFAULTS,
  'global',
);
const projectTracedSchema = buildTracedSchema(
  PROJECT_TRACKED_KEYS,
  PROJECT_ENV_SPECS,
  new Map(),
  'local',
);

export function getGlobalTracedSchema(): SchemaShape {
  return globalTracedSchema;
}

export function getProjectTracedSchema(): SchemaShape {
  return projectTracedSchema;
}
