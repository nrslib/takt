import { describe, expect, it } from 'vitest';
import { normalizePieceConfig, mergeProviderOptions } from '../infra/config/loaders/pieceParser.js';

describe('normalizePieceConfig provider_options', () => {
  it('piece-level global を movement に継承し、movement 側で上書きできる', () => {
    const raw = {
      name: 'provider-options',
      piece_config: {
        provider_options: {
          codex: { network_access: true },
          opencode: { network_access: false },
        },
      },
      movements: [
        {
          name: 'codex-default',
          provider: 'codex',
          instruction: '{task}',
        },
        {
          name: 'codex-override',
          provider: 'codex',
          provider_options: {
            codex: { network_access: false },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
    });
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
    });
    expect(config.movements[1]?.providerOptions).toEqual({
      codex: { networkAccess: false },
      opencode: { networkAccess: false },
    });
  });

  it('claude sandbox を piece-level で設定し movement で上書きできる', () => {
    const raw = {
      name: 'claude-sandbox',
      piece_config: {
        provider_options: {
          claude: {
            sandbox: { allow_unsandboxed_commands: true },
          },
        },
      },
      movements: [
        {
          name: 'inherit',
          instruction: '{task}',
        },
        {
          name: 'override',
          provider_options: {
            claude: {
              sandbox: {
                allow_unsandboxed_commands: false,
                excluded_commands: ['./gradlew'],
              },
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
    expect(config.movements[0]?.providerOptions).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
    expect(config.movements[1]?.providerOptions).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: false,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });
});

describe('mergeProviderOptions', () => {
  it('複数層を正しくマージする（後の層が優先）', () => {
    const global = {
      claude: { sandbox: { allowUnsandboxedCommands: false, excludedCommands: ['./gradlew'] } },
      codex: { networkAccess: true },
    };
    const local = {
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    };
    const step = {
      codex: { networkAccess: false },
    };

    const result = mergeProviderOptions(global, local, step);

    expect(result).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] } },
      codex: { networkAccess: false },
    });
  });

  it('すべて undefined なら undefined を返す', () => {
    expect(mergeProviderOptions(undefined, undefined, undefined)).toBeUndefined();
  });
});
