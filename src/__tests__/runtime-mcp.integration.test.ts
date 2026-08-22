import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// Modules under test (implemented in the following `implement` step).
import {
  resolveRuntimeProviderFile,
} from '../infra/config/runtime-provider/loader.js';
import {
  resolveMcpAssignment,
} from '../infra/config/runtime-provider/mcp-assignment.js';
import {
  hasActiveMcpSection,
} from '../infra/config/runtime-provider/mode.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-INTEGRATION-TESTS` (要件86,87,88,89,90,91,92)
 *   - リポジトリ内に deterministic な stdio MCP server fixture を用意する
 *   - target に一致した agent だけへ server が割り当てられる
 *   - default 指定が通常 step/parallel/fan-in/内部 agent へ適用される
 *   - exclude が default/addition より優先される
 *   - provider adapter が期待する引数/SDK option/設定ファイルを生成する
 *   - provider 起動失敗・abort 後に一時ファイルが残らない
 *   - workflow legacy 設定との混在が fail-fast する
 *
 * 注意:
 *   このファイルは loader → mode → resolveMcpAssignment の連鎖を通した
 *   roundtrip を検証する。各 provider adapter の生成物検証は provider-mcp-runtime
 *   系テストに委譲し、ここでは「設定読込 → active 判定 → 集合解決」の経路を固定する。
 *   真のワークフロー実行を通した E2E は e2e/specs/runtime-mcp.e2e.ts で扱う。
 */

let root: string;
let projectDir: string;

function writeRuntimeYaml(dir: string, lines: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RUNTIME_PROVIDER_FILENAME), lines.join('\n'), 'utf-8');
}

const COMMON_RUNTIME_YAML = [
  'version: 1',
  'mcp:',
  '  servers:',
  '    common:',
  '      command: common-srv',
  '    github:',
  '      type: http',
  '      url: https://api.github.com/mcp',
  '    legacy:',
  '      type: sse',
  '      url: http://legacy.local/sse',
];

function baseCtx(overrides: {
  persona?: string;
  tags?: string[];
  stepQualifiedName?: string;
  isWorkflowCallNode?: boolean;
  isInternalAgent?: boolean;
} = {}) {
  return {
    persona: 'coder',
    tags: [] as string[],
    stepQualifiedName: 'default/plan',
    isWorkflowCallNode: false,
    isInternalAgent: false,
    ...overrides,
  };
}

describe('runtime MCP integration: loader → mode → resolveMcpAssignment (MCP-INTEGRATION-TESTS)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-mcp-integration-'));
    projectDir = join(root, 'project-.takt');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Given a runtime.yaml with mcp servers/defaults/targets, When loaded and resolved, Then the effective servers match the configured targets', () => {
    writeRuntimeYaml(projectDir, [
      ...COMMON_RUNTIME_YAML,
      '  defaults:',
      '    servers:',
      '      - common',
      '  targets:',
      '    personas:',
      '      release-manager:',
      '        servers:',
      '          - github',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir });
    expect(resolved?.mcp).toBeDefined();
    expect(hasActiveMcpSection(resolved)).toBe(true);

    const assignment = resolveMcpAssignment(resolved!.mcp!, baseCtx({ persona: 'release-manager' }));
    expect(assignment.serverNames.sort()).toEqual(['common', 'github']);
  });

  it('Given a step target with a fully-qualified name, When resolved, Then only the matching step gets the server', () => {
    writeRuntimeYaml(projectDir, [
      ...COMMON_RUNTIME_YAML,
      '  defaults:',
      '    servers:',
      '      - common',
      '  targets:',
      '    steps:',
      '      release/create-pr:',
      '        servers:',
      '          - github',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir });

    const matching = resolveMcpAssignment(
      resolved!.mcp!,
      baseCtx({ stepQualifiedName: 'release/create-pr' }),
    );
    expect(matching.serverNames.sort()).toEqual(['common', 'github']);

    const nonMatching = resolveMcpAssignment(
      resolved!.mcp!,
      baseCtx({ stepQualifiedName: 'release/other-step' }),
    );
    expect(nonMatching.serverNames).toEqual(['common']);
  });

  it('Given exclude on a target, When resolved, Then exclude wins over default and addition', () => {
    writeRuntimeYaml(projectDir, [
      ...COMMON_RUNTIME_YAML,
      '  defaults:',
      '    servers:',
      '      - common',
      '  targets:',
      '    tags:',
      '      redact:',
      '        exclude:',
      '          - common',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir });

    const result = resolveMcpAssignment(resolved!.mcp!, baseCtx({ tags: ['redact'] }));
    expect(result.serverNames).toEqual([]);
  });

  it('Given internal_agents.selector.exclude, When resolving an internal agent, Then the exclude applies', () => {
    writeRuntimeYaml(projectDir, [
      ...COMMON_RUNTIME_YAML,
      '  defaults:',
      '    servers:',
      '      - common',
      '  targets:',
      '    internal_agents:',
      '      selector:',
      '        exclude:',
      '          - common',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir });

    const internalResult = resolveMcpAssignment(
      resolved!.mcp!,
      baseCtx({
        persona: 'selector',
        stepQualifiedName: 'internal/selector',
        isInternalAgent: true,
      }),
    );
    expect(internalResult.serverNames).toEqual([]);

    const normalResult = resolveMcpAssignment(resolved!.mcp!, baseCtx());
    expect(normalResult.serverNames).toEqual(['common']);
  });

  it('Given a workflow_call node, When resolving, Then step targets do not apply to it', () => {
    writeRuntimeYaml(projectDir, [
      ...COMMON_RUNTIME_YAML,
      '  defaults:',
      '    servers:',
      '      - common',
      '  targets:',
      '    steps:',
      '      release/create-pr:',
      '        servers:',
      '          - github',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir });

    const result = resolveMcpAssignment(
      resolved!.mcp!,
      baseCtx({ stepQualifiedName: 'release/create-pr', isWorkflowCallNode: true }),
    );
    // workflow_call node: only defaults apply, step target skipped.
    expect(result.serverNames).toEqual(['common']);
  });

  it('Given a target referencing an unknown server, When loaded, Then it fails fast', () => {
    writeRuntimeYaml(projectDir, [
      ...COMMON_RUNTIME_YAML,
      '  defaults:',
      '    servers:',
      '      - common',
      '  targets:',
      '    personas:',
      '      rm:',
      '        servers:',
      '          - nonexistent',
    ]);
    // Unknown server references are validated at load time, before any agent
    // execution resolves an assignment (order.md:104).
    expect(() =>
      resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir }),
    ).toThrow(/unknown server "nonexistent"/);
  });

  it('Given an inactive mcp section (empty), When mode is determined, Then it is NOT active', () => {
    writeRuntimeYaml(projectDir, ['version: 1']);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir });
    expect(hasActiveMcpSection(resolved)).toBe(false);
  });

  it('Given mcp active and provider active together, When loaded, Then both sections survive independently', () => {
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: default',
      '  profiles:',
      '    default:',
      '      provider: mock',
      '      model: m',
      'mcp:',
      '  servers:',
      '    common:',
      '      command: common-srv',
      '  defaults:',
      '    servers:',
      '      - common',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: projectDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.profiles?.default?.provider).toBe('mock');
    expect(resolved?.mcp?.servers?.common).toMatchObject({ command: 'common-srv' });
    expect(hasActiveMcpSection(resolved)).toBe(true);
  });
});

