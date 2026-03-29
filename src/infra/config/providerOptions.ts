import type { MovementProviderOptions } from '../../core/models/piece-types.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderOptionsTraceOrigin,
} from '../../core/piece/types.js';

type RawProviderOptions = {
  codex?: {
    network_access?: boolean;
  };
  opencode?: {
    network_access?: boolean;
  };
  claude?: {
    allowed_tools?: string[];
    sandbox?: {
      allow_unsandboxed_commands?: boolean;
      excluded_commands?: string[];
    };
  };
};

/** Convert raw YAML provider_options (snake_case) to internal format (camelCase). */
export function normalizeProviderOptions(
  raw: RawProviderOptions | Record<string, unknown> | undefined,
): MovementProviderOptions | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const options = raw as RawProviderOptions;
  const result: MovementProviderOptions = {};
  if (options.codex?.network_access !== undefined) {
    result.codex = { networkAccess: options.codex.network_access };
  }
  if (options.opencode?.network_access !== undefined) {
    result.opencode = { networkAccess: options.opencode.network_access };
  }
  if (options.claude?.allowed_tools !== undefined || options.claude?.sandbox) {
    const claude: NonNullable<MovementProviderOptions['claude']> = {};
    if (options.claude.allowed_tools !== undefined) {
      claude.allowedTools = options.claude.allowed_tools;
    }
    if (options.claude.sandbox) {
      claude.sandbox = {
        ...(options.claude.sandbox.allow_unsandboxed_commands !== undefined
          ? { allowUnsandboxedCommands: options.claude.sandbox.allow_unsandboxed_commands }
          : {}),
        ...(options.claude.sandbox.excluded_commands !== undefined
          ? { excludedCommands: options.claude.sandbox.excluded_commands }
          : {}),
      };
    }
    result.claude = claude;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Deep merge provider options. Later sources override earlier ones. */
export function mergeProviderOptions(
  ...layers: (MovementProviderOptions | undefined)[]
): MovementProviderOptions | undefined {
  const result: MovementProviderOptions = {};

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
        ...(layer.claude.sandbox
          ? { sandbox: { ...result.claude?.sandbox, ...layer.claude.sandbox } }
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
  movementValue: T | undefined,
  origin: ProviderOptionsTraceOrigin,
): T | undefined {
  if (origin === 'env' || origin === 'cli') {
    return configValue ?? movementValue;
  }
  return movementValue ?? configValue;
}

export function resolveEffectiveProviderOptions(
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  resolvedConfigOptions: MovementProviderOptions | undefined,
  movementOptions: MovementProviderOptions | undefined,
): MovementProviderOptions | undefined {
  if (!resolvedConfigOptions) {
    return movementOptions;
  }
  if (!movementOptions) {
    return resolvedConfigOptions;
  }

  const claudeSandbox = {
    allowUnsandboxedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.allowUnsandboxedCommands,
      movementOptions.claude?.sandbox?.allowUnsandboxedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.allowUnsandboxedCommands', source),
    ),
    excludedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.excludedCommands,
      movementOptions.claude?.sandbox?.excludedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.excludedCommands', source),
    ),
  };

  const claude = {
    sandbox: claudeSandbox.allowUnsandboxedCommands !== undefined || claudeSandbox.excludedCommands !== undefined
      ? claudeSandbox
      : selectProviderValue(
        resolvedConfigOptions.claude?.sandbox,
        movementOptions.claude?.sandbox,
        resolveProviderOptionOrigin(originResolver, 'claude.sandbox', source),
      ),
    allowedTools: selectProviderValue(
      resolvedConfigOptions.claude?.allowedTools,
      movementOptions.claude?.allowedTools,
      resolveProviderOptionOrigin(originResolver, 'claude.allowedTools', source),
    ),
  };

  const codexNetworkAccess = selectProviderValue(
    resolvedConfigOptions.codex?.networkAccess,
    movementOptions.codex?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'codex.networkAccess', source),
  );
  const opencodeNetworkAccess = selectProviderValue(
    resolvedConfigOptions.opencode?.networkAccess,
    movementOptions.opencode?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'opencode.networkAccess', source),
  );

  const result: MovementProviderOptions = {
    codex: codexNetworkAccess !== undefined ? { networkAccess: codexNetworkAccess } : undefined,
    opencode: opencodeNetworkAccess !== undefined ? { networkAccess: opencodeNetworkAccess } : undefined,
    claude: claude.sandbox !== undefined || claude.allowedTools !== undefined ? claude : undefined,
  };

  return result.codex || result.opencode || result.claude ? result : undefined;
}
