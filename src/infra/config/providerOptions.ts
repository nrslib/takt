import { resolve as resolvePath } from 'node:path';
import type {
  ClaudeEffort,
  ClaudeTerminalProviderOptions,
  CodexPermissionControl,
  CodexReasoningEffort,
  CopilotEffort,
  DeepSeekHarnessProviderOptions,
  OpenCodeGuardProfile,
  PiProviderOptions,
  WorkflowStep,
  StepProviderOptions,
} from '../../core/models/workflow-types.js';
import type { PersonaProviderEntry, ProviderRoutingConfig } from '../../core/models/config-types.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderOptionsTraceOrigin,
  ProviderResolutionSource,
} from '../../core/workflow/provider-options-trace.js';
import { resolveWorkflowStepTarget } from '../../core/workflow/provider-target-resolution.js';
import type { ProviderType } from '../../shared/types/provider.js';
import { isAbsolutePathLike } from '../../shared/utils/pathBoundary.js';
import { providerSupportsClaudeAllowedTools } from '../providers/provider-capabilities.js';

type RawProviderGuardOptions = {
  call_timeout_ms?: number;
};

type RawProviderOptions = {
  extends?: string;
  codex?: {
    base_url?: string;
    network_access?: boolean;
    permission_control?: CodexPermissionControl;
    reasoning_effort?: CodexReasoningEffort;
    fast_mode?: boolean;
    guards?: RawProviderGuardOptions;
    skills?: {
      repo?: boolean;
      user?: boolean;
    };
  };
  opencode?: {
    network_access?: boolean;
    variant?: string;
    allowed_tools?: string[];
    guards?: {
      profile?: OpenCodeGuardProfile;
      model_profiles?: Record<string, OpenCodeGuardProfile>;
      call_timeout_ms?: number;
      event_limit?: number;
      text_byte_limit?: number;
      reasoning_byte_limit?: number;
    };
  };
  claude?: {
    base_url?: string;
    allowed_tools?: string[];
    effort?: ClaudeEffort;
    guards?: RawProviderGuardOptions;
    skills?: {
      enabled?: boolean;
    };
    sandbox?: {
      allow_unsandboxed_commands?: boolean;
      excluded_commands?: string[];
    };
  };
  claude_terminal?: {
    backend?: ClaudeTerminalProviderOptions['backend'];
    guards?: RawProviderGuardOptions;
    timeout_ms?: number;
    keep_session?: boolean;
    transcript_poll_interval_ms?: number;
  };
  copilot?: {
    effort?: CopilotEffort;
    guards?: RawProviderGuardOptions;
  };
  kiro?: {
    agent?: string;
    guards?: RawProviderGuardOptions;
  };
  cursor?: {
    guards?: RawProviderGuardOptions;
  };
  deepseek_harness?: {
    python_path?: string;
    base_url?: string;
    session_root?: string;
    cordis?: string;
    max_tokens?: number;
    request_timeout_ms?: number;
    shutdown_timeout_ms?: number;
    runtime_mode?: 'exe' | 'node';
  };
  pi?: {
    guards?: RawProviderGuardOptions;
    extensions?: string[];
    no_extensions?: boolean;
    no_skills?: boolean;
    no_prompt_templates?: boolean;
    no_themes?: boolean;
    no_context_files?: boolean;
  };
};

type ProviderBaseUrlTrust = 'trusted' | 'loopback-only' | 'local-loopback-only';
type ProviderPythonPathTrust = 'trusted' | 'untrusted' | 'local-untrusted';
type ProviderPathTrust = 'trusted' | 'untrusted' | 'local-untrusted';
type ProviderCordisTrust = 'trusted' | 'untrusted' | 'local-untrusted';

export interface NormalizeProviderOptionsOptions {
  baseUrlTrust?: ProviderBaseUrlTrust;
  pythonPathTrust?: ProviderPythonPathTrust;
  pathTrust?: ProviderPathTrust;
  cordisTrust?: ProviderCordisTrust;
  pathPrefix?: string;
  getOrigin?: (path: string) => ProviderOptionsTraceOrigin;
}

export interface ProviderOptionsLayer {
  source: ProviderResolutionSource;
  options: StepProviderOptions | undefined;
}

interface StepProviderOptionsLayerContext {
  providerRouting: ProviderRoutingConfig | undefined;
  personaProviders: Record<string, PersonaProviderEntry> | undefined;
}

function isLoopbackBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || hostname === '[::1]'
    || isIpv4LoopbackHost(hostname);
}

