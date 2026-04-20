import type {
  ClaudeEffort,
  CodexReasoningEffort,
  CopilotEffort,
  StepProviderOptions,
} from '../../core/models/workflow-types.js';
import type { PersonaProviderEntry } from '../../core/models/config-types.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderOptionsTraceOrigin,
  ProviderResolutionSource,
} from '../../core/workflow/provider-options-trace.js';
import type { ProviderType } from '../../shared/types/provider.js';
import { providerSupportsClaudeAllowedTools } from '../providers/provider-capabilities.js';

type RawProviderOptions = {
  codex?: {
    network_access?: boolean;
    reasoning_effort?: CodexReasoningEffort;
  };
  opencode?: {
    network_access?: boolean;
  };
  claude?: {
    allowed_tools?: string[];
    effort?: ClaudeEffort;
    sandbox?: {
      allow_unsandboxed_commands?: boolean;
      excluded_commands?: string[];
    };
  };
  copilot?: {
    effort?: CopilotEffort;
  };
};

/** Convert raw YAML provider_options (snake_case) to internal format (camelCase). */
export function normalizeProviderOptions(
  raw: RawProviderOptions | Record<string, unknown> | undefined,
): StepProviderOptions | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const options = raw as RawProviderOptions;
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
  if (options.opencode?.network_access !== undefined) {
    result.opencode = { networkAccess: options.opencode.network_access };
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
  const copilotEffort = selectProviderValue(
    resolvedConfigOptions.copilot?.effort,
    personaOptions?.copilot?.effort,
    stepOptions?.copilot?.effort,
    resolveProviderOptionOrigin(originResolver, 'copilot.effort', source),
  );

  const result: StepProviderOptions = {
    codex:
      codexNetworkAccess !== undefined || codexReasoningEffort !== undefined
        ? {
            ...(codexNetworkAccess !== undefined ? { networkAccess: codexNetworkAccess } : {}),
            ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
          }
        : undefined,
    opencode: opencodeNetworkAccess !== undefined ? { networkAccess: opencodeNetworkAccess } : undefined,
    claude:
      claude.sandbox !== undefined || claude.allowedTools !== undefined || claude.effort !== undefined
        ? claude
        : undefined,
    copilot: copilotEffort !== undefined ? { effort: copilotEffort } : undefined,
  };

  return result.codex || result.opencode || result.claude || result.copilot ? result : undefined;
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
  'copilot.effort',
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
 * `selectProviderValue` precedence (env/cli config beats step/persona,
 * otherwise step > persona > config).
 */
export function resolveProviderOptionSource(
  path: string,
  stepOptions: StepProviderOptions | undefined,
  personaOptions: StepProviderOptions | undefined,
  configOptions: StepProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  configSource: ProviderOptionsSource | undefined,
): ProviderResolutionSource | undefined {
  const configValue = getValueAtPath(configOptions, path);
  const personaValue = getValueAtPath(personaOptions, path);
  const stepValue = getValueAtPath(stepOptions, path);
  const origin = resolveProviderOptionOrigin(originResolver, path, configSource);

  if ((origin === 'env' || origin === 'cli') && configValue !== undefined) {
    return originToResolutionSource(origin);
  }
  if (stepValue !== undefined) return 'step';
  if (personaValue !== undefined) return 'persona_providers';
  if (configValue !== undefined) return originToResolutionSource(origin);
  return undefined;
}

/** Compute source per known provider_options path. Returns only paths with values. */
export function resolveProviderOptionsSources(
  stepOptions: StepProviderOptions | undefined,
  personaOptions: StepProviderOptions | undefined,
  configOptions: StepProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  configSource: ProviderOptionsSource | undefined,
): Record<string, ProviderResolutionSource> {
  const result: Record<string, ProviderResolutionSource> = {};
  for (const path of PROVIDER_OPTION_PATHS) {
    const source = resolveProviderOptionSource(
      path,
      stepOptions,
      personaOptions,
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
