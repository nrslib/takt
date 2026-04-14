import type {
  ClaudeEffort,
  CodexReasoningEffort,
  CopilotEffort,
  StepProviderOptions,
} from '../../core/models/workflow-types.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderOptionsTraceOrigin,
} from '../../core/workflow/types.js';
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
  stepValue: T | undefined,
  origin: ProviderOptionsTraceOrigin,
): T | undefined {
  if (origin === 'env' || origin === 'cli') {
    return configValue ?? stepValue;
  }
  return stepValue ?? configValue;
}

export function resolveEffectiveProviderOptions(
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  resolvedConfigOptions: StepProviderOptions | undefined,
  stepOptions: StepProviderOptions | undefined,
): StepProviderOptions | undefined {
  if (!resolvedConfigOptions) {
    return stepOptions;
  }
  if (!stepOptions) {
    return resolvedConfigOptions;
  }

  const claudeSandbox = {
    allowUnsandboxedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.allowUnsandboxedCommands,
      stepOptions.claude?.sandbox?.allowUnsandboxedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.allowUnsandboxedCommands', source),
    ),
    excludedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.excludedCommands,
      stepOptions.claude?.sandbox?.excludedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.excludedCommands', source),
    ),
  };

  const claude = {
    sandbox: claudeSandbox.allowUnsandboxedCommands !== undefined || claudeSandbox.excludedCommands !== undefined
      ? claudeSandbox
      : undefined,
    allowedTools: selectProviderValue(
      resolvedConfigOptions.claude?.allowedTools,
      stepOptions.claude?.allowedTools,
      resolveProviderOptionOrigin(originResolver, 'claude.allowedTools', source),
    ),
    effort: selectProviderValue(
      resolvedConfigOptions.claude?.effort,
      stepOptions.claude?.effort,
      resolveProviderOptionOrigin(originResolver, 'claude.effort', source),
    ),
  };

  const codexNetworkAccess = selectProviderValue(
    resolvedConfigOptions.codex?.networkAccess,
    stepOptions.codex?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'codex.networkAccess', source),
  );
  const codexReasoningEffort = selectProviderValue(
    resolvedConfigOptions.codex?.reasoningEffort,
    stepOptions.codex?.reasoningEffort,
    resolveProviderOptionOrigin(originResolver, 'codex.reasoningEffort', source),
  );
  const opencodeNetworkAccess = selectProviderValue(
    resolvedConfigOptions.opencode?.networkAccess,
    stepOptions.opencode?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'opencode.networkAccess', source),
  );
  const copilotEffort = selectProviderValue(
    resolvedConfigOptions.copilot?.effort,
    stepOptions.copilot?.effort,
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
): StepProviderOptions | undefined {
  const mergedProviderOptions = resolveEffectiveProviderOptions(
    source,
    originResolver,
    resolvedConfigOptions,
    stepOptions,
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