function isIpv4LoopbackHost(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets[0] !== '127') {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function shouldRequireLoopbackBaseUrl(
  path: string,
  options: NormalizeProviderOptionsOptions,
): boolean {
  const trust = options.baseUrlTrust ?? 'trusted';
  if (trust === 'trusted') {
    return false;
  }
  if (trust === 'loopback-only') {
    return true;
  }

  const origin = options.getOrigin?.(path) ?? 'default';
  return origin === 'local' || origin === 'default';
}

function assertAllowedProviderBaseUrl(
  path: string,
  value: string | undefined,
  options: NormalizeProviderOptionsOptions,
): void {
  if (value === undefined || !shouldRequireLoopbackBaseUrl(path, options)) {
    return;
  }
  if (isLoopbackBaseUrl(value)) {
    return;
  }

  throw new Error(
    `Configuration error: ${path} must use a loopback base_url when defined by workflow or project config. `
    + 'Move non-loopback provider base URLs to global config or TAKT_PROVIDER_OPTIONS_*_BASE_URL.',
  );
}

function assertAllowedProviderPythonPath(
  path: string,
  value: string | undefined,
  options: NormalizeProviderOptionsOptions,
): void {
  if (value === undefined) {
    return;
  }
  const trust = options.pythonPathTrust ?? 'trusted';
  if (trust === 'trusted') {
    return;
  }
  if (trust === 'local-untrusted') {
    const origin = options.getOrigin?.(path) ?? 'default';
    if (origin !== 'local' && origin !== 'default') {
      return;
    }
  }

  throw new Error(
    `Configuration error: ${path} may only be set by trusted user configuration. `
    + 'Use global config or TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_PYTHON_PATH.',
  );
}

function hasParentPathSegment(value: string): boolean {
  return value.split(/[\\\\/]/u).some((segment) => segment === '..');
}

function assertTrustedProjectPath(
  path: string,
  value: string | undefined,
  options: NormalizeProviderOptionsOptions,
): void {
  if (value === undefined) {
    return;
  }
  const trust = options.pathTrust ?? 'trusted';
  if (trust === 'trusted') {
    return;
  }
  if (trust === 'local-untrusted') {
    const origin = options.getOrigin?.(path) ?? 'default';
    if (origin !== 'local' && origin !== 'default') {
      return;
    }
  }
  const trimmed = value.trim();
  if (!isAbsolutePathLike(trimmed) && !hasParentPathSegment(trimmed)) {
    return;
  }
  throw new Error(
    `Configuration error: ${path} must be a relative path without '..' traversal inside the project/session boundary.`,
  );
}

function assertAllowedProviderCordis(
  path: string,
  value: string | undefined,
  options: NormalizeProviderOptionsOptions,
): void {
  if (value === undefined) {
    return;
  }
  const trust = options.cordisTrust ?? options.pathTrust ?? 'trusted';
  if (trust === 'trusted') {
    return;
  }
  if (trust === 'untrusted') {
    const origin = options.getOrigin?.(path) ?? 'default';
    // Environment overrides are user-controlled even when the surrounding
    // project/config layer is untrusted. Repository and workflow values keep
    // the default origin and remain rejected.
    if (origin === 'env' || origin === 'global') {
      return;
    }
  }
  if (trust === 'local-untrusted') {
    const origin = options.getOrigin?.(path) ?? 'default';
    if (origin !== 'local' && origin !== 'default') {
      return;
    }
  }
  throw new Error(
    `Configuration error: ${path} may only be set by trusted user configuration. `
    + 'Use global config or TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_CORDIS.',
  );
}

export function assertAllowedNormalizedProviderBaseUrls(
  providerOptions: StepProviderOptions | undefined,
  options: NormalizeProviderOptionsOptions = {},
): void {
  const prefix = options.pathPrefix ?? 'provider_options';
  assertAllowedProviderBaseUrl(
    `${prefix}.codex.base_url`,
    providerOptions?.codex?.baseUrl,
    options,
  );
  assertAllowedProviderBaseUrl(
    `${prefix}.claude.base_url`,
    providerOptions?.claude?.baseUrl,
    options,
  );
  assertAllowedProviderBaseUrl(
    `${prefix}.deepseek_harness.base_url`,
    providerOptions?.deepseekHarness?.baseUrl,
    options,
  );
}

/** Convert raw YAML provider_options (snake_case) to internal format (camelCase). */
export function normalizeProviderOptions(
  raw: RawProviderOptions | Record<string, unknown> | undefined,
  normalizationOptions: NormalizeProviderOptionsOptions = {},
): StepProviderOptions | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const options = raw as RawProviderOptions;
  if (options.extends !== undefined) {
    throw new Error('Configuration error: provider_options.extends must be resolved before provider options normalization.');
  }

  const result: StepProviderOptions = {};
  if (
    options.codex?.base_url !== undefined
    || options.codex?.network_access !== undefined
    || options.codex?.permission_control !== undefined
    || options.codex?.reasoning_effort !== undefined
    || options.codex?.fast_mode !== undefined
    || options.codex?.guards !== undefined
    || options.codex?.skills?.repo !== undefined
    || options.codex?.skills?.user !== undefined
  ) {
    const codexBaseUrlPath = `${normalizationOptions.pathPrefix ?? 'provider_options'}.codex.base_url`;
    assertAllowedProviderBaseUrl(codexBaseUrlPath, options.codex.base_url, normalizationOptions);
    result.codex = {
      ...(options.codex.base_url !== undefined
        ? { baseUrl: options.codex.base_url }
        : {}),
      ...(options.codex.network_access !== undefined
        ? { networkAccess: options.codex.network_access }
        : {}),
      ...(options.codex.permission_control !== undefined
        ? { permissionControl: options.codex.permission_control }
        : {}),
      ...(options.codex.reasoning_effort !== undefined
        ? { reasoningEffort: options.codex.reasoning_effort }
        : {}),
      ...(options.codex.fast_mode !== undefined
        ? { fastMode: options.codex.fast_mode }
        : {}),
      ...(options.codex.guards?.call_timeout_ms !== undefined
        ? { guards: { callTimeoutMs: options.codex.guards.call_timeout_ms } }
        : {}),
      ...(options.codex.skills?.repo !== undefined || options.codex.skills?.user !== undefined
        ? {
            skills: {
              ...(options.codex.skills.repo !== undefined ? { repo: options.codex.skills.repo } : {}),
              ...(options.codex.skills.user !== undefined ? { user: options.codex.skills.user } : {}),
            },
          }
        : {}),
    };
  }
  if (
    options.opencode?.network_access !== undefined
    || options.opencode?.variant !== undefined
    || options.opencode?.allowed_tools !== undefined
    || options.opencode?.guards !== undefined
  ) {
    result.opencode = {
      ...(options.opencode.network_access !== undefined
        ? { networkAccess: options.opencode.network_access }
        : {}),
      ...(options.opencode.variant !== undefined
        ? { variant: options.opencode.variant }
        : {}),
      ...(options.opencode.allowed_tools !== undefined
        ? { allowedTools: options.opencode.allowed_tools }
        : {}),
      ...(options.opencode.guards !== undefined
        ? {
            guards: {
              ...(options.opencode.guards.profile !== undefined
                ? { profile: options.opencode.guards.profile }
                : {}),
              ...(options.opencode.guards.model_profiles !== undefined
                ? { modelProfiles: { ...options.opencode.guards.model_profiles } }
                : {}),
              ...(options.opencode.guards.call_timeout_ms !== undefined
                ? { callTimeoutMs: options.opencode.guards.call_timeout_ms }
                : {}),
              ...(options.opencode.guards.event_limit !== undefined
                ? { eventLimit: options.opencode.guards.event_limit }
                : {}),
              ...(options.opencode.guards.text_byte_limit !== undefined
                ? { textByteLimit: options.opencode.guards.text_byte_limit }
                : {}),
              ...(options.opencode.guards.reasoning_byte_limit !== undefined
                ? { reasoningByteLimit: options.opencode.guards.reasoning_byte_limit }
                : {}),
            },
          }
        : {}),
    };
  }
  if (
    options.claude?.base_url !== undefined
    || options.claude?.allowed_tools !== undefined
    || options.claude?.effort !== undefined
    || options.claude?.guards !== undefined
    || options.claude?.skills?.enabled !== undefined
    || options.claude?.sandbox
  ) {
    const claude: NonNullable<StepProviderOptions['claude']> = {};
    if (options.claude.base_url !== undefined) {
      const claudeBaseUrlPath = `${normalizationOptions.pathPrefix ?? 'provider_options'}.claude.base_url`;
      assertAllowedProviderBaseUrl(claudeBaseUrlPath, options.claude.base_url, normalizationOptions);
      claude.baseUrl = options.claude.base_url;
    }
    if (options.claude.allowed_tools !== undefined) {
      claude.allowedTools = options.claude.allowed_tools;
    }
    if (options.claude.effort !== undefined) {
      claude.effort = options.claude.effort;
    }
    if (options.claude.guards?.call_timeout_ms !== undefined) {
      claude.guards = { callTimeoutMs: options.claude.guards.call_timeout_ms };
    }
    if (options.claude.skills?.enabled !== undefined) {
      claude.skills = { enabled: options.claude.skills.enabled };
    }
    if (options.claude.sandbox) {
      const sandbox = {
        ...(options.claude.sandbox.allow_unsandboxed_commands !== undefined
          ? { allowUnsandboxedCommands: options.claude.sandbox.allow_unsandboxed_commands }
          : {}),
        ...(options.claude.sandbox.excluded_commands !== undefined
          ? { excludedCommands: options.claude.sandbox.excluded_commands }
          : {}),
      };
      if (Object.keys(sandbox).length > 0) {
        claude.sandbox = sandbox;
      }
    }
    if (Object.keys(claude).length > 0) {
      result.claude = claude;
    }
  }
  if (options.copilot?.effort !== undefined || options.copilot?.guards !== undefined) {
    result.copilot = {
      ...(options.copilot.effort !== undefined ? { effort: options.copilot.effort } : {}),
      ...(options.copilot.guards?.call_timeout_ms !== undefined
        ? { guards: { callTimeoutMs: options.copilot.guards.call_timeout_ms } }
        : {}),
    };
  }
  if (options.kiro?.agent !== undefined || options.kiro?.guards !== undefined) {
    result.kiro = {
      ...(options.kiro.agent !== undefined ? { agent: options.kiro.agent } : {}),
      ...(options.kiro.guards?.call_timeout_ms !== undefined
        ? { guards: { callTimeoutMs: options.kiro.guards.call_timeout_ms } }
        : {}),
    };
  }
  if (options.cursor?.guards !== undefined) {
    result.cursor = {
      ...(options.cursor.guards.call_timeout_ms !== undefined
        ? { guards: { callTimeoutMs: options.cursor.guards.call_timeout_ms } }
        : {}),
    };
  }
  if (options.deepseek_harness !== undefined) {
    const deepseekOptionsPath = `${normalizationOptions.pathPrefix ?? 'provider_options'}.deepseek_harness`;
    const deepseekBaseUrlPath = `${deepseekOptionsPath}.base_url`;
    assertAllowedProviderBaseUrl(
      deepseekBaseUrlPath,
      options.deepseek_harness.base_url,
      normalizationOptions,
    );
    assertAllowedProviderPythonPath(
      `${deepseekOptionsPath}.python_path`,
      options.deepseek_harness.python_path,
      normalizationOptions,
    );
    assertTrustedProjectPath(
      `${deepseekOptionsPath}.session_root`,
      options.deepseek_harness.session_root,
      normalizationOptions,
    );
    assertAllowedProviderCordis(
      `${deepseekOptionsPath}.cordis`,
      options.deepseek_harness.cordis,
      normalizationOptions,
    );
    const deepseekHarness: DeepSeekHarnessProviderOptions = {
      ...(options.deepseek_harness.python_path !== undefined
        ? { pythonPath: options.deepseek_harness.python_path }
        : {}),
      ...(options.deepseek_harness.base_url !== undefined
        ? { baseUrl: options.deepseek_harness.base_url }
        : {}),
      ...(options.deepseek_harness.session_root !== undefined
        ? { sessionRoot: options.deepseek_harness.session_root }
        : {}),
      ...(options.deepseek_harness.cordis !== undefined
        ? { cordis: options.deepseek_harness.cordis }
        : {}),
      ...(options.deepseek_harness.max_tokens !== undefined
        ? { maxTokens: options.deepseek_harness.max_tokens }
        : {}),
      ...(options.deepseek_harness.request_timeout_ms !== undefined
        ? { requestTimeoutMs: options.deepseek_harness.request_timeout_ms }
        : {}),
      ...(options.deepseek_harness.shutdown_timeout_ms !== undefined
        ? { shutdownTimeoutMs: options.deepseek_harness.shutdown_timeout_ms }
        : {}),
      ...(options.deepseek_harness.runtime_mode !== undefined
        ? { runtimeMode: options.deepseek_harness.runtime_mode }
        : {}),
    };
    if (Object.keys(deepseekHarness).length > 0) {
      result.deepseekHarness = deepseekHarness;
    }
  }
  if (options.pi !== undefined) {
    const pi: PiProviderOptions = {
      ...(options.pi.extensions !== undefined ? { extensions: [...options.pi.extensions] } : {}),
      ...(options.pi.no_extensions !== undefined ? { noExtensions: options.pi.no_extensions } : {}),
      ...(options.pi.no_skills !== undefined ? { noSkills: options.pi.no_skills } : {}),
      ...(options.pi.no_prompt_templates !== undefined
        ? { noPromptTemplates: options.pi.no_prompt_templates }
        : {}),
      ...(options.pi.no_themes !== undefined ? { noThemes: options.pi.no_themes } : {}),
      ...(options.pi.no_context_files !== undefined ? { noContextFiles: options.pi.no_context_files } : {}),
      ...(options.pi.guards?.call_timeout_ms !== undefined
        ? { guards: { callTimeoutMs: options.pi.guards.call_timeout_ms } }
        : {}),
    };
    if (Object.keys(pi).length > 0) {
      result.pi = pi;
    }
  }
  if (
    options.claude_terminal?.backend !== undefined
    || options.claude_terminal?.guards !== undefined
    || options.claude_terminal?.timeout_ms !== undefined
    || options.claude_terminal?.keep_session !== undefined
    || options.claude_terminal?.transcript_poll_interval_ms !== undefined
  ) {
    result.claudeTerminal = {
      ...(options.claude_terminal.backend !== undefined
        ? { backend: options.claude_terminal.backend }
        : {}),
      ...(options.claude_terminal.guards?.call_timeout_ms !== undefined
        ? { guards: { callTimeoutMs: options.claude_terminal.guards.call_timeout_ms } }
        : {}),
      ...(options.claude_terminal.timeout_ms !== undefined
        ? { timeoutMs: options.claude_terminal.timeout_ms }
        : {}),
      ...(options.claude_terminal.keep_session !== undefined
        ? { keepSession: options.claude_terminal.keep_session }
        : {}),
      ...(options.claude_terminal.transcript_poll_interval_ms !== undefined
        ? { transcriptPollIntervalMs: options.claude_terminal.transcript_poll_interval_ms }
        : {}),
    };
  }
  const normalized = Object.keys(result).length > 0 ? result : undefined;
  return normalized;
}

