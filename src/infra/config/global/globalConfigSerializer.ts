import type { GlobalConfig } from '../../../core/models/config-types.js';
import {
  denormalizeProviderProfiles,
  denormalizePieceOverrides,
  denormalizeProviderOptions,
} from '../configNormalizers.js';

export function serializeGlobalConfig(config: GlobalConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    language: config.language,
    provider: config.provider,
  };
  if (config.model) {
    raw.model = config.model;
  }
  if (config.logging && (
    config.logging.level !== undefined
    || config.logging.trace !== undefined
    || config.logging.debug !== undefined
    || config.logging.providerEvents !== undefined
    || config.logging.usageEvents !== undefined
  )) {
    raw.logging = {
      ...(config.logging.level !== undefined ? { level: config.logging.level } : {}),
      ...(config.logging.trace !== undefined ? { trace: config.logging.trace } : {}),
      ...(config.logging.debug !== undefined ? { debug: config.logging.debug } : {}),
      ...(config.logging.providerEvents !== undefined ? { provider_events: config.logging.providerEvents } : {}),
      ...(config.logging.usageEvents !== undefined ? { usage_events: config.logging.usageEvents } : {}),
    };
  }
  if (config.analytics) {
    const analyticsRaw: Record<string, unknown> = {};
    if (config.analytics.enabled !== undefined) analyticsRaw.enabled = config.analytics.enabled;
    if (config.analytics.eventsPath) analyticsRaw.events_path = config.analytics.eventsPath;
    if (config.analytics.retentionDays !== undefined) analyticsRaw.retention_days = config.analytics.retentionDays;
    if (Object.keys(analyticsRaw).length > 0) {
      raw.analytics = analyticsRaw;
    }
  }
  if (config.worktreeDir) {
    raw.worktree_dir = config.worktreeDir;
  }
  if (config.allowGitHooks !== undefined) {
    raw.allow_git_hooks = config.allowGitHooks;
  }
  if (config.allowGitFilters !== undefined) {
    raw.allow_git_filters = config.allowGitFilters;
  }
  if (config.autoPr !== undefined) {
    raw.auto_pr = config.autoPr;
  }
  if (config.draftPr !== undefined) {
    raw.draft_pr = config.draftPr;
  }
  if (config.disabledBuiltins && config.disabledBuiltins.length > 0) {
    raw.disabled_builtins = config.disabledBuiltins;
  }
  if (config.enableBuiltinPieces !== undefined) {
    raw.enable_builtin_pieces = config.enableBuiltinPieces;
  }
  if (config.anthropicApiKey) {
    raw.anthropic_api_key = config.anthropicApiKey;
  }
  if (config.openaiApiKey) {
    raw.openai_api_key = config.openaiApiKey;
  }
  if (config.geminiApiKey) {
    raw.gemini_api_key = config.geminiApiKey;
  }
  if (config.googleApiKey) {
    raw.google_api_key = config.googleApiKey;
  }
  if (config.groqApiKey) {
    raw.groq_api_key = config.groqApiKey;
  }
  if (config.openrouterApiKey) {
    raw.openrouter_api_key = config.openrouterApiKey;
  }
  if (config.codexCliPath) {
    raw.codex_cli_path = config.codexCliPath;
  }
  if (config.claudeCliPath) {
    raw.claude_cli_path = config.claudeCliPath;
  }
  if (config.cursorCliPath) {
    raw.cursor_cli_path = config.cursorCliPath;
  }
  if (config.copilotCliPath) {
    raw.copilot_cli_path = config.copilotCliPath;
  }
  if (config.copilotGithubToken) {
    raw.copilot_github_token = config.copilotGithubToken;
  }
  if (config.opencodeApiKey) {
    raw.opencode_api_key = config.opencodeApiKey;
  }
  if (config.cursorApiKey) {
    raw.cursor_api_key = config.cursorApiKey;
  }
  if (config.bookmarksFile) {
    raw.bookmarks_file = config.bookmarksFile;
  }
  if (config.pieceCategoriesFile) {
    raw.piece_categories_file = config.pieceCategoriesFile;
  }
  const rawProviderOptions = denormalizeProviderOptions(config.providerOptions);
  if (rawProviderOptions) {
    raw.provider_options = rawProviderOptions;
  }
  const rawProviderProfiles = denormalizeProviderProfiles(config.providerProfiles);
  if (rawProviderProfiles && Object.keys(rawProviderProfiles).length > 0) {
    raw.provider_profiles = rawProviderProfiles;
  }
  if (config.runtime?.prepare && config.runtime.prepare.length > 0) {
    raw.runtime = {
      prepare: [...new Set(config.runtime.prepare)],
    };
  }
  if (config.preventSleep !== undefined) {
    raw.prevent_sleep = config.preventSleep;
  }
  if (config.notificationSound !== undefined) {
    raw.notification_sound = config.notificationSound;
  }
  if (config.notificationSoundEvents) {
    const eventRaw: Record<string, unknown> = {};
    if (config.notificationSoundEvents.iterationLimit !== undefined) {
      eventRaw.iteration_limit = config.notificationSoundEvents.iterationLimit;
    }
    if (config.notificationSoundEvents.pieceComplete !== undefined) {
      eventRaw.piece_complete = config.notificationSoundEvents.pieceComplete;
    }
    if (config.notificationSoundEvents.pieceAbort !== undefined) {
      eventRaw.piece_abort = config.notificationSoundEvents.pieceAbort;
    }
    if (config.notificationSoundEvents.runComplete !== undefined) {
      eventRaw.run_complete = config.notificationSoundEvents.runComplete;
    }
    if (config.notificationSoundEvents.runAbort !== undefined) {
      eventRaw.run_abort = config.notificationSoundEvents.runAbort;
    }
    if (Object.keys(eventRaw).length > 0) {
      raw.notification_sound_events = eventRaw;
    }
  }
  if (config.autoFetch) {
    raw.auto_fetch = config.autoFetch;
  }
  if (config.baseBranch) {
    raw.base_branch = config.baseBranch;
  }
  const denormalizedPieceOverrides = denormalizePieceOverrides(config.pieceOverrides);
  if (denormalizedPieceOverrides) {
    raw.piece_overrides = denormalizedPieceOverrides;
  }
  // Project-local keys (also accepted in global config)
  if (config.pipeline) {
    const pipelineRaw: Record<string, unknown> = {};
    if (config.pipeline.defaultBranchPrefix !== undefined) {
      pipelineRaw.default_branch_prefix = config.pipeline.defaultBranchPrefix;
    }
    if (config.pipeline.commitMessageTemplate !== undefined) {
      pipelineRaw.commit_message_template = config.pipeline.commitMessageTemplate;
    }
    if (config.pipeline.prBodyTemplate !== undefined) {
      pipelineRaw.pr_body_template = config.pipeline.prBodyTemplate;
    }
    if (Object.keys(pipelineRaw).length > 0) raw.pipeline = pipelineRaw;
  }
  if (config.personaProviders && Object.keys(config.personaProviders).length > 0) {
    raw.persona_providers = config.personaProviders;
  }
  if (config.branchNameStrategy !== undefined) {
    raw.branch_name_strategy = config.branchNameStrategy;
  }
  if (config.minimalOutput !== undefined) {
    raw.minimal_output = config.minimalOutput;
  }
  if (config.concurrency !== undefined) {
    raw.concurrency = config.concurrency;
  }
  if (config.taskPollIntervalMs !== undefined) {
    raw.task_poll_interval_ms = config.taskPollIntervalMs;
  }
  if (config.interactivePreviewMovements !== undefined) {
    raw.interactive_preview_movements = config.interactivePreviewMovements;
  }
  return raw;
}
