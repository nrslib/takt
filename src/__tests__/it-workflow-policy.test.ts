/**
 * Workflow policy integration tests.
 *
 * Covers global x project permission matrices for workflow-declared
 * capabilities: command quality gates, mcp_servers transports,
 * runtime.prepare scripts, and Arpeggio capabilities.
 *
 * Split from it-workflow-loader.test.ts. Kept in the serial workflow test
 * group because it shares loader-level global config caching behavior.
 *
 * Mocked: loadConfig (for language/builtins)
 * Not mocked: loadWorkflow, workflow parsing, policy resolution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mocks ---
const languageState = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinWorkflows') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinWorkflows') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

// --- Imports (after mocks) ---

import { loadWorkflow } from '../infra/config/loaders/index.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';

const loadWorkflowConfig = loadWorkflow;

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfp-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('Workflow Policy IT: command quality gates', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects workflow command quality gates by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'command-gate.yaml'), `
name: command-gate
description: Workflow with command quality gate
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    quality_gates:
      - type: command
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    expect(() => loadWorkflowConfig('command-gate', testDir)).toThrow(/workflow_command_gates\.custom_scripts/);
  });

  it('rejects workflow command quality gates when project config explicitly overrides global true with false', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowCommandGates: { customScripts: true },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      'workflow_command_gates:\n  custom_scripts: false\n',
    );

    writeFileSync(join(workflowsDir, 'command-gate-denied.yaml'), `
name: command-gate-denied
description: Workflow with command quality gate denied by project
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    quality_gates:
      - type: command
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    expect(() => loadWorkflowConfig('command-gate-denied', testDir))
      .toThrow(/workflow_command_gates\.custom_scripts/);
  });

  it('preserves globally allowed workflow command quality gates when project config sets an empty policy block', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowCommandGates: { customScripts: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_command_gates: {}\n');

    writeFileSync(join(workflowsDir, 'command-gate-allowed-by-global.yaml'), `
name: command-gate-allowed-by-global
description: Workflow with command quality gate allowed by global config
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    quality_gates:
      - type: command
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('command-gate-allowed-by-global', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps.find((s) => s.name === 'implement')?.qualityGates).toEqual([
      {
        type: 'command',
        name: 'quality-check',
        command: './.takt/quality-gates/check.sh',
      },
    ]);
  });

  it('rejects parallel sub-step command quality gates by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'parallel-command-gate.yaml'), `
name: parallel-command-gate
description: Workflow with parallel command quality gate
max_steps: 5
initial_step: reviewers

steps:
  - name: reviewers
    persona: reviewers
    parallel:
      - name: arch-review
        persona: reviewer
        quality_gates:
          - type: command
            name: arch-quality-check
            command: "./.takt/quality-gates/check.sh"
        rules:
          - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
    instruction: "Run reviews"
`);

    expect(() => loadWorkflowConfig('parallel-command-gate', testDir))
      .toThrow(/Step "reviewers\.arch-review" uses command quality gate/);
  });

  it('allows parallel sub-step command quality gates when workflow command gates are enabled', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_command_gates:\n  custom_scripts: true\n');

    writeFileSync(join(workflowsDir, 'parallel-command-gate-allowed.yaml'), `
name: parallel-command-gate-allowed
description: Workflow with allowed parallel command quality gate
max_steps: 5
initial_step: reviewers

steps:
  - name: reviewers
    persona: reviewers
    parallel:
      - name: arch-review
        persona: reviewer
        quality_gates:
          - type: command
            name: arch-quality-check
            command: "./.takt/quality-gates/check.sh"
            timeout_ms: 300000
        rules:
          - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
    instruction: "Run reviews"
`);

    const config = loadWorkflowConfig('parallel-command-gate-allowed', testDir);

    expect(config).not.toBeNull();
    const reviewersStep = config!.steps.find((s) => s.name === 'reviewers');
    expect(reviewersStep?.parallel?.[0]?.qualityGates).toEqual([
      {
        type: 'command',
        name: 'arch-quality-check',
        command: './.takt/quality-gates/check.sh',
        timeoutMs: 300000,
      },
    ]);
  });
});

describe('Workflow Loader IT: mcp_servers parsing', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should reject stdio mcp_servers from workflow YAML by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'with-mcp.yaml'), `
name: with-mcp
description: Workflow with MCP servers
max_steps: 5
initial_step: e2e-test

steps:
  - name: e2e-test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run E2E tests"
`);

    expect(() => loadWorkflowConfig('with-mcp', testDir)).toThrow(/workflow_mcp_servers/);
  });

  it('should allow step without mcp_servers', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'no-mcp.yaml'), `
name: no-mcp
description: Workflow without MCP servers
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('no-mcp', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.mcpServers).toBeUndefined();
  });

  it('should reject mcp_servers with multiple transports by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'multi-mcp.yaml'), `
name: multi-mcp
description: Workflow with multiple MCP servers
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
      remote-api:
        type: http
        url: http://localhost:3000/mcp
        headers:
          Authorization: "Bearer token123"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    expect(() => loadWorkflowConfig('multi-mcp', testDir)).toThrow(/workflow_mcp_servers/);
  });

  it('should allow http/sse mcp_servers only when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      ['workflow_mcp_servers:', '  http: true', '  sse: true'].join('\n'),
      'utf-8',
    );

    writeFileSync(join(workflowsDir, 'remote-mcp.yaml'), `
name: remote-mcp
description: Workflow with remote MCP servers
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      remote-api:
        type: http
        url: https://example.com/mcp
      stream-api:
        type: sse
        url: https://example.com/sse
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    const config = loadWorkflowConfig('remote-mcp', testDir);

    expect(config).not.toBeNull();
    const testStep = config!.steps.find((s) => s.name === 'test');
    expect(testStep?.mcpServers).toEqual({
      'remote-api': {
        type: 'http',
        url: 'https://example.com/mcp',
      },
      'stream-api': {
        type: 'sse',
        url: 'https://example.com/sse',
      },
    });
  });

  it('should allow stdio mcp_servers only when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_mcp_servers:\n  stdio: true\n');

    writeFileSync(join(workflowsDir, 'with-mcp.yaml'), `
name: with-mcp
description: Workflow with MCP servers
max_steps: 5
initial_step: e2e-test

steps:
  - name: e2e-test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run E2E tests"
`);

    const config = loadWorkflowConfig('with-mcp', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps.find((s) => s.name === 'e2e-test')?.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
    });
  });

  it('should deny transport when project config explicitly overrides global true with false', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowMcpServers: { stdio: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_mcp_servers:\n  stdio: false\n');

    writeFileSync(join(workflowsDir, 'denied-mcp.yaml'), `
name: denied-mcp
description: Workflow with stdio MCP denied by project
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    expect(() => loadWorkflowConfig('denied-mcp', testDir)).toThrow(/workflow_mcp_servers/);
  });

  it('should preserve globally allowed transports when project config enables another transport', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowMcpServers: { stdio: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_mcp_servers:\n  sse: true\n');

    writeFileSync(join(workflowsDir, 'mixed-mcp.yaml'), `
name: mixed-mcp
description: Workflow with stdio and sse MCP servers
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
      stream-api:
        type: sse
        url: https://example.com/sse
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    const config = loadWorkflowConfig('mixed-mcp', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps.find((s) => s.name === 'test')?.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
      'stream-api': {
        type: 'sse',
        url: 'https://example.com/sse',
      },
    });
  });
});

describe('Workflow Loader IT: workflow runtime.prepare policy', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects workflow runtime.prepare custom scripts by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    expect(() => loadWorkflowConfig('runtime-custom', testDir)).toThrow(/workflow_runtime_prepare\.custom_scripts/);
  });

  it('allows workflow runtime.prepare gradle preset by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'runtime-gradle.yaml'), `
name: runtime-gradle
workflow_config:
  runtime:
    prepare:
      - gradle
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-gradle', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['gradle'] });
  });

  it('allows workflow runtime.prepare node preset by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'runtime-node.yaml'), `
name: runtime-node
workflow_config:
  runtime:
    prepare:
      - node
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-node', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['node'] });
  });

  it('allows workflow runtime.prepare custom scripts when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_runtime_prepare:\n  custom_scripts: true\n');
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });

  it('rejects workflow runtime.prepare custom scripts when global allows and project explicitly denies', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowRuntimePrepare: { customScripts: true },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      'workflow_runtime_prepare:\n  custom_scripts: false\n',
    );
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    expect(() => loadWorkflowConfig('runtime-custom', testDir)).toThrow(/workflow_runtime_prepare\.custom_scripts/);
  });

  it('allows workflow runtime.prepare custom scripts when global denies and project explicitly allows', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowRuntimePrepare: { customScripts: false },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      'workflow_runtime_prepare:\n  custom_scripts: true\n',
    );
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });

  it('preserves globally allowed runtime.prepare custom scripts when project config sets the policy block', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowRuntimePrepare: { customScripts: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_runtime_prepare: {}\n');
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });
});

describe('Workflow Loader IT: workflow Arpeggio policy', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects custom Arpeggio capabilities by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(testDir, 'rows.csv'), 'value\nhello\n');
    writeFileSync(join(testDir, 'prompt.md'), 'Summarize {{rows}}');

    writeFileSync(join(workflowsDir, 'arpeggio-custom.yaml'), `
name: arpeggio-custom
steps:
  - name: summarize
    instruction: "unused"
    arpeggio:
      source: csv
      source_path: ../../rows.csv
      template: ../../prompt.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(\"\\n\");'
`);

    expect(() => loadWorkflowConfig('arpeggio-custom', testDir)).toThrow(/workflow_arpeggio\.custom_merge_inline_js/);
  });

  it('allows custom Arpeggio capabilities when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      [
        'workflow_arpeggio:',
        '  custom_data_source_modules: true',
        '  custom_merge_inline_js: true',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(testDir, 'rows.csv'), 'value\nhello\n');
    writeFileSync(join(testDir, 'prompt.md'), 'Summarize {{rows}}');

    writeFileSync(join(workflowsDir, 'arpeggio-custom.yaml'), `
name: arpeggio-custom
steps:
  - name: summarize
    instruction: "unused"
    arpeggio:
      source: custom-source
      source_path: ../../rows.csv
      template: ../../prompt.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(\"\\n\");'
`);

    const config = loadWorkflowConfig('arpeggio-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps[0]?.arpeggio?.source).toBe('custom-source');
    expect(config!.steps[0]?.arpeggio?.merge.inlineJs).toContain('join');
  });

  it('preserves globally allowed Arpeggio capabilities when project config enables another one', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowArpeggio: { customDataSourceModules: true },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      ['workflow_arpeggio:', '  custom_merge_inline_js: true'].join('\n'),
      'utf-8',
    );
    writeFileSync(join(testDir, 'rows.csv'), 'value\nhello\n');
    writeFileSync(join(testDir, 'prompt.md'), 'Summarize {{rows}}');

    writeFileSync(join(workflowsDir, 'arpeggio-precedence.yaml'), `
name: arpeggio-precedence
steps:
  - name: summarize
    instruction: "unused"
    arpeggio:
      source: custom-source
      source_path: ../../rows.csv
      template: ../../prompt.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(\"\\n\");'
`);

    const config = loadWorkflowConfig('arpeggio-precedence', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps[0]?.arpeggio?.source).toBe('custom-source');
    expect(config!.steps[0]?.arpeggio?.merge.inlineJs).toContain('join');
  });
});