const TRUSTED_DEEPSEEK_PATH_SOURCES = new Set<ProviderResolutionSource>([
  'env',
  'global',
]);

function resolveTrustedDeepSeekPath(
  value: string,
  cwd: string,
  source: ProviderResolutionSource | undefined,
): string {
  if (source === undefined || !TRUSTED_DEEPSEEK_PATH_SOURCES.has(source)) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : resolvePath(cwd, trimmed);
}

export function resolveTrustedDeepSeekHarnessPaths(
  providerOptions: StepProviderOptions | undefined,
  cwd: string,
  providerOptionsSources: Readonly<Record<string, ProviderResolutionSource>> | undefined,
): StepProviderOptions | undefined {
  const deepseekHarness = providerOptions?.deepseekHarness;
  if (deepseekHarness === undefined) {
    return providerOptions;
  }
  const sessionRoot = deepseekHarness.sessionRoot === undefined
    ? undefined
    : resolveTrustedDeepSeekPath(
        deepseekHarness.sessionRoot,
        cwd,
        providerOptionsSources?.['deepseekHarness.sessionRoot'],
      );
  const cordis = deepseekHarness.cordis === undefined
    ? undefined
    : resolveTrustedDeepSeekPath(
        deepseekHarness.cordis,
        cwd,
        providerOptionsSources?.['deepseekHarness.cordis'],
      );
  if (sessionRoot === deepseekHarness.sessionRoot && cordis === deepseekHarness.cordis) {
    return providerOptions;
  }
  return {
    ...providerOptions,
    deepseekHarness: {
      ...deepseekHarness,
      ...(sessionRoot === undefined ? {} : { sessionRoot }),
      ...(cordis === undefined ? {} : { cordis }),
    },
  };
}

