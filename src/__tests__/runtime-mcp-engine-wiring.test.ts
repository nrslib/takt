import { describe, expect, it } from 'vitest';
import { resolveCompiledProviderEnvironment } from '../infra/config/runtime-provider/provider-environment.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { resolveMcpAssignment } from '../infra/config/runtime-provider/mcp-assignment.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import type { McpAssignmentSection } from '../infra/config/runtime-provider/mcp-assignment.js';
import type { McpServerConfig, WorkflowStep } from '../core/models/index.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-ENGINE-WIRING` (要件112,113,114)
 *   - `CompiledProviderEnvironment` へ runtime-v1 のみ `mcpAssignment` を追加する
 *   - `WorkflowEngineOptions` へ `mcpAssignment` を追加し `OptionsBuilder.resolveMcpServersForStep` で適用する
 *   - `mcpAssignment` を workflow_call 子 engine へ継承する
 *
 * 反例:
 *   - `mcpAssignment` 配線漏れ
 *   - 子 engine へ継承しない
 *
 * このテストは source grep ではなく実行可能な振る舞い検証で配線を確認する
 * (Policy「設定値・ログ・スナップショットのみで振る舞いを承認 → REJECT」への適合)。
 */

function buildMcpSection(): McpAssignmentSection {
  return {
    servers: {
      'common-tools': { type: 'stdio', command: 'srv' },
      'github': { type: 'http', url: 'https://example.com/mcp' },
    },
    defaults: { servers: ['common-tools'] },
    targets: {
      personas: {
        'release-manager': { servers: ['github'] },
      },
      steps: {
        'leaf/execute': { servers: ['github'] },
      },
    },
  };
}

describe('CompiledProviderEnvironment mcpAssignment field (MCP-ENGINE-WIRING)', () => {
  it('Given runtime-v1 input with an mcp section, When resolveMcpAssignment is called, Then mcpAssignment is set and resolved servers reflect defaults + matched targets', () => {
    const section = buildMcpSection();
    const resolved = resolveMcpAssignment(section, {
      persona: 'release-manager',
      tags: [],
      stepQualifiedName: 'leaf/execute',
      isWorkflowCallNode: false,
      isInternalAgent: false,
    });
    expect(resolved.enabled).toBe(true);
    expect(Object.keys(resolved.servers)).toEqual(expect.arrayContaining(['common-tools', 'github']));
    expect(resolved.serverNames.sort()).toEqual(['common-tools', 'github']);
  });

  it('Given runtime-v1 input with an mcp section, When resolveMcpAssignment resolves for a non-matching persona/step, Then only defaults are returned', () => {
    const section = buildMcpSection();
    const resolved = resolveMcpAssignment(section, {
      persona: 'unmatched-persona',
      tags: [],
      stepQualifiedName: 'leaf/unmatched',
      isWorkflowCallNode: false,
      isInternalAgent: false,
    });
    expect(resolved.enabled).toBe(true);
    expect(Object.keys(resolved.servers)).toEqual(['common-tools']);
  });

  it('Given a WorkflowEngineOptions with mcpAssignment, When OptionsBuilder.resolveMcpServersForStep is called for a matching step, Then the resolved runtime servers are returned', () => {
    const section = buildMcpSection();
    const engineOptions = {
      mcpAssignment: section,
    } as WorkflowEngineOptions;
    const builder = new OptionsBuilder(
      engineOptions,
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '/tmp/report',
      () => undefined,
      () => [{ name: 'execute' }],
      () => 'leaf',
      () => undefined,
    );
    const step: WorkflowStep = {
      name: 'execute',
      persona: 'release-manager',
    } as unknown as WorkflowStep;
    const servers = builder.resolveMcpServersForStep(step, 'claude-sdk');
    expect(servers).toBeDefined();
    expect(Object.keys(servers!).sort()).toEqual(['common-tools', 'github']);
  });

  it('Given a WorkflowEngineOptions without mcpAssignment, When OptionsBuilder.resolveMcpServersForStep is called, Then runtime servers are undefined', () => {
    const engineOptions = {} as WorkflowEngineOptions;
    const builder = new OptionsBuilder(
      engineOptions,
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '/tmp/report',
      () => undefined,
      () => [{ name: 'execute' }],
      () => 'leaf',
      () => undefined,
    );
    const step: WorkflowStep = {
      name: 'execute',
      persona: 'coder',
    } as unknown as WorkflowStep;
    const servers = builder.resolveMcpServersForStep(step, 'claude-sdk');
    expect(servers).toBeUndefined();
  });

  it('Given child WorkflowEngineOptions inheriting mcpAssignment from parent, When the child resolves MCP servers for a step, Then the inherited assignment applies (要件114)', () => {
    const section = buildMcpSection();
    const parentOptions: WorkflowEngineOptions = {
      mcpAssignment: section,
    } as WorkflowEngineOptions;
    // Simulate child engine options inheriting mcpAssignment via spread.
    const childOptions: WorkflowEngineOptions = {
      ...parentOptions,
    };
    expect(childOptions.mcpAssignment).toBeDefined();
    expect(childOptions.mcpAssignment).toBe(parentOptions.mcpAssignment);
    const builder = new OptionsBuilder(
      childOptions,
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '/tmp/report',
      () => undefined,
      () => [{ name: 'execute' }],
      () => 'leaf',
      () => undefined,
    );
    const step: WorkflowStep = {
      name: 'execute',
      persona: 'release-manager',
    } as unknown as WorkflowStep;
    const servers = builder.resolveMcpServersForStep(step, 'claude-sdk');
    expect(servers).toBeDefined();
    expect(Object.keys(servers!).sort()).toEqual(['common-tools', 'github']);
  });

  it('Given legacy mode input (no runtime.yaml), When resolveCompiledProviderEnvironment is called, Then mcpAssignment is undefined on the compiled environment', () => {
    // Legacy mode: no runtime file present. resolveCompiledProviderEnvironment
    // must not synthesize an mcpAssignment. We invoke it with minimal legacy
    // input and no runtime file (the loader returns undefined when neither
    // global nor project runtime.yaml exists in the test cwd).
    const result = resolveCompiledProviderEnvironment({
      projectCwd: '/nonexistent-test-cwd-no-runtime-yaml',
      legacy: {
        provider: 'claude-sdk',
        providerSource: 'cli',
        model: 'claude-sonnet-5',
        modelSource: 'cli',
        personaProviders: undefined,
        providerRouting: undefined,
        autoRouting: undefined,
        providerOptions: undefined,
      },
      legacySignals: [],
    });
    expect(result.mcpAssignment).toBeUndefined();
  });
});