describe('deterministic stdio MCP server fixture (MCP-INTEGRATION-TESTS)', () => {
  const fixtureRunner = join(
    process.cwd(),
    'src/__tests__/helpers/mcp-source-stdio-entrypoint.ts',
  );

  it('Given the repository-hosted stdio MCP fixture, When initialized and called through the MCP client, Then it returns an observable deterministic tool result', async () => {
    const fixtureWorkspace = mkdtempSync(join(process.cwd(), '.tmp-takt-mcp-fixture-workspace-'));
    mkdirSync(join(fixtureWorkspace, '.takt'), { recursive: true });
    writeFileSync(join(fixtureWorkspace, '.takt', 'config.yaml'), 'branch_name_strategy: romaji\n', 'utf-8');
    const client = new Client({ name: 'takt-runtime-mcp-test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        'node_modules/.bin/vite-node',
        '--config',
        'src/__tests__/helpers/vite-node.config.ts',
        fixtureRunner,
      ],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.TAKT_CONFIG_DIR !== undefined
          ? { TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR }
          : {}),
      },
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const result = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd: fixtureWorkspace,
          task: 'Runtime MCP fixture task',
          workflow: 'default',
          worktree: false,
          autoPr: false,
        },
      });

      expect(tools.tools.map((tool) => tool.name)).toEqual(['takt_enqueue_task']);
      expect(result.isError).toBeUndefined();
      const content = result.content;
      const firstContent = Array.isArray(content) ? content[0] : undefined;
      const resultText = firstContent !== null
        && typeof firstContent === 'object'
        && firstContent !== undefined
        && 'text' in firstContent
        ? firstContent.text
        : undefined;
      expect(JSON.parse(String(resultText))).toEqual(expect.objectContaining({
        tasksFile: join(fixtureWorkspace, '.takt', 'tasks.yaml'),
        workflow: 'default',
      }));
    } finally {
      try {
        await client.close();
      } finally {
        rmSync(fixtureWorkspace, { recursive: true, force: true });
      }
    }
  });

  it('Given a runtime.yaml referencing the fixture, When loaded and resolved, Then the fixture server is in the effective set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takt-mcp-fixture-runtime-'));
    try {
      writeRuntimeYaml(dir, [
        'version: 1',
        'mcp:',
        '  servers:',
        '    echo:',
        '      command: node',
        '      args:',
        '        - node_modules/.bin/vite-node',
        '        - --config',
        '        - src/__tests__/helpers/vite-node.config.ts',
        `        - ${fixtureRunner}`,
        '  defaults:',
        '    servers:',
        '      - echo',
      ]);
      const resolved = resolveRuntimeProviderFile({ globalConfigDir: dir, projectConfigDir: dir });
      const assignment = resolveMcpAssignment(resolved!.mcp!, baseCtx());
      expect(assignment.serverNames).toEqual(['echo']);
      expect(assignment.servers?.echo).toMatchObject({ command: 'node' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