/** Deep merge provider options. Later sources override earlier ones. */
export function mergeProviderOptions(
  ...layers: (StepProviderOptions | undefined)[]
): StepProviderOptions | undefined {
  const result: StepProviderOptions = {};

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.codex) {
      result.codex = {
        ...result.codex,
        ...(layer.codex.baseUrl !== undefined
          ? { baseUrl: layer.codex.baseUrl }
          : {}),
        ...(layer.codex.networkAccess !== undefined
          ? { networkAccess: layer.codex.networkAccess }
          : {}),
        ...(layer.codex.permissionControl !== undefined
          ? { permissionControl: layer.codex.permissionControl }
          : {}),
        ...(layer.codex.reasoningEffort !== undefined
          ? { reasoningEffort: layer.codex.reasoningEffort }
          : {}),
        ...(layer.codex.fastMode !== undefined
          ? { fastMode: layer.codex.fastMode }
          : {}),
        ...(layer.codex.guards !== undefined
          ? { guards: { ...result.codex?.guards, ...layer.codex.guards } }
          : {}),
        ...(layer.codex.skills !== undefined
          ? {
              skills: {
                ...result.codex?.skills,
                ...(layer.codex.skills.repo !== undefined ? { repo: layer.codex.skills.repo } : {}),
                ...(layer.codex.skills.user !== undefined ? { user: layer.codex.skills.user } : {}),
              },
            }
          : {}),
      };
    }
    if (layer.opencode) {
      const guards = layer.opencode.guards === undefined
        ? result.opencode?.guards
        : {
            ...result.opencode?.guards,
            ...(layer.opencode.guards.profile !== undefined
              ? { profile: layer.opencode.guards.profile }
              : {}),
            ...(layer.opencode.guards.modelProfiles !== undefined
              ? { modelProfiles: { ...layer.opencode.guards.modelProfiles } }
              : {}),
            ...(layer.opencode.guards.callTimeoutMs !== undefined
              ? { callTimeoutMs: layer.opencode.guards.callTimeoutMs }
              : {}),
            ...(layer.opencode.guards.eventLimit !== undefined
              ? { eventLimit: layer.opencode.guards.eventLimit }
              : {}),
            ...(layer.opencode.guards.textByteLimit !== undefined
              ? { textByteLimit: layer.opencode.guards.textByteLimit }
              : {}),
            ...(layer.opencode.guards.reasoningByteLimit !== undefined
              ? { reasoningByteLimit: layer.opencode.guards.reasoningByteLimit }
              : {}),
          };
      result.opencode = {
        ...result.opencode,
        ...(layer.opencode.networkAccess !== undefined
          ? { networkAccess: layer.opencode.networkAccess }
          : {}),
        ...(layer.opencode.variant !== undefined
          ? { variant: layer.opencode.variant }
          : {}),
        ...(layer.opencode.allowedTools !== undefined
          ? { allowedTools: layer.opencode.allowedTools }
          : {}),
        ...(guards !== undefined ? { guards } : {}),
      };
    }
    if (layer.claude) {
      result.claude = {
        ...result.claude,
        ...(layer.claude.baseUrl !== undefined
          ? { baseUrl: layer.claude.baseUrl }
          : {}),
        ...(layer.claude.allowedTools !== undefined
          ? { allowedTools: layer.claude.allowedTools }
          : {}),
        ...(layer.claude.effort !== undefined
          ? { effort: layer.claude.effort }
          : {}),
        ...(layer.claude.guards !== undefined
          ? { guards: { ...result.claude?.guards, ...layer.claude.guards } }
          : {}),
        ...(layer.claude.skills?.enabled !== undefined
          ? { skills: { enabled: layer.claude.skills.enabled } }
          : {}),
        ...(layer.claude.sandbox
          ? { sandbox: { ...result.claude?.sandbox, ...layer.claude.sandbox } }
          : {}),
      };
    }
    if (layer.copilot) {
      result.copilot = {
        ...result.copilot,
        ...(layer.copilot.effort !== undefined
          ? { effort: layer.copilot.effort }
          : {}),
        ...(layer.copilot.guards !== undefined
          ? { guards: { ...result.copilot?.guards, ...layer.copilot.guards } }
          : {}),
      };
    }
    if (layer.kiro) {
      result.kiro = {
        ...result.kiro,
        ...(layer.kiro.agent !== undefined
          ? { agent: layer.kiro.agent }
          : {}),
        ...(layer.kiro.guards !== undefined
          ? { guards: { ...result.kiro?.guards, ...layer.kiro.guards } }
          : {}),
      };
    }
    if (layer.cursor) {
      result.cursor = {
        ...result.cursor,
        ...(layer.cursor.guards !== undefined
          ? { guards: { ...result.cursor?.guards, ...layer.cursor.guards } }
          : {}),
      };
    }
    if (layer.deepseekHarness) {
      result.deepseekHarness = {
        ...result.deepseekHarness,
        ...layer.deepseekHarness,
      };
    }
    if (layer.pi) {
      result.pi = {
        ...result.pi,
        ...(layer.pi.guards !== undefined
          ? { guards: { ...result.pi?.guards, ...layer.pi.guards } }
          : {}),
        ...(layer.pi.extensions !== undefined ? { extensions: [...layer.pi.extensions] } : {}),
        ...(layer.pi.noExtensions !== undefined ? { noExtensions: layer.pi.noExtensions } : {}),
        ...(layer.pi.noSkills !== undefined ? { noSkills: layer.pi.noSkills } : {}),
        ...(layer.pi.noPromptTemplates !== undefined
          ? { noPromptTemplates: layer.pi.noPromptTemplates }
          : {}),
        ...(layer.pi.noThemes !== undefined ? { noThemes: layer.pi.noThemes } : {}),
        ...(layer.pi.noContextFiles !== undefined ? { noContextFiles: layer.pi.noContextFiles } : {}),
      };
    }
    if (layer.claudeTerminal) {
      result.claudeTerminal = {
        ...result.claudeTerminal,
        ...layer.claudeTerminal,
        ...(layer.claudeTerminal.guards !== undefined
          ? { guards: { ...result.claudeTerminal?.guards, ...layer.claudeTerminal.guards } }
          : {}),
      };
    }
  }

  const merged = Object.keys(result).length > 0 ? result : undefined;
  return merged;
}

function resolveFallbackOrigin(
  source: ProviderOptionsSource | undefined,
): ProviderOptionsTraceOrigin {
  if (source === 'project') return 'local';
  if (source === 'global') return 'global';
  if (source === 'env') return 'env';
  return 'default';
}

export function resolveProviderOptionOrigin(
  resolver: ProviderOptionsOriginResolver | undefined,
  path: string,
  fallbackSource: ProviderOptionsSource | undefined,
): ProviderOptionsTraceOrigin {
  if (!resolver) {
    return resolveFallbackOrigin(fallbackSource);
  }

  if (
    path === 'codex.skills.repo'
    || path === 'codex.skills.user'
    || path === 'claude.skills.enabled'
  ) {
    return resolver(path);
  }

  let current = path;
  while (current.length > 0) {
    const origin = resolver(current);
    if (origin !== 'default') {
      return origin;
    }
    const lastDot = current.lastIndexOf('.');
    if (lastDot < 0) {
      break;
    }
    current = current.slice(0, lastDot);
  }

  return resolver('');
}

function selectProviderValue<T>(
  configValue: T | undefined,
  personaValue: T | undefined,
  stepValue: T | undefined,
  origin: ProviderOptionsTraceOrigin,
): T | undefined {
  if ((origin === 'env' || origin === 'cli') && configValue !== undefined) {
    return configValue;
  }
  return stepValue ?? personaValue ?? configValue;
}

/**
 * Select by scope only for leaves whose explicit file or workflow value must
 * remain above TAKT env/CLI config origins.
 */
function selectProviderValueByScope<T>(
  configValue: T | undefined,
  personaValue: T | undefined,
  stepValue: T | undefined,
): T | undefined {
  return stepValue ?? personaValue ?? configValue;
}

export function resolvePersonaProviderOptions(
  personaProviders: Record<string, PersonaProviderEntry> | undefined,
  personaDisplayName: string | undefined,
): StepProviderOptions | undefined {
  if (!personaDisplayName) {
    return undefined;
  }
  return personaProviders?.[personaDisplayName]?.providerOptions;
}

export function resolveDirectStepProviderOptions(step: WorkflowStep): StepProviderOptions | undefined {
  return step.engineSynthesized === true ? step.providerOptions : undefined;
}

export function resolveStepCapabilityProviderOptions(step: WorkflowStep): StepProviderOptions | undefined {
  if ('capabilityProviderOptions' in step) {
    return step.capabilityProviderOptions;
  }
  return undefined;
}

export function resolveStepProviderOptionsLayers(
  step: WorkflowStep,
  context: StepProviderOptionsLayerContext,
): ProviderOptionsLayer[] {
  const layers: ProviderOptionsLayer[] = [
    {
      source: 'capabilities',
      options: resolveStepCapabilityProviderOptions(step),
    },
    {
      source: 'persona_providers',
      options: resolvePersonaProviderOptions(context.personaProviders, step.personaDisplayName),
    },
  ];

  if (step.providerRoutingPersonaKey) {
    layers.push({
      source: 'provider_routing.personas',
      options: context.providerRouting?.personas?.[step.providerRoutingPersonaKey]?.providerOptions,
    });
  }
  for (const tag of step.tags ?? []) {
    layers.push({
      source: 'provider_routing.tags',
      options: context.providerRouting?.tags?.[tag]?.providerOptions,
    });
  }
  layers.push({
    source: 'provider_routing.steps',
    options: resolveWorkflowStepTarget(
      context.providerRouting?.steps,
      step.name,
      context.providerRouting?.workflowName,
    )?.providerOptions,
  });

  return layers.filter((layer) => layer.options !== undefined);
}

export function mergeStepProviderOptionsLayers(
  step: WorkflowStep,
  context: StepProviderOptionsLayerContext,
): StepProviderOptions | undefined {
  return mergeProviderOptions(
    ...resolveStepProviderOptionsLayers(step, context).map((layer) => layer.options),
  );
}

/**
 * Runtime profile options are identity-scoped: only the profile that supplied the winning
 * provider contributes options. Legacy configuration keeps its historical layered merge.
 */
export function resolveProfileScopedProviderOptionsLayers(
  step: WorkflowStep,
  context: StepProviderOptionsLayerContext,
  resolvedProviderSource: ProviderResolutionSource | undefined,
  profileScoped: boolean,
): ProviderOptionsLayer[] {
  const layers = resolveStepProviderOptionsLayers(step, context);
  if (!profileScoped) {
    return layers;
  }
  const nonProfileLayers = layers.filter((layer) => (
    layer.source === 'capabilities'
  ));
  if (resolvedProviderSource === 'provider_routing.tags') {
    const winningTag = [...(step.tags ?? [])].reverse().find((tag) => (
      context.providerRouting?.tags?.[tag]?.provider !== undefined
    ));
    const options = winningTag === undefined
      ? undefined
      : context.providerRouting?.tags?.[winningTag]?.providerOptions;
    return options === undefined
      ? nonProfileLayers
      : [...nonProfileLayers, { source: 'provider_routing.tags', options }];
  }
  return [
    ...nonProfileLayers,
    ...layers.filter((layer) => layer.source === resolvedProviderSource),
  ];
}

