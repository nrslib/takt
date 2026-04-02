import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envVarNameFromPath } from '../infra/config/env/config-env-overrides.js';

const testRoot = join(tmpdir(), `takt-config-env-${randomUUID()}`);
const globalTaktDir = join(testRoot, 'global');
const globalConfigPath = join(globalTaktDir, 'config.yaml');

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

const { loadGlobalConfig, invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { loadProjectConfig } = await import('../infra/config/project/projectConfig.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');

let taktEnvSnapshot: Record<string, string | undefined>;

function snapshotTaktEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('TAKT_')) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function restoreTaktEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TAKT_') && !(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

beforeEach(() => {
  taktEnvSnapshot = snapshotTaktEnv();
});

afterEach(() => {
  restoreTaktEnv(taktEnvSnapshot);
  invalidateGlobalConfigCache();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('config traced env overrides', () => {
  it('dotted path から traced-config 用の env 名を生成する', () => {
    expect(envVarNameFromPath('provider_options.claude.sandbox.allow_unsandboxed_commands'))
      .toBe('TAKT_PROVIDER_OPTIONS_CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_COMMANDS');
  });

  it('global config はホワイトリストされた env のみを反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\nprovider: claude\n', 'utf-8');
    process.env.TAKT_PROVIDER = 'codex';
    process.env.TAKT_VCS_PROVIDER = 'gitlab';

    const config = loadGlobalConfig();

    expect(config.provider).toBe('codex');
    expect(config.vcsProvider).toBeUndefined();
  });

  it('project config は provider_options の leaf env override を反映する', () => {
    const projectDir = join(testRoot, 'project');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    network_access: false'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('project config は effort 系の env override を traced-config 経由で反映する', () => {
    const projectDir = join(testRoot, 'project-effort-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  codex:',
        '    reasoning_effort: low',
        '  claude:',
        '    effort: low',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_REASONING_EFFORT = 'xhigh';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_EFFORT = 'max';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      codex: { reasoningEffort: 'xhigh' },
      claude: { effort: 'max' },
    });
  });

  it('project config は root JSON env で subtree 全体を置き換える', () => {
    const projectDir = join(testRoot, 'project-root-json');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  codex:',
        '    network_access: false',
        '  claude:',
        '    allowed_tools:',
        '      - Read',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS = JSON.stringify({
      claude: {
        allowed_tools: ['Bash'],
      },
    });

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      claude: { allowedTools: ['Bash'] },
    });
  });

  it('global config は root JSON env と leaf env を併用したとき logging.level で leaf を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_LOGGING = JSON.stringify({
      level: 'info',
    });
    process.env.TAKT_LOGGING_LEVEL = 'warn';

    const config = loadGlobalConfig();

    expect(config.logging).toEqual({
      level: 'warn',
    });
  });

  it('global config は root JSON env と leaf env を併用したとき logging.debug で leaf を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_LOGGING = JSON.stringify({
      debug: false,
    });
    process.env.TAKT_LOGGING_DEBUG = 'true';

    const config = loadGlobalConfig();

    expect(config.logging).toEqual({
      debug: true,
    });
  });

  it('project config は root JSON env と leaf env を併用したとき provider_options で leaf を優先する', () => {
    const projectDir = join(testRoot, 'project-provider-options-root-and-leaf');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PROVIDER_OPTIONS = JSON.stringify({
      codex: {
        network_access: false,
        reasoning_effort: 'low',
      },
    });
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      codex: {
        networkAccess: true,
        reasoningEffort: 'low',
      },
    });
  });

  it('project config は root JSON env と leaf env を併用したとき piece_runtime_prepare で leaf を優先する', () => {
    const projectDir = join(testRoot, 'project-piece-runtime-prepare-root-and-leaf');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PIECE_RUNTIME_PREPARE = JSON.stringify({
      custom_scripts: false,
    });
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.pieceRuntimePrepare).toEqual({
      customScripts: true,
    });
  });

  it('project config は workflow_runtime_prepare の新 env 名を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-runtime-prepare-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.pieceRuntimePrepare).toEqual({
      customScripts: true,
    });
  });

  it('project config は workflow_runtime_prepare の root JSON env を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-runtime-prepare-root-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE = JSON.stringify({
      custom_scripts: true,
    });

    const config = loadProjectConfig(projectDir);

    expect(config.pieceRuntimePrepare).toEqual({
      customScripts: true,
    });
  });

  it('project config は新旧 runtime_prepare env が同時指定されたとき新 env を優先する', () => {
    const projectDir = join(testRoot, 'project-workflow-runtime-prepare-env-priority');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'false';
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadProjectConfig(projectDir);

      expect(config.pieceRuntimePrepare).toEqual({
        customScripts: true,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('project config は workflow_arpeggio の新 env 名を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-arpeggio-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES = 'true';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_INLINE_JS = 'false';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.pieceArpeggio).toEqual({
      customDataSourceModules: true,
      customMergeInlineJs: false,
      customMergeFiles: true,
    });
  });

  it('project config は workflow_arpeggio の root JSON env を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-arpeggio-root-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_ARPEGGIO = JSON.stringify({
      custom_data_source_modules: true,
      custom_merge_inline_js: false,
      custom_merge_files: true,
    });

    const config = loadProjectConfig(projectDir);

    expect(config.pieceArpeggio).toEqual({
      customDataSourceModules: true,
      customMergeInlineJs: false,
      customMergeFiles: true,
    });
  });

  it('project config は workflow_mcp_servers の新 env 名を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-mcp-servers-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_MCP_SERVERS_STDIO = 'true';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'false';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_SSE = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.pieceMcpServers).toEqual({
      stdio: true,
      http: false,
      sse: true,
    });
  });

  it('project config は workflow_mcp_servers の root JSON env を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-mcp-servers-root-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_MCP_SERVERS = JSON.stringify({
      stdio: true,
      http: false,
      sse: true,
    });

    const config = loadProjectConfig(projectDir);

    expect(config.pieceMcpServers).toEqual({
      stdio: true,
      http: false,
      sse: true,
    });
  });

  it('global config は enable_builtin_workflows の新 env 名を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_ENABLE_BUILTIN_WORKFLOWS = 'true';

    const config = loadGlobalConfig();

    expect(config.enableBuiltinPieces).toBe(true);
  });

  it('global config は新旧 enable_builtin env が同時指定されたとき新 env を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_ENABLE_BUILTIN_PIECES = 'false';
    process.env.TAKT_ENABLE_BUILTIN_WORKFLOWS = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.enableBuiltinPieces).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('global config は workflow notification の新 env 名を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_COMPLETE = 'true';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_ABORT = 'false';

    const config = loadGlobalConfig();

    expect(config.notificationSoundEvents).toEqual({
      pieceComplete: true,
      pieceAbort: false,
    });
  });

  it('global config は新旧 workflow notification env が同時指定されたとき新 env を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_COMPLETE = 'false';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_COMPLETE = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.notificationSoundEvents).toEqual({
        pieceComplete: true,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('global config は workflow_categories_file の新 env 名を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_CATEGORIES_FILE = '/tmp/workflow-categories.yaml';

    const config = loadGlobalConfig();

    expect(config.pieceCategoriesFile).toBe('/tmp/workflow-categories.yaml');
  });

  it('global config は新旧 workflow_categories_file env が同時指定されたとき新 env を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_PIECE_CATEGORIES_FILE = '/tmp/legacy-piece-categories.yaml';
    process.env.TAKT_WORKFLOW_CATEGORIES_FILE = '/tmp/workflow-categories.yaml';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.pieceCategoriesFile).toBe('/tmp/workflow-categories.yaml');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('global config は workflow_runtime_prepare の root JSON env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE = JSON.stringify({
      custom_scripts: true,
    });

    const config = loadGlobalConfig();

    expect(config.pieceRuntimePrepare).toEqual({
      customScripts: true,
    });
  });

  it('global config は workflow 系 leaf env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES = 'true';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_INLINE_JS = 'false';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_STDIO = 'true';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'false';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_SSE = 'true';

    const config = loadGlobalConfig();

    expect(config.pieceRuntimePrepare).toEqual({
      customScripts: true,
    });
    expect(config.pieceArpeggio).toEqual({
      customDataSourceModules: true,
      customMergeInlineJs: false,
      customMergeFiles: true,
    });
    expect(config.pieceMcpServers).toEqual({
      stdio: true,
      http: false,
      sse: true,
    });
  });

  it('global config は workflow_arpeggio の root JSON env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_ARPEGGIO = JSON.stringify({
      custom_data_source_modules: true,
      custom_merge_inline_js: false,
      custom_merge_files: true,
    });

    const config = loadGlobalConfig();

    expect(config.pieceArpeggio).toEqual({
      customDataSourceModules: true,
      customMergeInlineJs: false,
      customMergeFiles: true,
    });
  });

  it('global config は workflow_mcp_servers の root JSON env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_MCP_SERVERS = JSON.stringify({
      stdio: true,
      http: false,
      sse: true,
    });
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'true';

    const config = loadGlobalConfig();

    expect(config.pieceMcpServers).toEqual({
      stdio: true,
      http: true,
      sse: true,
    });
  });

  it('project config は非許可の provider_options env を無視する', () => {
    const projectDir = join(testRoot, 'project-non-whitelist');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  claude:', '    allowed_tools:', '      - Read'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_ALLOWED_TOOLS = '["Bash"]';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      claude: { allowedTools: ['Read'] },
    });
  });

  it('project config は不正な codex reasoning_effort env override を拒否する', () => {
    const projectDir = join(testRoot, 'project-invalid-codex-effort-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: claude\n', 'utf-8');
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_REASONING_EFFORT = 'extreme';

    expect(() => loadProjectConfig(projectDir)).toThrow(/reasoning_effort/);
  });

  it('project config は不正な claude effort env override を拒否する', () => {
    const projectDir = join(testRoot, 'project-invalid-claude-effort-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: claude\n', 'utf-8');
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_EFFORT = 'impossible';

    expect(() => loadProjectConfig(projectDir)).toThrow(/effort/);
  });

  it('legacy env は警告付きで global logging に反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_LOG_LEVEL = 'warn';
    process.env.TAKT_OBSERVABILITY_PROVIDER_EVENTS = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.logging).toEqual({
        level: 'warn',
        providerEvents: true,
      });
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy env は警告付きで global enable_builtin_pieces に反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_ENABLE_BUILTIN_PIECES = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.enableBuiltinPieces).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy env は警告付きで global piece_categories_file に反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_PIECE_CATEGORIES_FILE = '/tmp/legacy-piece-categories.yaml';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.pieceCategoriesFile).toBe('/tmp/legacy-piece-categories.yaml');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy env は警告付きで global workflow notification に反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_COMPLETE = 'true';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_ABORT = 'false';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.notificationSoundEvents).toEqual({
        pieceComplete: true,
        pieceAbort: false,
      });
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy leaf env は警告付きで global config に反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES = 'true';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_INLINE_JS = 'false';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env.TAKT_PIECE_MCP_SERVERS_STDIO = 'true';
    process.env.TAKT_PIECE_MCP_SERVERS_HTTP = 'false';
    process.env.TAKT_PIECE_MCP_SERVERS_SSE = 'true';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_COMPLETE = 'true';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_ABORT = 'false';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.pieceRuntimePrepare).toEqual({
        customScripts: true,
      });
      expect(config.pieceArpeggio).toEqual({
        customDataSourceModules: true,
        customMergeInlineJs: false,
        customMergeFiles: true,
      });
      expect(config.pieceMcpServers).toEqual({
        stdio: true,
        http: false,
        sse: true,
      });
      expect(config.notificationSoundEvents).toEqual({
        pieceComplete: true,
        pieceAbort: false,
      });
      expect(warnSpy).toHaveBeenCalledTimes(9);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy env は警告付きで project piece_runtime_prepare に反映する', () => {
    const projectDir = join(testRoot, 'project-legacy-piece-runtime-prepare-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PIECE_RUNTIME_PREPARE = JSON.stringify({
      custom_scripts: true,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadProjectConfig(projectDir);

      expect(config.pieceRuntimePrepare).toEqual({
        customScripts: true,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy env は警告付きで project piece_arpeggio に反映する', () => {
    const projectDir = join(testRoot, 'project-legacy-piece-arpeggio-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PIECE_ARPEGGIO = JSON.stringify({
      custom_data_source_modules: true,
      custom_merge_inline_js: false,
      custom_merge_files: true,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadProjectConfig(projectDir);

      expect(config.pieceArpeggio).toEqual({
        customDataSourceModules: true,
        customMergeInlineJs: false,
        customMergeFiles: true,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy env は警告付きで project piece_mcp_servers に反映する', () => {
    const projectDir = join(testRoot, 'project-legacy-piece-mcp-servers-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PIECE_MCP_SERVERS = JSON.stringify({
      stdio: true,
      http: false,
      sse: true,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadProjectConfig(projectDir);

      expect(config.pieceMcpServers).toEqual({
        stdio: true,
        http: false,
        sse: true,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy leaf env は警告付きで project config に反映する', () => {
    const projectDir = join(testRoot, 'project-legacy-piece-leaf-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES = 'true';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_INLINE_JS = 'false';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env.TAKT_PIECE_MCP_SERVERS_STDIO = 'true';
    process.env.TAKT_PIECE_MCP_SERVERS_HTTP = 'false';
    process.env.TAKT_PIECE_MCP_SERVERS_SSE = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadProjectConfig(projectDir);

      expect(config.pieceRuntimePrepare).toEqual({
        customScripts: true,
      });
      expect(config.pieceArpeggio).toEqual({
        customDataSourceModules: true,
        customMergeInlineJs: false,
        customMergeFiles: true,
      });
      expect(config.pieceMcpServers).toEqual({
        stdio: true,
        http: false,
        sse: true,
      });
      expect(warnSpy).toHaveBeenCalledTimes(7);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('project config では新 env があると legacy leaf env は warning なしで無視する', () => {
    const projectDir = join(testRoot, 'project-legacy-piece-leaf-env-blocked-by-workflow-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'false';
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_FILES = 'false';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env.TAKT_PIECE_MCP_SERVERS_HTTP = 'false';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadProjectConfig(projectDir);

      expect(config.pieceRuntimePrepare).toEqual({
        customScripts: true,
      });
      expect(config.pieceArpeggio).toEqual({
        customMergeFiles: true,
      });
      expect(config.pieceMcpServers).toEqual({
        http: true,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('新 env があると legacy leaf env は warning なしで無視する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'false';
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env.TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_FILES = 'false';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env.TAKT_PIECE_MCP_SERVERS_HTTP = 'false';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'true';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_PIECE_ABORT = 'false';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_ABORT = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.pieceRuntimePrepare).toEqual({
        customScripts: true,
      });
      expect(config.pieceArpeggio).toEqual({
        customMergeFiles: true,
      });
      expect(config.pieceMcpServers).toEqual({
        http: true,
      });
      expect(config.notificationSoundEvents).toEqual({
        pieceAbort: true,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('新しい logging env があると legacy env は無視する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_LOG_LEVEL = 'debug';
    process.env.TAKT_LOGGING_LEVEL = 'error';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config = loadGlobalConfig();

      expect(config.logging).toEqual({
        level: 'error',
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
