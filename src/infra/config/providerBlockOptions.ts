import type { MovementProviderOptions } from '../../core/models/piece-types.js';

type ProviderBlockSandbox = {
  allow_unsandboxed_commands?: boolean;
  excluded_commands?: string[];
};

export type ProviderBlockInput = {
  type: string;
  model?: string;
  network_access?: boolean;
  sandbox?: ProviderBlockSandbox;
};

export function normalizeProviderBlockOptions(provider: ProviderBlockInput): MovementProviderOptions | undefined {
  if (provider.type === 'codex' || provider.type === 'opencode') {
    if (provider.network_access === undefined) {
      return undefined;
    }
    return { [provider.type]: { networkAccess: provider.network_access } };
  }
  if (provider.type === 'claude-sdk' && provider.sandbox) {
    return {
      claude: {
        sandbox: {
          ...(provider.sandbox.allow_unsandboxed_commands !== undefined
            ? { allowUnsandboxedCommands: provider.sandbox.allow_unsandboxed_commands }
            : {}),
          ...(provider.sandbox.excluded_commands !== undefined
            ? { excludedCommands: provider.sandbox.excluded_commands }
            : {}),
        },
      },
    };
  }
  return undefined;
}