export function resolveEffectiveProviderOptions(
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  resolvedConfigOptions: StepProviderOptions | undefined,
  stepOptions: StepProviderOptions | undefined,
  personaOptions?: StepProviderOptions,
): StepProviderOptions | undefined {
  if (!resolvedConfigOptions) {
    return mergeProviderOptions(personaOptions, stepOptions);
  }
  if (!personaOptions && !stepOptions) {
    return resolvedConfigOptions;
  }

  const claudeSandbox = {
    allowUnsandboxedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.allowUnsandboxedCommands,
      personaOptions?.claude?.sandbox?.allowUnsandboxedCommands,
      stepOptions?.claude?.sandbox?.allowUnsandboxedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.allowUnsandboxedCommands', source),
    ),
    excludedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.excludedCommands,
      personaOptions?.claude?.sandbox?.excludedCommands,
      stepOptions?.claude?.sandbox?.excludedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.excludedCommands', source),
    ),
  };

  const claude = {
    ...(claudeSandbox.allowUnsandboxedCommands !== undefined || claudeSandbox.excludedCommands !== undefined
      ? { sandbox: claudeSandbox }
      : {}),
  };
  const claudeAllowedTools = selectProviderValue(
    resolvedConfigOptions.claude?.allowedTools,
    personaOptions?.claude?.allowedTools,
    stepOptions?.claude?.allowedTools,
    resolveProviderOptionOrigin(originResolver, 'claude.allowedTools', source),
  );
  const claudeBaseUrl = selectProviderValueByScope(
    resolvedConfigOptions.claude?.baseUrl,
    personaOptions?.claude?.baseUrl,
    stepOptions?.claude?.baseUrl,
  );
  const claudeEffort = selectProviderValue(
    resolvedConfigOptions.claude?.effort,
    personaOptions?.claude?.effort,
    stepOptions?.claude?.effort,
    resolveProviderOptionOrigin(originResolver, 'claude.effort', source),
  );
  const claudeSkillsEnabled = selectProviderValue(
    resolvedConfigOptions.claude?.skills?.enabled,
    personaOptions?.claude?.skills?.enabled,
    stepOptions?.claude?.skills?.enabled,
    resolveProviderOptionOrigin(originResolver, 'claude.skills.enabled', source),
  );
  const claudeCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.claude?.guards?.callTimeoutMs,
    personaOptions?.claude?.guards?.callTimeoutMs,
    stepOptions?.claude?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'claude.guards.callTimeoutMs', source),
  );

  const codexNetworkAccess = selectProviderValue(
    resolvedConfigOptions.codex?.networkAccess,
    personaOptions?.codex?.networkAccess,
    stepOptions?.codex?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'codex.networkAccess', source),
  );
  const codexPermissionControl = selectProviderValue(
    resolvedConfigOptions.codex?.permissionControl,
    personaOptions?.codex?.permissionControl,
    stepOptions?.codex?.permissionControl,
    resolveProviderOptionOrigin(originResolver, 'codex.permissionControl', source),
  );
  const codexReasoningEffort = selectProviderValue(
    resolvedConfigOptions.codex?.reasoningEffort,
    personaOptions?.codex?.reasoningEffort,
    stepOptions?.codex?.reasoningEffort,
    resolveProviderOptionOrigin(originResolver, 'codex.reasoningEffort', source),
  );
  const codexFastMode = selectProviderValue(
    resolvedConfigOptions.codex?.fastMode,
    personaOptions?.codex?.fastMode,
    stepOptions?.codex?.fastMode,
    resolveProviderOptionOrigin(originResolver, 'codex.fastMode', source),
  );
  const codexBaseUrl = selectProviderValueByScope(
    resolvedConfigOptions.codex?.baseUrl,
    personaOptions?.codex?.baseUrl,
    stepOptions?.codex?.baseUrl,
  );
  const codexRepoSkills = selectProviderValue(
    resolvedConfigOptions.codex?.skills?.repo,
    personaOptions?.codex?.skills?.repo,
    stepOptions?.codex?.skills?.repo,
    resolveProviderOptionOrigin(originResolver, 'codex.skills.repo', source),
  );
  const codexUserSkills = selectProviderValue(
    resolvedConfigOptions.codex?.skills?.user,
    personaOptions?.codex?.skills?.user,
    stepOptions?.codex?.skills?.user,
    resolveProviderOptionOrigin(originResolver, 'codex.skills.user', source),
  );
  const codexCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.codex?.guards?.callTimeoutMs,
    personaOptions?.codex?.guards?.callTimeoutMs,
    stepOptions?.codex?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'codex.guards.callTimeoutMs', source),
  );
  const opencodeNetworkAccess = selectProviderValue(
    resolvedConfigOptions.opencode?.networkAccess,
    personaOptions?.opencode?.networkAccess,
    stepOptions?.opencode?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'opencode.networkAccess', source),
  );
  const opencodeVariant = selectProviderValue(
    resolvedConfigOptions.opencode?.variant,
    personaOptions?.opencode?.variant,
    stepOptions?.opencode?.variant,
    resolveProviderOptionOrigin(originResolver, 'opencode.variant', source),
  );
  const opencodeAllowedTools = selectProviderValue(
    resolvedConfigOptions.opencode?.allowedTools,
    personaOptions?.opencode?.allowedTools,
    stepOptions?.opencode?.allowedTools,
    resolveProviderOptionOrigin(originResolver, 'opencode.allowedTools', source),
  );
  const opencodeGuardProfile = selectProviderValue(
    resolvedConfigOptions.opencode?.guards?.profile,
    personaOptions?.opencode?.guards?.profile,
    stepOptions?.opencode?.guards?.profile,
    resolveProviderOptionOrigin(originResolver, 'opencode.guards.profile', source),
  );
  const opencodeGuardModelProfiles = selectProviderValue(
    resolvedConfigOptions.opencode?.guards?.modelProfiles,
    personaOptions?.opencode?.guards?.modelProfiles,
    stepOptions?.opencode?.guards?.modelProfiles,
    resolveProviderOptionOrigin(originResolver, 'opencode.guards.modelProfiles', source),
  );
  const opencodeGuardCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.opencode?.guards?.callTimeoutMs,
    personaOptions?.opencode?.guards?.callTimeoutMs,
    stepOptions?.opencode?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'opencode.guards.callTimeoutMs', source),
  );
  const opencodeGuardEventLimit = selectProviderValue(
    resolvedConfigOptions.opencode?.guards?.eventLimit,
    personaOptions?.opencode?.guards?.eventLimit,
    stepOptions?.opencode?.guards?.eventLimit,
    resolveProviderOptionOrigin(originResolver, 'opencode.guards.eventLimit', source),
  );
  const opencodeGuardTextByteLimit = selectProviderValue(
    resolvedConfigOptions.opencode?.guards?.textByteLimit,
    personaOptions?.opencode?.guards?.textByteLimit,
    stepOptions?.opencode?.guards?.textByteLimit,
    resolveProviderOptionOrigin(originResolver, 'opencode.guards.textByteLimit', source),
  );
  const opencodeGuardReasoningByteLimit = selectProviderValue(
    resolvedConfigOptions.opencode?.guards?.reasoningByteLimit,
    personaOptions?.opencode?.guards?.reasoningByteLimit,
    stepOptions?.opencode?.guards?.reasoningByteLimit,
    resolveProviderOptionOrigin(originResolver, 'opencode.guards.reasoningByteLimit', source),
  );
  const copilotEffort = selectProviderValue(
    resolvedConfigOptions.copilot?.effort,
    personaOptions?.copilot?.effort,
    stepOptions?.copilot?.effort,
    resolveProviderOptionOrigin(originResolver, 'copilot.effort', source),
  );
  const kiroAgent = selectProviderValue(
    resolvedConfigOptions.kiro?.agent,
    personaOptions?.kiro?.agent,
    stepOptions?.kiro?.agent,
    resolveProviderOptionOrigin(originResolver, 'kiro.agent', source),
  );
  const deepseekHarnessPythonPath = selectProviderValue(
    resolvedConfigOptions.deepseekHarness?.pythonPath,
    personaOptions?.deepseekHarness?.pythonPath,
    stepOptions?.deepseekHarness?.pythonPath,
    resolveProviderOptionOrigin(originResolver, 'deepseekHarness.pythonPath', source),
  );
  const deepseekHarnessBaseUrl = selectProviderValueByScope(
    resolvedConfigOptions.deepseekHarness?.baseUrl,
    personaOptions?.deepseekHarness?.baseUrl,
    stepOptions?.deepseekHarness?.baseUrl,
  );
  const deepseekHarnessSessionRoot = selectProviderValue(
    resolvedConfigOptions.deepseekHarness?.sessionRoot,
    personaOptions?.deepseekHarness?.sessionRoot,
    stepOptions?.deepseekHarness?.sessionRoot,
    resolveProviderOptionOrigin(originResolver, 'deepseekHarness.sessionRoot', source),
  );
  const deepseekHarnessCordis = selectProviderValue(
    resolvedConfigOptions.deepseekHarness?.cordis,
    personaOptions?.deepseekHarness?.cordis,
    stepOptions?.deepseekHarness?.cordis,
    resolveProviderOptionOrigin(originResolver, 'deepseekHarness.cordis', source),
  );
  const deepseekHarnessMaxTokens = selectProviderValue(
    resolvedConfigOptions.deepseekHarness?.maxTokens,
    personaOptions?.deepseekHarness?.maxTokens,
    stepOptions?.deepseekHarness?.maxTokens,
    resolveProviderOptionOrigin(originResolver, 'deepseekHarness.maxTokens', source),
  );
  const deepseekHarnessRequestTimeoutMs = selectProviderValue(
    resolvedConfigOptions.deepseekHarness?.requestTimeoutMs,
    personaOptions?.deepseekHarness?.requestTimeoutMs,
    stepOptions?.deepseekHarness?.requestTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'deepseekHarness.requestTimeoutMs', source),
  );
  const deepseekHarnessShutdownTimeoutMs = selectProviderValue(
    resolvedConfigOptions.deepseekHarness?.shutdownTimeoutMs,
    personaOptions?.deepseekHarness?.shutdownTimeoutMs,
    stepOptions?.deepseekHarness?.shutdownTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'deepseekHarness.shutdownTimeoutMs', source),
  );
  const deepseekHarnessRuntimeMode = selectProviderValue(
    resolvedConfigOptions.deepseekHarness?.runtimeMode,
    personaOptions?.deepseekHarness?.runtimeMode,
    stepOptions?.deepseekHarness?.runtimeMode,
    resolveProviderOptionOrigin(originResolver, 'deepseekHarness.runtimeMode', source),
  );
  const piExtensions = selectProviderValue(
    resolvedConfigOptions.pi?.extensions,
    personaOptions?.pi?.extensions,
    stepOptions?.pi?.extensions,
    resolveProviderOptionOrigin(originResolver, 'pi.extensions', source),
  );
  const piNoExtensions = selectProviderValue(
    resolvedConfigOptions.pi?.noExtensions,
    personaOptions?.pi?.noExtensions,
    stepOptions?.pi?.noExtensions,
    resolveProviderOptionOrigin(originResolver, 'pi.noExtensions', source),
  );
  const piNoSkills = selectProviderValue(
    resolvedConfigOptions.pi?.noSkills,
    personaOptions?.pi?.noSkills,
    stepOptions?.pi?.noSkills,
    resolveProviderOptionOrigin(originResolver, 'pi.noSkills', source),
  );
  const piNoPromptTemplates = selectProviderValue(
    resolvedConfigOptions.pi?.noPromptTemplates,
    personaOptions?.pi?.noPromptTemplates,
    stepOptions?.pi?.noPromptTemplates,
    resolveProviderOptionOrigin(originResolver, 'pi.noPromptTemplates', source),
  );
  const piNoThemes = selectProviderValue(
    resolvedConfigOptions.pi?.noThemes,
    personaOptions?.pi?.noThemes,
    stepOptions?.pi?.noThemes,
    resolveProviderOptionOrigin(originResolver, 'pi.noThemes', source),
  );
  const piNoContextFiles = selectProviderValue(
    resolvedConfigOptions.pi?.noContextFiles,
    personaOptions?.pi?.noContextFiles,
    stepOptions?.pi?.noContextFiles,
    resolveProviderOptionOrigin(originResolver, 'pi.noContextFiles', source),
  );
  const piCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.pi?.guards?.callTimeoutMs,
    personaOptions?.pi?.guards?.callTimeoutMs,
    stepOptions?.pi?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'pi.guards.callTimeoutMs', source),
  );
  const copilotCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.copilot?.guards?.callTimeoutMs,
    personaOptions?.copilot?.guards?.callTimeoutMs,
    stepOptions?.copilot?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'copilot.guards.callTimeoutMs', source),
  );
  const kiroCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.kiro?.guards?.callTimeoutMs,
    personaOptions?.kiro?.guards?.callTimeoutMs,
    stepOptions?.kiro?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'kiro.guards.callTimeoutMs', source),
  );
  const cursorCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.cursor?.guards?.callTimeoutMs,
    personaOptions?.cursor?.guards?.callTimeoutMs,
    stepOptions?.cursor?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'cursor.guards.callTimeoutMs', source),
  );
  const claudeTerminalBackend = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.backend,
    personaOptions?.claudeTerminal?.backend,
    stepOptions?.claudeTerminal?.backend,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.backend', source),
  );
  const claudeTerminalTimeoutMs = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.timeoutMs,
    personaOptions?.claudeTerminal?.timeoutMs,
    stepOptions?.claudeTerminal?.timeoutMs,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.timeoutMs', source),
  );
  const claudeTerminalCallTimeoutMs = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.guards?.callTimeoutMs,
    personaOptions?.claudeTerminal?.guards?.callTimeoutMs,
    stepOptions?.claudeTerminal?.guards?.callTimeoutMs,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.guards.callTimeoutMs', source),
  );
  const claudeTerminalKeepSession = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.keepSession,
    personaOptions?.claudeTerminal?.keepSession,
    stepOptions?.claudeTerminal?.keepSession,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.keepSession', source),
  );
  const claudeTerminalTranscriptPollIntervalMs = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.transcriptPollIntervalMs,
    personaOptions?.claudeTerminal?.transcriptPollIntervalMs,
    stepOptions?.claudeTerminal?.transcriptPollIntervalMs,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.transcriptPollIntervalMs', source),
  );

  const result: StepProviderOptions = {
    ...(codexBaseUrl !== undefined
      || codexNetworkAccess !== undefined
      || codexPermissionControl !== undefined
      || codexReasoningEffort !== undefined
      || codexFastMode !== undefined
      || codexCallTimeoutMs !== undefined
      || codexRepoSkills !== undefined
      || codexUserSkills !== undefined
      ? {
          codex: {
            ...(codexBaseUrl !== undefined ? { baseUrl: codexBaseUrl } : {}),
            ...(codexNetworkAccess !== undefined ? { networkAccess: codexNetworkAccess } : {}),
            ...(codexPermissionControl !== undefined ? { permissionControl: codexPermissionControl } : {}),
            ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
            ...(codexFastMode !== undefined ? { fastMode: codexFastMode } : {}),
            ...(codexCallTimeoutMs !== undefined
              ? { guards: { callTimeoutMs: codexCallTimeoutMs } }
              : {}),
            ...(codexRepoSkills !== undefined || codexUserSkills !== undefined
              ? {
                  skills: {
                    ...(codexRepoSkills !== undefined ? { repo: codexRepoSkills } : {}),
                    ...(codexUserSkills !== undefined ? { user: codexUserSkills } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(opencodeNetworkAccess !== undefined
      || opencodeVariant !== undefined
      || opencodeAllowedTools !== undefined
      || opencodeGuardProfile !== undefined
      || opencodeGuardModelProfiles !== undefined
      || opencodeGuardCallTimeoutMs !== undefined
      || opencodeGuardEventLimit !== undefined
      || opencodeGuardTextByteLimit !== undefined
      || opencodeGuardReasoningByteLimit !== undefined
      ? {
          opencode: {
            ...(opencodeNetworkAccess !== undefined ? { networkAccess: opencodeNetworkAccess } : {}),
            ...(opencodeVariant !== undefined ? { variant: opencodeVariant } : {}),
            ...(opencodeAllowedTools !== undefined ? { allowedTools: opencodeAllowedTools } : {}),
            ...(opencodeGuardProfile !== undefined
              || opencodeGuardModelProfiles !== undefined
              || opencodeGuardCallTimeoutMs !== undefined
              || opencodeGuardEventLimit !== undefined
              || opencodeGuardTextByteLimit !== undefined
              || opencodeGuardReasoningByteLimit !== undefined
              ? {
                  guards: {
                    ...(opencodeGuardProfile !== undefined ? { profile: opencodeGuardProfile } : {}),
                    ...(opencodeGuardModelProfiles !== undefined
                      ? { modelProfiles: { ...opencodeGuardModelProfiles } }
                      : {}),
                    ...(opencodeGuardCallTimeoutMs !== undefined
                      ? { callTimeoutMs: opencodeGuardCallTimeoutMs }
                      : {}),
                    ...(opencodeGuardEventLimit !== undefined
                      ? { eventLimit: opencodeGuardEventLimit }
                      : {}),
                    ...(opencodeGuardTextByteLimit !== undefined
                      ? { textByteLimit: opencodeGuardTextByteLimit }
                      : {}),
                    ...(opencodeGuardReasoningByteLimit !== undefined
                      ? { reasoningByteLimit: opencodeGuardReasoningByteLimit }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(claude.sandbox !== undefined
      || claudeAllowedTools !== undefined
      || claudeBaseUrl !== undefined
      || claudeEffort !== undefined
      || claudeCallTimeoutMs !== undefined
      || claudeSkillsEnabled !== undefined
      ? {
          claude: {
            ...claude,
            ...(claudeAllowedTools !== undefined ? { allowedTools: claudeAllowedTools } : {}),
            ...(claudeBaseUrl !== undefined ? { baseUrl: claudeBaseUrl } : {}),
            ...(claudeEffort !== undefined ? { effort: claudeEffort } : {}),
            ...(claudeCallTimeoutMs !== undefined
              ? { guards: { callTimeoutMs: claudeCallTimeoutMs } }
              : {}),
            ...(claudeSkillsEnabled !== undefined ? { skills: { enabled: claudeSkillsEnabled } } : {}),
          },
        }
      : {}),
    ...(copilotEffort !== undefined || copilotCallTimeoutMs !== undefined
      ? {
          copilot: {
            ...(copilotEffort !== undefined ? { effort: copilotEffort } : {}),
            ...(copilotCallTimeoutMs !== undefined
              ? { guards: { callTimeoutMs: copilotCallTimeoutMs } }
              : {}),
          },
        }
      : {}),
    ...(kiroAgent !== undefined || kiroCallTimeoutMs !== undefined
      ? {
          kiro: {
            ...(kiroAgent !== undefined ? { agent: kiroAgent } : {}),
            ...(kiroCallTimeoutMs !== undefined
              ? { guards: { callTimeoutMs: kiroCallTimeoutMs } }
              : {}),
          },
        }
      : {}),
    ...(cursorCallTimeoutMs !== undefined
      ? { cursor: { guards: { callTimeoutMs: cursorCallTimeoutMs } } }
      : {}),
    ...(deepseekHarnessPythonPath !== undefined
      || deepseekHarnessBaseUrl !== undefined
      || deepseekHarnessSessionRoot !== undefined
      || deepseekHarnessCordis !== undefined
      || deepseekHarnessMaxTokens !== undefined
      || deepseekHarnessRequestTimeoutMs !== undefined
      || deepseekHarnessShutdownTimeoutMs !== undefined
      || deepseekHarnessRuntimeMode !== undefined
      ? {
          deepseekHarness: {
            ...(deepseekHarnessPythonPath !== undefined ? { pythonPath: deepseekHarnessPythonPath } : {}),
            ...(deepseekHarnessBaseUrl !== undefined ? { baseUrl: deepseekHarnessBaseUrl } : {}),
            ...(deepseekHarnessSessionRoot !== undefined ? { sessionRoot: deepseekHarnessSessionRoot } : {}),
            ...(deepseekHarnessCordis !== undefined ? { cordis: deepseekHarnessCordis } : {}),
            ...(deepseekHarnessMaxTokens !== undefined ? { maxTokens: deepseekHarnessMaxTokens } : {}),
            ...(deepseekHarnessRequestTimeoutMs !== undefined
              ? { requestTimeoutMs: deepseekHarnessRequestTimeoutMs }
              : {}),
            ...(deepseekHarnessShutdownTimeoutMs !== undefined
              ? { shutdownTimeoutMs: deepseekHarnessShutdownTimeoutMs }
              : {}),
            ...(deepseekHarnessRuntimeMode !== undefined ? { runtimeMode: deepseekHarnessRuntimeMode } : {}),
          },
        }
      : {}),
    ...(piExtensions !== undefined
      || piCallTimeoutMs !== undefined
      || piNoExtensions !== undefined
      || piNoSkills !== undefined
      || piNoPromptTemplates !== undefined
      || piNoThemes !== undefined
      || piNoContextFiles !== undefined
      ? {
          pi: {
            ...(piCallTimeoutMs !== undefined
              ? { guards: { callTimeoutMs: piCallTimeoutMs } }
              : {}),
            ...(piExtensions !== undefined ? { extensions: [...piExtensions] } : {}),
            ...(piNoExtensions !== undefined ? { noExtensions: piNoExtensions } : {}),
            ...(piNoSkills !== undefined ? { noSkills: piNoSkills } : {}),
            ...(piNoPromptTemplates !== undefined ? { noPromptTemplates: piNoPromptTemplates } : {}),
            ...(piNoThemes !== undefined ? { noThemes: piNoThemes } : {}),
            ...(piNoContextFiles !== undefined ? { noContextFiles: piNoContextFiles } : {}),
          },
        }
      : {}),
    ...(claudeTerminalBackend !== undefined
      || claudeTerminalCallTimeoutMs !== undefined
      || claudeTerminalTimeoutMs !== undefined
      || claudeTerminalKeepSession !== undefined
      || claudeTerminalTranscriptPollIntervalMs !== undefined
      ? {
          claudeTerminal: {
            ...(claudeTerminalBackend !== undefined ? { backend: claudeTerminalBackend } : {}),
            ...(claudeTerminalCallTimeoutMs !== undefined
              ? { guards: { callTimeoutMs: claudeTerminalCallTimeoutMs } }
              : {}),
            ...(claudeTerminalTimeoutMs !== undefined ? { timeoutMs: claudeTerminalTimeoutMs } : {}),
            ...(claudeTerminalKeepSession !== undefined ? { keepSession: claudeTerminalKeepSession } : {}),
            ...(claudeTerminalTranscriptPollIntervalMs !== undefined
              ? { transcriptPollIntervalMs: claudeTerminalTranscriptPollIntervalMs }
              : {}),
          },
        }
      : {}),
  };

  const effective = Object.keys(result).length > 0 ? result : undefined;
  return effective;
}

function stripClaudeAllowedTools(
  providerOptions: StepProviderOptions | undefined,
): StepProviderOptions | undefined {
  if (!providerOptions) {
    return undefined;
  }

  const sanitizedClaude = providerOptions.claude
    ? {
        ...(providerOptions.claude.baseUrl !== undefined
          ? { baseUrl: providerOptions.claude.baseUrl }
          : {}),
        ...(providerOptions.claude.effort !== undefined
          ? { effort: providerOptions.claude.effort }
          : {}),
        ...(providerOptions.claude.guards !== undefined
          ? { guards: { ...providerOptions.claude.guards } }
          : {}),
        ...(providerOptions.claude.skills?.enabled !== undefined
          ? { skills: { enabled: providerOptions.claude.skills.enabled } }
          : {}),
        ...(providerOptions.claude.sandbox !== undefined
          ? { sandbox: { ...providerOptions.claude.sandbox } }
          : {}),
      }
    : undefined;

  const sanitizedProviderOptions: StepProviderOptions = {
    ...(providerOptions.codex !== undefined
      ? { codex: { ...providerOptions.codex } }
      : {}),
    ...(providerOptions.opencode !== undefined
      ? { opencode: { ...providerOptions.opencode } }
      : {}),
    ...(sanitizedClaude !== undefined && Object.keys(sanitizedClaude).length > 0
      ? { claude: sanitizedClaude }
      : {}),
    ...(providerOptions.cursor !== undefined
      ? { cursor: { ...providerOptions.cursor } }
      : {}),
    ...(providerOptions.copilot !== undefined
      ? { copilot: { ...providerOptions.copilot } }
      : {}),
    ...(providerOptions.kiro !== undefined
      ? { kiro: { ...providerOptions.kiro } }
      : {}),
    ...(providerOptions.deepseekHarness !== undefined
      ? { deepseekHarness: { ...providerOptions.deepseekHarness } }
      : {}),
    ...(providerOptions.pi !== undefined
      ? {
          pi: {
            ...(providerOptions.pi.guards !== undefined
              ? { guards: { ...providerOptions.pi.guards } }
              : {}),
            ...(providerOptions.pi.extensions !== undefined
              ? { extensions: [...providerOptions.pi.extensions] }
              : {}),
            ...(providerOptions.pi.noExtensions !== undefined
              ? { noExtensions: providerOptions.pi.noExtensions }
              : {}),
            ...(providerOptions.pi.noSkills !== undefined ? { noSkills: providerOptions.pi.noSkills } : {}),
            ...(providerOptions.pi.noPromptTemplates !== undefined
              ? { noPromptTemplates: providerOptions.pi.noPromptTemplates }
              : {}),
            ...(providerOptions.pi.noThemes !== undefined ? { noThemes: providerOptions.pi.noThemes } : {}),
            ...(providerOptions.pi.noContextFiles !== undefined
              ? { noContextFiles: providerOptions.pi.noContextFiles }
              : {}),
          },
        }
      : {}),
    ...(providerOptions.claudeTerminal !== undefined
      ? { claudeTerminal: { ...providerOptions.claudeTerminal } }
      : {}),
  };

  return Object.keys(sanitizedProviderOptions).length > 0
    ? sanitizedProviderOptions
    : undefined;
}

export function resolveEffectiveTeamLeaderPartProviderOptions(
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  resolvedConfigOptions: StepProviderOptions | undefined,
  stepOptions: StepProviderOptions | undefined,
  resolvedProvider: ProviderType | undefined,
  partAllowedTools: string[] | undefined,
  personaOptions?: StepProviderOptions,
): StepProviderOptions | undefined {
  const mergedProviderOptions = resolveEffectiveProviderOptions(
    source,
    originResolver,
    resolvedConfigOptions,
    stepOptions,
    personaOptions,
  );

  const shouldStripClaudeTools = partAllowedTools !== undefined
    || (
      resolvedProvider !== undefined
      && providerSupportsClaudeAllowedTools(resolvedProvider) === false
    );

  return shouldStripClaudeTools
    ? stripClaudeAllowedTools(mergedProviderOptions)
    : mergedProviderOptions;
}

/** All paths we expose for per-option source attribution. */
export const PROVIDER_OPTION_PATHS = [
  'claude.baseUrl',
  'claude.effort',
  'claude.allowedTools',
  'claude.sandbox.allowUnsandboxedCommands',
  'claude.sandbox.excludedCommands',
  'claude.skills.enabled',
  'claude.guards.callTimeoutMs',
  'codex.baseUrl',
  'codex.fastMode',
  'codex.networkAccess',
  'codex.permissionControl',
  'codex.reasoningEffort',
  'codex.guards.callTimeoutMs',
  'codex.skills.repo',
  'codex.skills.user',
  'opencode.networkAccess',
  'opencode.variant',
  'opencode.allowedTools',
  'opencode.guards.profile',
  'opencode.guards.modelProfiles',
  'opencode.guards.callTimeoutMs',
  'opencode.guards.eventLimit',
  'opencode.guards.textByteLimit',
  'opencode.guards.reasoningByteLimit',
  'copilot.effort',
  'copilot.guards.callTimeoutMs',
  'kiro.agent',
  'kiro.guards.callTimeoutMs',
  'cursor.guards.callTimeoutMs',
  'deepseekHarness.pythonPath',
  'deepseekHarness.baseUrl',
  'deepseekHarness.sessionRoot',
  'deepseekHarness.cordis',
  'deepseekHarness.maxTokens',
  'deepseekHarness.requestTimeoutMs',
  'deepseekHarness.shutdownTimeoutMs',
  'deepseekHarness.runtimeMode',
  'pi.extensions',
  'pi.guards.callTimeoutMs',
  'pi.noExtensions',
  'pi.noSkills',
  'pi.noPromptTemplates',
  'pi.noThemes',
  'pi.noContextFiles',
  'claudeTerminal.backend',
  'claudeTerminal.guards.callTimeoutMs',
  'claudeTerminal.timeoutMs',
  'claudeTerminal.keepSession',
  'claudeTerminal.transcriptPollIntervalMs',
] as const;

export type ProviderOptionPath = (typeof PROVIDER_OPTION_PATHS)[number];

const FILE_PREFERRED_PROVIDER_OPTION_PATHS: ReadonlySet<string> = new Set([
  'claude.baseUrl',
  'codex.baseUrl',
  'deepseekHarness.baseUrl',
]);

export function isFilePreferredProviderOptionPath(path: string): boolean {
  return FILE_PREFERRED_PROVIDER_OPTION_PATHS.has(path);
}

function getValueAtPath(
  options: StepProviderOptions | undefined,
  path: string,
): unknown {
  if (!options) return undefined;
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === undefined || acc === null || typeof acc !== 'object') {
      return undefined;
    }
    return (acc as Record<string, unknown>)[part];
  }, options);
}

function originToResolutionSource(origin: ProviderOptionsTraceOrigin): ProviderResolutionSource {
  switch (origin) {
    case 'env': return 'env';
    case 'cli': return 'cli';
    case 'local': return 'project';
    case 'global': return 'global';
    case 'default': return 'default';
  }
}

/**
 * Resolve the source layer of a single provider_options path.
 */
export function resolveProviderOptionSource(
  path: string,
  stepOptions: StepProviderOptions | undefined,
  layers: ProviderOptionsLayer[],
  configOptions: StepProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  configSource: ProviderOptionsSource | undefined,
): ProviderResolutionSource | undefined {
  const configValue = getValueAtPath(configOptions, path);
  const stepValue = getValueAtPath(stepOptions, path);
  const origin = resolveProviderOptionOrigin(originResolver, path, configSource);

  if (
    path !== 'claude.baseUrl'
    && path !== 'codex.baseUrl'
    && path !== 'deepseekHarness.baseUrl'
    && (origin === 'env' || origin === 'cli')
    && configValue !== undefined
  ) {
    return originToResolutionSource(origin);
  }
  if (stepValue !== undefined) return 'step';
  for (const layer of [...layers].reverse()) {
    if (getValueAtPath(layer.options, path) !== undefined) {
      return layer.source;
    }
  }
  if (configValue !== undefined) return originToResolutionSource(origin);
  return undefined;
}

/** Compute source per known provider_options path. Returns only paths with values. */
export function resolveProviderOptionsSources(
  stepOptions: StepProviderOptions | undefined,
  layers: ProviderOptionsLayer[],
  configOptions: StepProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  configSource: ProviderOptionsSource | undefined,
): Record<string, ProviderResolutionSource> {
  const result: Record<string, ProviderResolutionSource> = {};
  for (const path of PROVIDER_OPTION_PATHS) {
    const source = resolveProviderOptionSource(
      path,
      stepOptions,
      layers,
      configOptions,
      originResolver,
      configSource,
    );
    if (source !== undefined) {
      result[path] = source;
    }
  }
  return result;
}
