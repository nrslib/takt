import { describe, expect, it } from 'vitest';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';
import { mergeProviderOptions } from '../infra/config/providerOptions.js';

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

  it('claude allowed_tools を piece-level で設定し movement で上書きできる', () => {
    const raw = {
      name: 'claude-allowed-tools',
      piece_config: {
        provider_options: {
          claude: {
            allowed_tools: ['Read', 'Glob'],
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
              allowed_tools: ['Read', 'Edit', 'Bash'],
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Glob'] },
    });
    expect(config.movements[0]?.providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Glob'] },
    });
    expect(config.movements[1]?.providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Edit', 'Bash'] },
    });
  });

  it('piece-level runtime.prepare を正規化し重複を除去する', () => {
    const raw = {
      name: 'runtime-prepare',
      piece_config: {
        runtime: {
          prepare: ['gradle', 'node', 'gradle'],
        },
      },
      movements: [
        {
          name: 'implement',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.runtime).toEqual({
      prepare: ['gradle', 'node'],
    });
  });

  it('movement の provider block を provider/model/providerOptions に正規化する', () => {
    const raw = {
      name: 'provider-block-movement',
      movements: [
        {
          name: 'implement',
          provider: {
            type: 'codex',
            model: 'gpt-5.3',
            network_access: false,
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.movements[0]?.provider).toBe('codex');
    expect(config.movements[0]?.model).toBe('gpt-5.3');
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('piece_config の provider block を movement 既定値として継承する', () => {
    const raw = {
      name: 'provider-block-piece-config',
      piece_config: {
        provider: {
          type: 'codex',
          model: 'gpt-5.3',
          network_access: true,
        },
      },
      movements: [
        {
          name: 'plan',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
    expect(config.movements[0]?.provider).toBe('codex');
    expect(config.movements[0]?.model).toBe('gpt-5.3');
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('provider block で claude に network_access を指定した場合はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block',
      movements: [
        {
          name: 'review',
          provider: {
            type: 'claude',
            network_access: true,
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizePieceConfig(raw, process.cwd())).toThrow(/network_access/);
  });

  it('provider block で codex に sandbox を指定した場合はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block',
      piece_config: {
        provider: {
          type: 'codex',
          sandbox: {
            allow_unsandboxed_commands: true,
          },
        },
      },
      movements: [
        {
          name: 'review',
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizePieceConfig(raw, process.cwd())).toThrow(/sandbox/);
  });

  it('parallel サブムーブメントは親ムーブメントの provider block を継承する', () => {
    const raw = {
      name: 'provider-block-parallel-inherit',
      piece_config: {
        provider: {
          type: 'claude',
          model: 'sonnet',
        },
      },
      movements: [
        {
          name: 'reviewers',
          provider: {
            type: 'codex',
            model: 'gpt-5.3',
            network_access: true,
          },
          parallel: [
            {
              name: 'arch-review',
              instruction: '{task}',
            },
          ],
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, process.cwd());
    const parent = config.movements[0];
    const child = parent?.parallel?.[0];

    expect(parent?.provider).toBe('codex');
    expect(parent?.model).toBe('gpt-5.3');
    expect(child?.provider).toBe('codex');
    expect(child?.model).toBe('gpt-5.3');
    expect(child?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('parallel の provider block で claude に network_access 指定時はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block-parallel',
      movements: [
        {
          name: 'review',
          parallel: [
            {
              name: 'arch-review',
              provider: {
                type: 'claude',
                network_access: true,
              },
              instruction: '{task}',
            },
          ],
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizePieceConfig(raw, process.cwd())).toThrow(/network_access/);
  });

  it('parallel の provider block で codex に sandbox 指定時はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block-parallel',
      movements: [
        {
          name: 'review',
          parallel: [
            {
              name: 'arch-review',
              provider: {
                type: 'codex',
                sandbox: {
                  allow_unsandboxed_commands: true,
                },
              },
              instruction: '{task}',
            },
          ],
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizePieceConfig(raw, process.cwd())).toThrow(/sandbox/);
  });
});

describe('mergeProviderOptions', () => {
  it('複数層を正しくマージする（後の層が優先）', () => {
    const global = {
      claude: {
        sandbox: { allowUnsandboxedCommands: false, excludedCommands: ['./gradlew'] },
        allowedTools: ['Read'],
      },
      codex: { networkAccess: true },
    };
    const local = {
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    };
    const step = {
      claude: { allowedTools: ['Read', 'Edit'] },
      codex: { networkAccess: false },
    };

    const result = mergeProviderOptions(global, local, step);

    expect(result).toEqual({
      claude: {
        sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] },
        allowedTools: ['Read', 'Edit'],
      },
      codex: { networkAccess: false },
    });
  });

  it('すべて undefined なら undefined を返す', () => {
    expect(mergeProviderOptions(undefined, undefined, undefined)).toBeUndefined();
  });
});