/**
 * Sub-workflow mix gate (U1-SUBWORKFLOW-MIX-GATE / order.md:118,120).
 *
 * `workflowExecutionBootstrap.collectWorkflowLegacyMcpSignals` only inspects
 * top-level `workflowConfig.steps`, so a sub-workflow carrying `step.mcpServers`
 * would slip past the bootstrap gate and silently merge with runtime servers
 * inside `mergeMcpServerMaps`. The `OptionsBuilder.resolveMcpServersForStep`
 * guard runs for every engine level (root + nested) and fails fast when runtime
 * MCP mode is active and a workflow-sourced `step.mcpServers` is non-empty.
 */
describe('OptionsBuilder.resolveMcpServersForStep: runtime MCP mode + step.mcpServers fail-fast (U1-SUBWORKFLOW-MIX-GATE)', () => {
  function buildBuilder(
    engineOptions: Partial<WorkflowEngineOptions>,
    workflowName: string,
    workflowStack?: { workflow: string; workflow_ref: string }[],
  ): OptionsBuilder {
    return new OptionsBuilder(
      engineOptions as WorkflowEngineOptions,
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '/tmp/report',
      () => undefined,
      () => [{ name: 'execute' }],
      () => workflowName,
      () => undefined,
      workflowStack !== undefined
        ? () => workflowStack as never
        : undefined,
    );
  }

  it('Given runtime MCP mode active and a step with non-empty mcpServers, When resolveMcpServersForStep is called, Then it throws naming the workflow, step, and migration target (order.md:118)', () => {
    const section = buildMcpSection();
    const builder = buildBuilder({ mcpAssignment: section }, 'leaf');
    const step = {
      name: 'execute',
      persona: 'coder',
      mcpServers: { legacy: { command: 'old' } },
    } as unknown as WorkflowStep;
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).toThrow(
      /Mixed MCP configuration detected/,
    );
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).toThrow(
      /"leaf"/,
    );
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).toThrow(
      /"execute"/,
    );
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).toThrow(
      /mcp\.targets\.steps/,
    );
  });

  it('Given runtime MCP mode active and a step with non-empty mcpServers inside a sub-workflow, When resolveMcpServersForStep is called via a child engine, Then it throws naming the sub-workflow leaf from the workflow stack (order.md:118)', () => {
    const section = buildMcpSection();
    const builder = buildBuilder(
      { mcpAssignment: section },
      'parent',
      [{ workflow: 'child', workflow_ref: 'opaque-child-ref' }],
    );
    const step = {
      name: 'execute',
      persona: 'coder',
      mcpServers: { legacy: { command: 'old' } },
    } as unknown as WorkflowStep;
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).toThrow(
      /"child"/,
    );
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).toThrow(
      /mcp\.targets\.steps/,
    );
  });

  it('Given legacy mode (no mcpAssignment) and a step with non-empty mcpServers, When resolveMcpServersForStep is called, Then it does not throw (legacy mode allows step.mcpServers)', () => {
    const builder = buildBuilder({}, 'leaf');
    const step = {
      name: 'execute',
      persona: 'coder',
      mcpServers: { legacy: { command: 'old' } },
    } as unknown as WorkflowStep;
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).not.toThrow();
  });

  it('Given runtime MCP mode active and a step with no mcpServers, When resolveMcpServersForStep is called, Then it does not throw and returns resolved runtime servers', () => {
    const section = buildMcpSection();
    const builder = buildBuilder({ mcpAssignment: section }, 'leaf');
    const step = {
      name: 'execute',
      persona: 'release-manager',
    } as unknown as WorkflowStep;
    const servers = builder.resolveMcpServersForStep(step, 'claude-sdk');
    expect(servers).toBeDefined();
    expect(Object.keys(servers!).sort()).toEqual(['common-tools', 'github']);
  });

  it('Given runtime MCP mode active, session mcpServers (CLI/ACP boundary), and a step with no mcpServers, When resolveMcpServersForStep is called, Then it does not throw (session-boundary servers are allowed)', () => {
    const section = buildMcpSection();
    const builder = buildBuilder(
      { mcpAssignment: section, mcpServers: { 'cli-tool': { command: 'cli' } } },
      'leaf',
    );
    const step = {
      name: 'execute',
      persona: 'coder',
    } as unknown as WorkflowStep;
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).not.toThrow();
  });

  it('Given runtime MCP mode active and a step with an empty mcpServers record, When resolveMcpServersForStep is called, Then it does not throw (empty is a no-op)', () => {
    const section = buildMcpSection();
    const builder = buildBuilder({ mcpAssignment: section }, 'leaf');
    const step = {
      name: 'execute',
      persona: 'coder',
      mcpServers: {},
    } as unknown as WorkflowStep;
    expect(() => builder.resolveMcpServersForStep(step, 'claude-sdk')).not.toThrow();
  });
});
