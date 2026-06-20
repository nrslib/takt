import type {
  ClaudeEffort,
  ClaudeTerminalProviderOptions,
  CodexReasoningEffort,
  CopilotEffort,
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
import type { ProviderType } from '../../shared/types/provider.js';
import { providerSupportsClaudeAllowedTools } from '../providers/provider-capabilities.js';

type RawProviderOptions = {
  extends?: string;
  codex?: {
    network_access?: boolean;
    reasoning_effort?: CodexReasoningEffort;
  };
  opencode?: {
    network_access?: boolean;
    variant?: string;
    allowed_tools?: string[];
  };
  claude?: {
    allowed_tools?: string[];
    effort?: ClaudeEffort;
    sandbox?: {
      allow_unsandboxed_commands?: boolean;
      excluded_commands?: string[];
    };
  };
  claude_terminal?: {
    backend?: ClaudeTerminalProviderOptions['backend'];
    timeout_ms?: number;
    keep_session?: boolean;
    transcript_poll_interval_ms?: number;
  };
  copilot?: {
    effort?: CopilotEffort;
  };
  kiro?: {
    agent?: string;
  };
};

export interface ProviderOptionsLayer {
  source: ProviderResolutionSource;
  options: StepProviderOptions | undefined;
}

interface StepProviderOptionsLayerContext {
  providerRouting: ProviderRoutingConfig | undefined;
  personaProviders: Record<string, PersonaProviderEntry> | undefined;
}

/** Convert raw YAML provider_options (snake_case) to internal format (camelCase). */
export function normalizeProviderOptions(
  raw: RawProviderOptions | Record<string, unknown> | undefined,
): StepProviderOptions | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const options = raw as RawProviderOptions;
  if (options.extends !== undefined) {
    throw new Error('Configuration error: provider_options.extends must be resolved before provider options normalization.');
  }

  const result: StepProviderOptions = {};
  if (options.codex?.network_access !== undefined || options.codex?.reasoning_effort !== undefined) {
    result.codex = {
      ...(options.codex.network_access !== undefined
        ? { networkAccess: options.codex.network_access }
        : {}),
      ...(options.codex.reasoning_effort !== undefined
        ? { reasoningEffort: options.codex.reasoning_effort }
        : {}),
    };
  }
  if (
    options.opencode?.network_access !== undefined
    || options.opencode?.variant !== undefined
    || options.opencode?.allowed_tools !== undefined
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
    };
  }
  if (
    options.claude?.allowed_tools !== undefined
    || options.claude?.effort !== undefined
    || options.claude?.sandbox
  ) {
    const claude: NonNullable<StepProviderOptions['claude']> = {};
    if (options.claude.allowed_tools !== undefined) {
      claude.allowedTools = options.claude.allowed_tools;
    }
    if (options.claude.effort !== undefined) {
      claude.effort = options.claude.effort;
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
  if (options.copilot?.effort !== undefined) {
    result.copilot = { effort: options.copilot.effort };
  }
  if (options.kiro?.agent !== undefined) {
    result.kiro = { agent: options.kiro.agent };
  }
  if (
    options.claude_terminal?.backend !== undefined
    || options.claude_terminal?.timeout_ms !== undefined
    || options.claude_terminal?.keep_session !== undefined
    || options.claude_terminal?.transcript_poll_interval_ms !== undefined
  ) {
    result.claudeTerminal = {
      ...(options.claude_terminal.backend !== undefined
        ? { backend: options.claude_terminal.backend }
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
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Deep merge provider options. Later sources override earlier ones. */
export function mergeProviderOptions(
  ...layers: (StepProviderOptions | undefined)[]
): StepProviderOptions | undefined {
  const result: StepProviderOptions = {};

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.codex) {
      result.codex = { ...result.codex, ...layer.codex };
    }
    if (layer.opencode) {
      result.opencode = { ...result.opencode, ...layer.opencode };
    }
    if (layer.claude) {
      result.claude = {
        ...result.claude,
        ...(layer.claude.allowedTools !== undefined
          ? { allowedTools: layer.claude.allowedTools }
          : {}),
        ...(layer.claude.effort !== undefined
          ? { effort: layer.claude.effort }
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
      };
    }
    if (layer.kiro) {
      result.kiro = {
        ...result.kiro,
        ...(layer.kiro.agent !== undefined
          ? { agent: layer.kiro.agent }
          : {}),
      };
    }
    if (layer.claudeTerminal) {
      result.claudeTerminal = { ...result.claudeTerminal, ...layer.claudeTerminal };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
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
  if ('directProviderOptions' in step) {
    return step.directProviderOptions;
  }
  return step.providerOptions;
}

export function resolveStepWorkflowProviderOptions(step: WorkflowStep): StepProviderOptions | undefined {
  if ('workflowProviderOptions' in step) {
    return step.workflowProviderOptions;
  }
  return undefined;
}

export function resolveStepProviderOptionsLayers(
  step: WorkflowStep,
  context: StepProviderOptionsLayerContext,
): ProviderOptionsLayer[] {
  const layers: ProviderOptionsLayer[] = [
    {
      source: 'workflow',
      options: resolveStepWorkflowProviderOptions(step),
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
    options: context.providerRouting?.steps?.[step.name]?.providerOptions,
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
    sandbox: claudeSandbox.allowUnsandboxedCommands !== undefined || claudeSandbox.excludedCommands !== undefined
      ? claudeSandbox
      : undefined,
    allowedTools: selectProviderValue(
      resolvedConfigOptions.claude?.allowedTools,
      personaOptions?.claude?.allowedTools,
      stepOptions?.claude?.allowedTools,
      resolveProviderOptionOrigin(originResolver, 'claude.allowedTools', source),
    ),
    effort: selectProviderValue(
      resolvedConfigOptions.claude?.effort,
      personaOptions?.claude?.effort,
      stepOptions?.claude?.effort,
      resolveProviderOptionOrigin(originResolver, 'claude.effort', source),
    ),
  };

  const codexNetworkAccess = selectProviderValue(
    resolvedConfigOptions.codex?.networkAccess,
    personaOptions?.codex?.networkAccess,
    stepOptions?.codex?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'codex.networkAccess', source),
  );
  const codexReasoningEffort = selectProviderValue(
    resolvedConfigOptions.codex?.reasoningEffort,
    personaOptions?.codex?.reasoningEffort,
    stepOptions?.codex?.reasoningEffort,
    resolveProviderOptionOrigin(originResolver, 'codex.reasoningEffort', source),
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
    codex:
      codexNetworkAccess !== undefined || codexReasoningEffort !== undefined
        ? {
            ...(codexNetworkAccess !== undefined ? { networkAccess: codexNetworkAccess } : {}),
            ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
          }
        : undefined,
    opencode:
      opencodeNetworkAccess !== undefined || opencodeVariant !== undefined || opencodeAllowedTools !== undefined
        ? {
            ...(opencodeNetworkAccess !== undefined ? { networkAccess: opencodeNetworkAccess } : {}),
            ...(opencodeVariant !== undefined ? { variant: opencodeVariant } : {}),
            ...(opencodeAllowedTools !== undefined ? { allowedTools: opencodeAllowedTools } : {}),
          }
        : undefined,
    claude:
      claude.sandbox !== undefined || claude.allowedTools !== undefined || claude.effort !== undefined
        ? claude
        : undefined,
    copilot: copilotEffort !== undefined ? { effort: copilotEffort } : undefined,
    kiro: kiroAgent !== undefined ? { agent: kiroAgent } : undefined,
    claudeTerminal:
      claudeTerminalBackend !== undefined
      || claudeTerminalTimeoutMs !== undefined
      || claudeTerminalKeepSession !== undefined
      || claudeTerminalTranscriptPollIntervalMs !== undefined
        ? {
            ...(claudeTerminalBackend !== undefined ? { backend: claudeTerminalBackend } : {}),
            ...(claudeTerminalTimeoutMs !== undefined ? { timeoutMs: claudeTerminalTimeoutMs } : {}),
            ...(claudeTerminalKeepSession !== undefined ? { keepSession: claudeTerminalKeepSession } : {}),
            ...(claudeTerminalTranscriptPollIntervalMs !== undefined
              ? { transcriptPollIntervalMs: claudeTerminalTranscriptPollIntervalMs }
              : {}),
          }
        : undefined,
  };

  return result.codex || result.opencode || result.claude || result.copilot || result.kiro || result.claudeTerminal
    ? result
    : undefined;
}

function stripClaudeAllowedTools(
  providerOptions: StepProviderOptions | undefined,
): StepProviderOptions | undefined {
  if (!providerOptions) {
    return undefined;
  }

  const sanitizedClaude = providerOptions.claude
    ? {
        ...(providerOptions.claude.effort !== undefined
          ? { effort: providerOptions.claude.effort }
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
    ...(providerOptions.copilot !== undefined
      ? { copilot: { ...providerOptions.copilot } }
      : {}),
    ...(providerOptions.kiro !== undefined
      ? { kiro: { ...providerOptions.kiro } }
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
  'claude.effort',
  'claude.allowedTools',
  'claude.sandbox.allowUnsandboxedCommands',
  'claude.sandbox.excludedCommands',
  'codex.networkAccess',
  'codex.reasoningEffort',
  'opencode.networkAccess',
  'opencode.variant',
  'opencode.allowedTools',
  'copilot.effort',
  'kiro.agent',
  'claudeTerminal.backend',
  'claudeTerminal.timeoutMs',
  'claudeTerminal.keepSession',
  'claudeTerminal.transcriptPollIntervalMs',
] as const;

export type ProviderOptionPath = (typeof PROVIDER_OPTION_PATHS)[number];

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
 * Resolve the source layer of a single provider_options path, mirroring
 * `selectProviderValue` precedence (env/cli config beats step/layers,
 * otherwise step > routing/persona/workflow layers > config).
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

  if ((origin === 'env' || origin === 'cli') && configValue !== undefined) {
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
