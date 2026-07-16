/**
 * Global configuration public API.
 * Keep this file as a stable facade and delegate implementations to focused modules.
 */

export {
  invalidateGlobalConfigCache,
  loadGlobalConfig,
  saveGlobalConfig,
  validateCliPath,
} from './globalConfigCore.js';

export {
  getDisabledBuiltins,
  getBuiltinWorkflowsEnabled,
  getLanguage,
  setLanguage,
  setProvider,
  getRoutingTelemetryStatus,
  enableRoutingTelemetry,
  disableRoutingTelemetry,
  type RoutingTelemetryStatus,
} from './globalConfigAccessors.js';

export {
  resolveAnthropicApiKey,
  resolveOpenaiApiKey,
  resolveCodexCliPath,
  resolveClaudeCliPath,
  resolveCursorCliPath,
  resolveCopilotCliPath,
  resolveKiroCliPath,
  resolveCopilotGithubToken,
  resolveKiroApiKey,
  resolveOpencodeApiKey,
  resolveCursorApiKey,
} from './globalConfigResolvers.js';
