import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';
import { loadGlobalConfig, invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../infra/config/project/projectConfig.js';
import { resolveMovementProviderModel } from '../core/piece/provider-resolution.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../agents/ai-judge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agents/ai-judge.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockResolvedValue(-1),
  };
});

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSlackWebhookUrl: vi.fn(() => undefined),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

const { executeTask } = await import('../features/tasks/execute/taskExecution.js');
const { runAgent } = await import('../agents/runner.js');

function createTempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomUUID()}`);
}

type NormalizePieceConfigWithWarning = (
  raw: unknown,
  pieceDir: string,
  context?: unknown,
  onWarning?: (message: string) => void,
) => ReturnType<typeof normalizePieceConfig>;

const normalizePieceConfigWithWarning = normalizePieceConfig as NormalizePieceConfigWithWarning;

function writeConfig(filePath: string, lines: string[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

describe('normalizePieceConfig provider block', () => {
  const pieceDir = join(process.cwd(), 'src', '__tests__');

  it('movement の provider 文字列（旧形式）が受け入れられる', () => {
    // Given: movement が文字列形式の provider を持つ
    const raw = {
      name: 'movement-shorthand',
      movements: [
        {
          name: 'implement',
          provider: 'codex',
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfig(raw, pieceDir);

    // Then
    expect(config.movements[0]?.provider).toBe('codex');
  });

  it('movement の provider オブジェクト（type, model）が受け入れられる', () => {
    // Given: movement の provider が新形式（type + model）
    const raw = {
      name: 'movement-object',
      movements: [
        {
          name: 'implement',
          provider: {
            type: 'codex',
            model: 'gpt-5.3',
          },
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfig(raw, pieceDir);

    // Then
    expect(config.movements[0]?.provider).toBe('codex');
    expect(config.movements[0]?.model).toBe('gpt-5.3');
  });

  it('movement の provider.codex.network_access が movement の providerOptions へ反映される', () => {
    // Given: movement.provider に codex network_access がある
    const raw = {
      name: 'codex-network',
      movements: [
        {
          name: 'implement',
          provider: {
            type: 'codex',
            network_access: true,
          },
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfig(raw, pieceDir);

    // Then
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('movement の provider.opencode.network_access が movement の providerOptions へ反映される', () => {
    // Given: movement.provider に opencode network_access がある
    const raw = {
      name: 'opencode-network',
      movements: [
        {
          name: 'implement',
          provider: {
            type: 'opencode',
            network_access: true,
          },
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfig(raw, pieceDir);

    // Then
    expect(config.movements[0]?.providerOptions).toEqual({
      opencode: {
        networkAccess: true,
      },
    });
  });

  it('movement の provider.claude.sandbox が movement の providerOptions へ反映される', () => {
    // Given: movement.provider に claude sandbox がある
    const raw = {
      name: 'claude-sandbox',
      movements: [
        {
          name: 'implement',
          provider: {
            type: 'claude',
            sandbox: {
              allow_unsandboxed_commands: true,
              excluded_commands: ['npm', 'npx'],
            },
          },
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfig(raw, pieceDir);

    // Then
    expect(config.movements[0]?.providerOptions).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['npm', 'npx'],
        },
      },
    });
  });

  it('piece_config.provider が pieceConfig に反映される', () => {
    // Given: piece_config に provider ブロックがある
    const raw = {
      name: 'piece-provider',
      piece_config: {
        provider: {
          type: 'codex',
          model: 'gpt-5.3',
        },
      },
      movements: [
        {
          name: 'implement',
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfig(raw, pieceDir);

    // Then
    const pieceConfig = config as { provider?: string; model?: string };
    expect(pieceConfig.provider).toBe('codex');
    expect(pieceConfig.model).toBe('gpt-5.3');
  });

  it('piece_config.provider の provider_options が movement に継承される', () => {
    // Given: piece_config.provider に provider_options 相当の値がある
    const raw = {
      name: 'piece-provider-options',
      piece_config: {
        provider: {
          type: 'codex',
          network_access: true,
        },
      },
      movements: [
        {
          name: 'implement',
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfig(raw, pieceDir);

    // Then
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('旧形式の movement.model は warning で扱われる', () => {
    // Given: movement.model（非推奨）を使う
    const raw = {
      name: 'deprecated-model',
      movements: [
        {
          name: 'implement',
          provider: 'codex',
          model: 'gpt-5.3',
          instruction: '{task}',
        },
      ],
    };

    // When
    const warnings: string[] = [];
    const config = normalizePieceConfigWithWarning(raw, pieceDir, undefined, (message) => {
      warnings.push(message);
    });

    // Then
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((entry) => entry.includes('model'))).toBe(true);
    expect(config.movements[0]?.model).toBe('gpt-5.3');
  });

  it('旧形式の movement.provider_options は warning で扱われる', () => {
    // Given: movement.provider_options（非推奨）を使う
    const raw = {
      name: 'deprecated-provider-options',
      movements: [
        {
          name: 'implement',
          provider: 'codex',
          provider_options: {
            codex: {
              network_access: true,
            },
          },
          instruction: '{task}',
        },
      ],
    };

    // When
    const warnings: string[] = [];
    const config = normalizePieceConfigWithWarning(raw, pieceDir, undefined, (message) => {
      warnings.push(message);
    });

    // Then
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((entry) => entry.includes('provider_options'))).toBe(true);
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('旧形式の movement provider が後方互換でパースできる', () => {
    // Given: movement.provider + movement.model + 旧 provider_options を併用
    const raw = {
      name: 'legacy-movement',
      movements: [
        {
          name: 'implement',
          provider: 'codex',
          model: 'gpt-4o',
          provider_options: {
            codex: {
              network_access: true,
            },
          },
          instruction: '{task}',
        },
      ],
    };

    // When
    const config = normalizePieceConfigWithWarning(raw, pieceDir);

    // Then
    expect(config.movements[0]?.provider).toBe('codex');
    expect(config.movements[0]?.model).toBe('gpt-4o');
    expect(config.movements[0]?.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });
});

describe('global config provider block', () => {
  let configRoot: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    configRoot = createTempDir('takt-global-config-block');
    process.env.TAKT_CONFIG_DIR = configRoot;
    invalidateGlobalConfigCache();
    mkdirSync(configRoot, { recursive: true });
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    if (existsSync(configRoot)) {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('persona_providers の type キーが採用される', () => {
    // Given: persona_providers が新形式（type）で記載されている
    writeConfig(join(configRoot, 'config.yaml'), [
      'provider: claude',
      'persona_providers:',
      '  reviewer:',
      '    type: codex',
      '    model: gpt-5.3',
    ]);

    // When
    const config = loadGlobalConfig();

    // Then
    expect(config.personaProviders?.reviewer?.provider).toBe('codex');
    expect(config.personaProviders?.reviewer?.model).toBe('gpt-5.3');
  });

  it('persona_providers の provider キー（旧形式）で warning が出る', () => {
    // Given: persona_providers が旧形式（provider）で記載されている
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeConfig(join(configRoot, 'config.yaml'), [
      'provider: claude',
      'persona_providers:',
      '  reviewer:',
      '    provider: codex',
      '    model: gpt-5.3',
    ]);

    // When
    const config = loadGlobalConfig();

    // Then
    expect(config.personaProviders?.reviewer?.provider).toBe('codex');
    expect(config.personaProviders?.reviewer?.model).toBe('gpt-5.3');
    expect(warnSpy).toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((entry) => String(entry[0]));
    expect(messages.some((entry) => entry.includes('provider') && entry.includes('deprecated'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('loadGlobalConfig が新形式の provider block を受け取れる（移行後仕様）', () => {
    // Given: global provider に新形式がある
    writeConfig(join(configRoot, 'config.yaml'), [
      'provider:',
      '  type: codex',
      '  model: gpt-5.3',
      '  network_access: true',
    ]);

    // When
    const config = loadGlobalConfig();

    // Then
    expect(config.provider).toBe('codex');
    expect(config.model).toBe('gpt-5.3');
    expect(config.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('string provider + model で deprecated warn が出る', () => {
    // Given: provider が文字列、model が top-level（非推奨パターン）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeConfig(join(configRoot, 'config.yaml'), [
      'provider: codex',
      'model: gpt-5.3',
    ]);

    // When
    loadGlobalConfig();

    // Then
    const messages = warnSpy.mock.calls.map((entry) => String(entry[0]));
    expect(messages.some((entry) => entry.includes('model') && entry.includes('deprecated'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('string provider + provider_options で deprecated warn が出る', () => {
    // Given: provider が文字列、provider_options が top-level（非推奨パターン）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeConfig(join(configRoot, 'config.yaml'), [
      'provider: codex',
      'provider_options:',
      '  codex:',
      '    network_access: true',
    ]);

    // When
    loadGlobalConfig();

    // Then
    const messages = warnSpy.mock.calls.map((entry) => String(entry[0]));
    expect(messages.some((entry) => entry.includes('provider_options') && entry.includes('deprecated'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('object-provider + top-level model で deprecated warn が出る', () => {
    // Given: provider がオブジェクト形式で、model が top-level（非推奨パターン）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeConfig(join(configRoot, 'config.yaml'), [
      'provider:',
      '  type: codex',
      'model: gpt-5.3',
    ]);

    // When
    loadGlobalConfig();

    // Then
    const messages = warnSpy.mock.calls.map((entry) => String(entry[0]));
    expect(messages.some((entry) => entry.includes('model') && entry.includes('deprecated'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('project config provider block', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('takt-project-config-block');
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'pieces', 'personas'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('loadProjectConfig が新形式の provider block を受け取れる', () => {
    // Given: project config の provider を新形式で記載
    writeConfig(join(projectDir, '.takt', 'config.yaml'), [
      'piece: default',
      'provider:',
      '  type: codex',
      '  model: gpt-5.3',
      '  network_access: false',
    ]);

    // When
    const config = loadProjectConfig(projectDir);

    // Then
    expect(config.provider).toBe('codex');
    expect(config.model).toBe('gpt-5.3');
    expect(config.providerOptions).toEqual({
      codex: {
        networkAccess: false,
      },
    });
  });

  it('string provider + model で deprecated warn が出る', () => {
    // Given: provider が文字列、model が top-level（非推奨パターン）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeConfig(join(projectDir, '.takt', 'config.yaml'), [
      'piece: default',
      'provider: codex',
      'model: gpt-5.3',
    ]);

    // When
    loadProjectConfig(projectDir);

    // Then
    const messages = warnSpy.mock.calls.map((entry) => String(entry[0]));
    expect(messages.some((entry) => entry.includes('model') && entry.includes('deprecated'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('string provider + provider_options で deprecated warn が出る', () => {
    // Given: provider が文字列、provider_options が top-level（非推奨パターン）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeConfig(join(projectDir, '.takt', 'config.yaml'), [
      'piece: default',
      'provider: codex',
      'provider_options:',
      '  codex:',
      '    network_access: true',
    ]);

    // When
    loadProjectConfig(projectDir);

    // Then
    const messages = warnSpy.mock.calls.map((entry) => String(entry[0]));
    expect(messages.some((entry) => entry.includes('provider_options') && entry.includes('deprecated'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('object-provider + top-level model で deprecated warn が出る', () => {
    // Given: provider がオブジェクト形式で、model が top-level（非推奨パターン）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeConfig(join(projectDir, '.takt', 'config.yaml'), [
      'piece: default',
      'provider:',
      '  type: codex',
      'model: gpt-5.3',
    ]);

    // When
    loadProjectConfig(projectDir);

    // Then
    const messages = warnSpy.mock.calls.map((entry) => String(entry[0]));
    expect(messages.some((entry) => entry.includes('model') && entry.includes('deprecated'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('provider resolution priority with piece-level candidates', () => {
  it('resolveMovementProviderModel が piece model / provider を優先候補に含める', () => {
    // When: persona 無し・movement 無しで piece-level provider がある
    const resolved = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'planner' },
      provider: 'claude',
      model: 'global-model',
      pieceProvider: 'codex',
      pieceModel: 'piece-model',
    });

    // Then
    expect(resolved.provider).toBe('codex');
    expect(resolved.model).toBe('piece-model');
  });
});

describe('provider block integration through task execution', () => {
  let projectDir: string;
  let piecePath: string;
  let originalTmpdir: string | undefined;
  let originalConfigDir: string | undefined;
  let tempGlobalDir: string;

  beforeEach(() => {
    // Isolate TMPDIR: save current value and reset to system default
    originalTmpdir = process.env['TMPDIR'];
    delete process.env['TMPDIR'];

    // Isolate global config: use an empty temp dir to prevent developer's
    // ~/.takt/config.yaml from contaminating providerOptions
    originalConfigDir = process.env['TAKT_CONFIG_DIR'];
    tempGlobalDir = mkdtempSync(join(tmpdir(), 'takt-test-global-'));
    process.env['TAKT_CONFIG_DIR'] = tempGlobalDir;
    invalidateGlobalConfigCache();

    projectDir = createTempDir('takt-provider-block-exec');
    piecePath = join(projectDir, '.takt', 'pieces', 'provider-block-it.yaml');
    writeConfig(piecePath, [
      'name: provider-block-it',
      'piece_config:',
      '  provider:',
      '    type: codex',
      '    model: gpt-5.3',
      '    network_access: true',
      'movements:',
      '  - name: plan',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]);

    vi.mocked(runAgent).mockResolvedValue({
      persona: 'planner',
      status: 'done',
      content: '[PLAN:1]\ndone',
      timestamp: new Date(),
      sessionId: 'session-it',
    });
  });

  afterEach(() => {
    // Restore TMPDIR
    if (originalTmpdir === undefined) {
      delete process.env['TMPDIR'];
    } else {
      process.env['TMPDIR'] = originalTmpdir;
    }

    // Restore global config dir
    if (originalConfigDir === undefined) {
      delete process.env['TAKT_CONFIG_DIR'];
    } else {
      process.env['TAKT_CONFIG_DIR'] = originalConfigDir;
    }
    invalidateGlobalConfigCache();

    if (existsSync(tempGlobalDir)) {
      rmSync(tempGlobalDir, { recursive: true, force: true });
    }
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('piece_config.provider が runTask 経由で実行時 provider/model へ反映される', async () => {
    // Given: piece に provider ブロックのみを設定した YAML
    // When
    const ok = await executeTask({
      task: 'テストタスク',
      cwd: projectDir,
      projectCwd: projectDir,
      pieceIdentifier: 'provider-block-it',
    });

    // Then
    expect(ok).toBe(true);
    const args = vi.mocked(runAgent).mock.calls[0] ?? [];
    const options = args[2] as { provider?: string; model?: string; providerOptions?: { codex?: { networkAccess?: boolean } } } | undefined;
    expect(options?.provider).toBe('codex');
    expect(options?.model).toBe('gpt-5.3');
    expect(options?.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });
});
