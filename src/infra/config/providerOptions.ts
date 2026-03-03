import type { MovementProviderOptions } from '../../core/models/piece-types.js';

type RawProviderOptions = {
  codex?: {
    network_access?: boolean;
  };
  opencode?: {
    network_access?: boolean;
  };
  claude?: {
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
  if (options.claude?.sandbox) {
    result.claude = {
      sandbox: {
        ...(options.claude.sandbox.allow_unsandboxed_commands !== undefined
          ? { allowUnsandboxedCommands: options.claude.sandbox.allow_unsandboxed_commands }
          : {}),
        ...(options.claude.sandbox.excluded_commands !== undefined
          ? { excludedCommands: options.claude.sandbox.excluded_commands }
          : {}),
      },
    };
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
    if (layer.claude?.sandbox) {
      result.claude = {
        sandbox: { ...result.claude?.sandbox, ...layer.claude.sandbox },
      };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
