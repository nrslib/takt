import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unexpectedConfigEnv } from '../../test/helpers/unknown-contract-test-keys.js';
import { envVarNameFromPath } from '../infra/config/env/config-env-overrides.js';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const removedConfigEnv = unexpectedConfigEnv;

const testRoot = join(tmpdir(), `takt-config-env-${randomUUID()}`);
const globalTaktDir = join(testRoot, 'global');
const globalConfigPath = join(globalTaktDir, 'config.yaml');

type ConfigWithObservability<T> = T & {
  observability?: {
    enabled?: boolean;
    monitor?: boolean;
    sessionLogExporter?: boolean;
    usageEventsPhase?: boolean;
  };
};

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

let taktEnvSnapshot: TaktEnvSnapshot;

beforeEach(() => {
  taktEnvSnapshot = clearTaktEnv();
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

  it('global config の base_url 明示値は env override より優先される', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(
      globalConfigPath,
      [
        'provider_options:',
        '  codex:',
        '    base_url: http://global.example.test/v1',
        '  claude:',
        '    base_url: http://global.example.test',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL = 'http://env.example.test/v1';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL = 'http://env.example.test';

    const config = loadGlobalConfig();

    expect(config.providerOptions).toEqual({
      codex: { baseUrl: 'http://global.example.test/v1' },
      claude: { baseUrl: 'http://global.example.test' },
    });
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

  it('project config の base_url 明示値は env override より優先される', () => {
    const projectDir = join(testRoot, 'project-base-url-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  codex:',
        '    base_url: http://127.0.0.1:8787/v1',
        '  claude:',
        '    base_url: http://localhost:8787',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL = 'http://env.example.test/v1';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL = 'http://env.example.test';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      codex: { baseUrl: 'http://127.0.0.1:8787/v1' },
      claude: { baseUrl: 'http://localhost:8787' },
    });
  });

  it('project config はファイル由来の非 loopback base_url を拒否する', () => {
    const projectDir = join(testRoot, 'project-base-url-external-file');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  codex:',
        '    base_url: https://attacker.example.test/v1',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadProjectConfig(projectDir))
      .toThrow(/provider_options\.codex\.base_url must use a loopback base_url/);
  });

  it('project config に base_url がない場合は env override を反映する', () => {
    const projectDir = join(testRoot, 'project-base-url-env-fallback');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['provider_options:', '  codex:', '    network_access: false'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL = 'http://env.example.test/v1';
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL = 'http://env.example.test';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      codex: {
        baseUrl: 'http://env.example.test/v1',
        networkAccess: false,
      },
      claude: { baseUrl: 'http://env.example.test' },
    });
  });

  it('project config は opencode.variant の env override を traced-config 経由で反映する', () => {
    const projectDir = join(testRoot, 'project-opencode-variant-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  opencode:',
        '    network_access: false',
        '    variant: low',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT = 'high';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      opencode: {
        networkAccess: false,
        variant: 'high',
      },
    });
  });

  it('project config は kiro.agent の env override を traced-config 経由で反映する', () => {
    const projectDir = join(testRoot, 'project-kiro-agent-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'provider_options:',
        '  kiro:',
        '    agent: config-agent',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_KIRO_AGENT = 'env-agent';

    const config = loadProjectConfig(projectDir);

    expect(config.providerOptions).toEqual({
      kiro: { agent: 'env-agent' },
    });
  });

  it('global config は provider_options.kiro.agent を読み込む', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(
      globalConfigPath,
      [
        'provider: kiro',
        'provider_options:',
        '  kiro:',
        '    agent: global-default-agent',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.providerOptions).toEqual({
      kiro: { agent: 'global-default-agent' },
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

  it('global config は observability の root JSON env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_OBSERVABILITY = JSON.stringify({
      enabled: true,
      monitor: false,
      session_log_exporter: true,
      usage_events_phase: false,
    });

    const config = loadGlobalConfig() as ConfigWithObservability<ReturnType<typeof loadGlobalConfig>>;

    expect(config.observability).toEqual({
      enabled: true,
      monitor: false,
      sessionLogExporter: true,
      usageEventsPhase: false,
    });
  });

  it('global config は observability の root JSON env と leaf env 併用時に leaf を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_OBSERVABILITY = JSON.stringify({
      enabled: false,
      monitor: false,
      session_log_exporter: false,
      usage_events_phase: false,
    });
    process.env.TAKT_OBSERVABILITY_ENABLED = 'true';
    process.env.TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE = 'true';

    const config = loadGlobalConfig() as ConfigWithObservability<ReturnType<typeof loadGlobalConfig>>;

    expect(config.observability).toEqual({
      enabled: true,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: true,
    });
  });

  it('project config は observability の leaf env override を反映する', () => {
    const projectDir = join(testRoot, 'project-observability-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      [
        'observability:',
        '  enabled: false',
        '  monitor: false',
        '  session_log_exporter: false',
        '  usage_events_phase: false',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_OBSERVABILITY_ENABLED = 'true';
    process.env.TAKT_OBSERVABILITY_MONITOR = 'true';
    process.env.TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER = 'true';

    const config = loadProjectConfig(projectDir) as ConfigWithObservability<ReturnType<typeof loadProjectConfig>>;

    expect(config.observability).toEqual({
      enabled: true,
      monitor: true,
      sessionLogExporter: true,
      usageEventsPhase: false,
    });
  });

  it('project config は observability の root JSON env と leaf env 併用時に leaf を優先する', () => {
    const projectDir = join(testRoot, 'project-observability-root-and-leaf');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_OBSERVABILITY = JSON.stringify({
      enabled: true,
      monitor: false,
      session_log_exporter: false,
      usage_events_phase: false,
    });
    process.env.TAKT_OBSERVABILITY_MONITOR = 'true';

    const config = loadProjectConfig(projectDir) as ConfigWithObservability<ReturnType<typeof loadProjectConfig>>;

    expect(config.observability).toEqual({
      enabled: true,
      monitor: true,
      sessionLogExporter: false,
      usageEventsPhase: false,
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

  it('project config は removed runtime_prepare env を無視する', () => {
    const projectDir = join(testRoot, 'project-removed-runtime-prepare-root-and-leaf');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepare] = JSON.stringify({
      custom_scripts: false,
    });
    process.env[removedConfigEnv.workflowRuntimePrepareCustomScripts] = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.workflowRuntimePrepare).toBeUndefined();
  });

  it('project config は workflow_runtime_prepare の新 env 名を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-runtime-prepare-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.workflowRuntimePrepare).toEqual({
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

    expect(config.workflowRuntimePrepare).toEqual({
      customScripts: true,
    });
  });

  it('project config は workflow_command_gates の leaf env を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-command-gates-leaf-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_COMMAND_GATES_CUSTOM_SCRIPTS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.workflowCommandGates).toEqual({
      customScripts: true,
    });
  });

  it('project config は workflow_command_gates の root JSON env を反映する', () => {
    const projectDir = join(testRoot, 'project-workflow-command-gates-root-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env.TAKT_WORKFLOW_COMMAND_GATES = JSON.stringify({
      custom_scripts: true,
    });

    const config = loadProjectConfig(projectDir);

    expect(config.workflowCommandGates).toEqual({
      customScripts: true,
    });
  });

  it('project config は removed runtime_prepare env と canonical env が同時指定でも canonical env を優先する', () => {
    const projectDir = join(testRoot, 'project-workflow-runtime-prepare-env-priority');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepareCustomScripts] = 'false';
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.workflowRuntimePrepare).toEqual({
      customScripts: true,
    });
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

    expect(config.workflowArpeggio).toEqual({
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

    expect(config.workflowArpeggio).toEqual({
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

    expect(config.workflowMcpServers).toEqual({
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

    expect(config.workflowMcpServers).toEqual({
      stdio: true,
      http: false,
      sse: true,
    });
  });

  it('project config は sync_project_local_takt_on_retry の env override を反映する', () => {
    const projectDir = join(testRoot, 'project-sync-project-local-takt-on-retry-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      'sync_project_local_takt_on_retry: false\n',
      'utf-8',
    );
    process.env.TAKT_SYNC_PROJECT_LOCAL_TAKT_ON_RETRY = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.syncProjectLocalTaktOnRetry).toBe(true);
  });

  it('project config は auto_requeue_max_attempts と ignore_exceed の env override を反映する', () => {
    const projectDir = join(testRoot, 'project-run-retry-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      ['auto_requeue_max_attempts: 1', 'ignore_exceed: false'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_AUTO_REQUEUE_MAX_ATTEMPTS = '2';
    process.env.TAKT_IGNORE_EXCEED = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.autoRequeueMaxAttempts).toBe(2);
    expect(config.ignoreExceed).toBe(true);
  });

  it('global config は enable_builtin_workflows の新 env 名を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_ENABLE_BUILTIN_WORKFLOWS = 'true';

    const config = loadGlobalConfig();

    expect(config.enableBuiltinWorkflows).toBe(true);
  });

  it('global config は removed enable_builtin env と canonical env が同時指定でも canonical env を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env[removedConfigEnv.enableBuiltinWorkflows] = 'false';
    process.env.TAKT_ENABLE_BUILTIN_WORKFLOWS = 'true';

    const config = loadGlobalConfig();

    expect(config.enableBuiltinWorkflows).toBe(true);
  });

  it('global config は workflow notification の新 env 名を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_COMPLETE = 'true';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_ABORT = 'false';

    const config = loadGlobalConfig();

    expect(config.notificationSoundEvents).toEqual({
      workflowComplete: true,
      workflowAbort: false,
    });
  });

  it('global config は removed workflow notification env と canonical env が同時指定でも canonical env を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env[removedConfigEnv.notificationWorkflowComplete] = 'false';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_COMPLETE = 'true';

    const config = loadGlobalConfig();

    expect(config.notificationSoundEvents).toEqual({
      workflowComplete: true,
    });
  });

  it('global config は workflow_categories_file の新 env 名を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_CATEGORIES_FILE = '/tmp/workflow-categories.yaml';

    const config = loadGlobalConfig();

    expect(config.workflowCategoriesFile).toBe('/tmp/workflow-categories.yaml');
  });

  it('global config は removed workflow_categories_file env と canonical env が同時指定でも canonical env を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env[removedConfigEnv.workflowCategoriesFile] = '/tmp/removed-workflow-categories.yaml';
    process.env.TAKT_WORKFLOW_CATEGORIES_FILE = '/tmp/workflow-categories.yaml';

    const config = loadGlobalConfig();

    expect(config.workflowCategoriesFile).toBe('/tmp/workflow-categories.yaml');
  });

  it('global config は workflow_runtime_prepare の root JSON env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE = JSON.stringify({
      custom_scripts: true,
    });

    const config = loadGlobalConfig();

    expect(config.workflowRuntimePrepare).toEqual({
      customScripts: true,
    });
  });

  it('global config は workflow_command_gates の leaf env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_COMMAND_GATES_CUSTOM_SCRIPTS = 'true';

    const config = loadGlobalConfig();

    expect(config.workflowCommandGates).toEqual({
      customScripts: true,
    });
  });

  it('global config は workflow_command_gates の root JSON env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_COMMAND_GATES = JSON.stringify({
      custom_scripts: true,
    });

    const config = loadGlobalConfig();

    expect(config.workflowCommandGates).toEqual({
      customScripts: true,
    });
  });

  it('global config は sync_project_local_takt_on_retry の env override を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(
      globalConfigPath,
      ['language: ja', 'sync_project_local_takt_on_retry: true'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_SYNC_PROJECT_LOCAL_TAKT_ON_RETRY = 'false';

    const config = loadGlobalConfig();

    expect(config.syncProjectLocalTaktOnRetry).toBe(false);
  });

  it('global config は auto_requeue_max_attempts と ignore_exceed の env override を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(
      globalConfigPath,
      ['language: ja', 'auto_requeue_max_attempts: 1', 'ignore_exceed: false'].join('\n'),
      'utf-8',
    );
    process.env.TAKT_AUTO_REQUEUE_MAX_ATTEMPTS = '4';
    process.env.TAKT_IGNORE_EXCEED = 'true';

    const config = loadGlobalConfig();

    expect(config.autoRequeueMaxAttempts).toBe(4);
    expect(config.ignoreExceed).toBe(true);
  });

  it('global config は workflow 系 leaf env を反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: ja\n', 'utf-8');
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env.TAKT_WORKFLOW_COMMAND_GATES_CUSTOM_SCRIPTS = 'true';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES = 'true';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_INLINE_JS = 'false';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_STDIO = 'true';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'false';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_SSE = 'true';

    const config = loadGlobalConfig();

    expect(config.workflowRuntimePrepare).toEqual({
      customScripts: true,
    });
    expect(config.workflowCommandGates).toEqual({
      customScripts: true,
    });
    expect(config.workflowArpeggio).toEqual({
      customDataSourceModules: true,
      customMergeInlineJs: false,
      customMergeFiles: true,
    });
    expect(config.workflowMcpServers).toEqual({
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

    expect(config.workflowArpeggio).toEqual({
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

    expect(config.workflowMcpServers).toEqual({
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

  it('current logging env は global logging に反映する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env.TAKT_LOGGING_LEVEL = 'warn';
    process.env.TAKT_LOGGING_PROVIDER_EVENTS = 'true';

    const config = loadGlobalConfig();

    expect(config.logging).toEqual({
      level: 'warn',
      providerEvents: true,
    });
  });

  it('removed builtins env は global config では無視される', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env[removedConfigEnv.enableBuiltinWorkflows] = 'true';

    const config = loadGlobalConfig();

    expect(config.enableBuiltinWorkflows).toBeUndefined();
  });

  it('removed categories env は global config では無視される', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env[removedConfigEnv.workflowCategoriesFile] = '/tmp/removed-workflow-categories.yaml';

    const config = loadGlobalConfig();

    expect(config.workflowCategoriesFile).toBeUndefined();
  });

  it('removed workflow notification env は global config では無視される', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env[removedConfigEnv.notificationWorkflowComplete] = 'true';
    process.env[removedConfigEnv.notificationWorkflowAbort] = 'false';

    const config = loadGlobalConfig();

    expect(config.notificationSoundEvents).toBeUndefined();
  });

  it('removed leaf env は global config では無視される', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepareCustomScripts] = 'true';
    process.env[removedConfigEnv.workflowArpeggioCustomDataSourceModules] = 'true';
    process.env[removedConfigEnv.workflowArpeggioCustomMergeInlineJs] = 'false';
    process.env[removedConfigEnv.workflowArpeggioCustomMergeFiles] = 'true';
    process.env[removedConfigEnv.workflowMcpServersStdio] = 'true';
    process.env[removedConfigEnv.workflowMcpServersHttp] = 'false';
    process.env[removedConfigEnv.workflowMcpServersSse] = 'true';
    process.env[removedConfigEnv.notificationWorkflowComplete] = 'true';
    process.env[removedConfigEnv.notificationWorkflowAbort] = 'false';

    const config = loadGlobalConfig();

    expect(config.workflowRuntimePrepare).toBeUndefined();
    expect(config.workflowArpeggio).toBeUndefined();
    expect(config.workflowMcpServers).toBeUndefined();
    expect(config.notificationSoundEvents).toBeUndefined();
  });

  it('removed runtime_prepare env は project config では無視される', () => {
    const projectDir = join(testRoot, 'project-legacy-workflow-runtime-prepare-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepare] = JSON.stringify({
      custom_scripts: true,
    });

    const config = loadProjectConfig(projectDir);

    expect(config.workflowRuntimePrepare).toBeUndefined();
  });

  it('removed runtime_prepare env が不正な JSON でも global config では無視される', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepare] = '{';

    const config = loadGlobalConfig();

    expect(config.workflowRuntimePrepare).toBeUndefined();
  });

  it('removed runtime_prepare env が不正な JSON でも project config では無視される', () => {
    const projectDir = join(testRoot, 'project-legacy-workflow-runtime-prepare-invalid-json-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepare] = '{';

    const config = loadProjectConfig(projectDir);

    expect(config.workflowRuntimePrepare).toBeUndefined();
  });

  it('removed arpeggio env は project config では無視される', () => {
    const projectDir = join(testRoot, 'project-legacy-workflow-arpeggio-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowArpeggio] = JSON.stringify({
      custom_data_source_modules: true,
      custom_merge_inline_js: false,
      custom_merge_files: true,
    });

    const config = loadProjectConfig(projectDir);

    expect(config.workflowArpeggio).toBeUndefined();
  });

  it('removed mcp_servers env は project config では無視される', () => {
    const projectDir = join(testRoot, 'project-legacy-workflow-mcp-servers-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowMcpServers] = JSON.stringify({
      stdio: true,
      http: false,
      sse: true,
    });

    const config = loadProjectConfig(projectDir);

    expect(config.workflowMcpServers).toBeUndefined();
  });

  it('removed leaf env は project config では無視される', () => {
    const projectDir = join(testRoot, 'project-legacy-workflow-leaf-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepareCustomScripts] = 'true';
    process.env[removedConfigEnv.workflowArpeggioCustomDataSourceModules] = 'true';
    process.env[removedConfigEnv.workflowArpeggioCustomMergeInlineJs] = 'false';
    process.env[removedConfigEnv.workflowArpeggioCustomMergeFiles] = 'true';
    process.env[removedConfigEnv.workflowMcpServersStdio] = 'true';
    process.env[removedConfigEnv.workflowMcpServersHttp] = 'false';
    process.env[removedConfigEnv.workflowMcpServersSse] = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.workflowRuntimePrepare).toBeUndefined();
    expect(config.workflowArpeggio).toBeUndefined();
    expect(config.workflowMcpServers).toBeUndefined();
  });

  it('project config では removed leaf env と canonical env が同時指定でも canonical env を優先する', () => {
    const projectDir = join(testRoot, 'project-legacy-workflow-leaf-env-blocked-by-workflow-env');
    const configDir = getProjectConfigDir(projectDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: codex\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepareCustomScripts] = 'false';
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env[removedConfigEnv.workflowArpeggioCustomMergeFiles] = 'false';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env[removedConfigEnv.workflowMcpServersHttp] = 'false';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'true';

    const config = loadProjectConfig(projectDir);

    expect(config.workflowRuntimePrepare).toEqual({ customScripts: true });
    expect(config.workflowArpeggio).toEqual({ customMergeFiles: true });
    expect(config.workflowMcpServers).toEqual({ http: true });
  });

  it('global config では removed leaf env と canonical env が同時指定でも canonical env を優先する', () => {
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    process.env[removedConfigEnv.workflowRuntimePrepareCustomScripts] = 'false';
    process.env.TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS = 'true';
    process.env[removedConfigEnv.workflowArpeggioCustomMergeFiles] = 'false';
    process.env.TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES = 'true';
    process.env[removedConfigEnv.workflowMcpServersHttp] = 'false';
    process.env.TAKT_WORKFLOW_MCP_SERVERS_HTTP = 'true';
    process.env[removedConfigEnv.notificationWorkflowAbort] = 'false';
    process.env.TAKT_NOTIFICATION_SOUND_EVENTS_WORKFLOW_ABORT = 'true';

    const config = loadGlobalConfig();

    expect(config.workflowRuntimePrepare).toEqual({ customScripts: true });
    expect(config.workflowArpeggio).toEqual({ customMergeFiles: true });
    expect(config.workflowMcpServers).toEqual({ http: true });
    expect(config.notificationSoundEvents).toEqual({ workflowAbort: true });
  });

  it('current logging env がある場合も legacy logging env は current を優先する', () => {
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
