import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
import {
  resolveMcpAssignment,
  type McpAssignmentSection,
  type AgentExecutionContext,
} from '../infra/config/runtime-provider/mcp-assignment.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-RESOLVE` (要件4-11,103-106)
 *   - effective servers = defaults.servers + matched targets.servers − matched targets.exclude
 *   - server 名は重複除去する
 *   - exclude は addition より優先する
 *   - target に未知の server 名が含まれる場合は fail-fast する
 *   - `mcp.servers` に定義しただけでは有効化しない
 *   - 4種 target（personas/tags/steps/internal_agents）
 *   - step は `<leaf-workflow-name>/<step-name>` 完全修飾名
 *   - `workflow_call` 制御ノードは step target 対象外
 *   - internal_agents target は `selector` 共通 exclude のみ適用
 *
 * 反例:
 *   - exclude を addition より後で処理 → exclude が負ける
 *   - 未知 server を無視 → fail-fast しない
 *   - 中間 workflow 名を使う → leaf workflow 名にならない
 *   - `workflow_call` step を対象にする → 除外すべき
 *   - `mcp.servers` に定義しただけで有効化する → defaults/targets への割当てが必要
 */

function baseServers(): McpAssignmentSection['servers'] {
  return {
    common: { type: 'stdio', command: 'common-srv' },
    github: { type: 'http', url: 'https://api.github.com/mcp/' },
    legacy: { type: 'sse', url: 'http://legacy.local/sse' },
  };
}

function baseContext(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    persona: 'coder',
    tags: [],
    stepQualifiedName: 'default/plan',
    isWorkflowCallNode: false,
    isInternalAgent: false,
    ...overrides,
  };
}

describe('resolveMcpAssignment — target resolution (MCP-RESOLVE)', () => {
  it('Given defaults only, When resolved, Then effective servers are defaults.servers', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
    };
    const result = resolveMcpAssignment(section, baseContext());
    expect(result.serverNames).toEqual(['common']);
  });

  it('Given defaults + matched persona target, When resolved, Then union is effective', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { personas: { 'release-manager': { servers: ['github'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ persona: 'release-manager' }));
    expect(result.serverNames.sort()).toEqual(['common', 'github']);
  });

  it('Given defaults + matched tag target, When resolved, Then union is effective', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { tags: { github: { servers: ['github'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ tags: ['github'] }));
    expect(result.serverNames.sort()).toEqual(['common', 'github']);
  });

  it('Given defaults + matched step target (fully-qualified name), When resolved, Then union is effective', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { steps: { 'release/create-pr': { servers: ['github'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ stepQualifiedName: 'release/create-pr' }));
    expect(result.serverNames.sort()).toEqual(['common', 'github']);
  });

  it('Given a step target with a non-matching name, When resolved, Then the step target is not applied', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { steps: { 'release/create-pr': { servers: ['github'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ stepQualifiedName: 'release/other-step' }));
    expect(result.serverNames).toEqual(['common']);
  });

  it('Given a step target using a leaf-workflow-qualified name, When resolved, Then only the leaf name matches', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { steps: { 'release/create-pr': { servers: ['github'] } } },
    };
    // Intermediate workflow name must not match; only the fully-qualified leaf name.
    const result = resolveMcpAssignment(section, baseContext({ stepQualifiedName: 'parent/release/create-pr' }));
    expect(result.serverNames).toEqual(['common']);
  });

  it('Given a workflow_call node, When resolved, Then step targets do not apply (要件106)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { steps: { 'release/create-pr': { servers: ['github'] } } },
    };
    const result = resolveMcpAssignment(
      section,
      baseContext({ stepQualifiedName: 'release/create-pr', isWorkflowCallNode: true }),
    );
    expect(result.serverNames).toEqual(['common']);
  });

  it('Given exclude on persona target, When resolved, Then exclude wins over addition (要件11)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: {
        personas: { coder: { servers: ['github'], exclude: ['common'] } },
      },
    };
    const result = resolveMcpAssignment(section, baseContext({ persona: 'coder' }));
    // exclude removes common even though it is in defaults.
    expect(result.serverNames).toEqual(['github']);
  });

  it('Given exclude on tag target, When resolved, Then exclude wins over addition', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common', 'github'] },
      targets: { tags: { redact: { exclude: ['common'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ tags: ['redact'] }));
    expect(result.serverNames.sort()).toEqual(['github']);
  });

  it('Given exclude on step target, When resolved, Then exclude wins over addition', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common', 'github'] },
      targets: { steps: { 'release/create-pr': { exclude: ['common'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ stepQualifiedName: 'release/create-pr' }));
    expect(result.serverNames.sort()).toEqual(['github']);
  });

  it('Given duplicate server names, When resolved, Then duplicates are removed (要件10)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common', 'common'] },
      targets: { personas: { coder: { servers: ['common'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ persona: 'coder' }));
    expect(result.serverNames).toEqual(['common']);
  });

  it('Given a target referencing an unknown server, When resolved, Then it fails fast (要件12)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { personas: { coder: { servers: ['nonexistent'] } } },
    };
    expect(() => resolveMcpAssignment(section, baseContext({ persona: 'coder' }))).toThrow(/nonexistent/);
  });

  it('Given defaults referencing an unknown server, When resolved, Then it fails fast (要件12)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['unknown'] },
    };
    expect(() => resolveMcpAssignment(section, baseContext())).toThrow(/unknown/);
  });

  it('Given an exclude referencing an unknown server, When resolved, Then it fails fast (要件12)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { personas: { coder: { exclude: ['unknown'] } } },
    };
    expect(() => resolveMcpAssignment(section, baseContext({ persona: 'coder' }))).toThrow(/unknown/);
  });

  it('Given servers defined but not assigned, When resolved, Then they are NOT enabled (要件13)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      // no defaults, no matching targets
    };
    const result = resolveMcpAssignment(section, baseContext({ persona: 'nobody' }));
    expect(result.serverNames).toEqual([]);
  });

  it('Given empty server set, When resolved, Then it is MCP-disabled (要件29)', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: [] },
    };
    const result = resolveMcpAssignment(section, baseContext());
    expect(result.serverNames).toEqual([]);
    expect(result.enabled).toBe(false);
  });

  it('Given internal_agents.selector.exclude, When resolving an internal agent, Then the common exclude applies', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { internal_agents: { selector: { exclude: ['common'] } } },
    };
    const result = resolveMcpAssignment(
      section,
      baseContext({ isInternalAgent: true }),
    );
    expect(result.serverNames).toEqual([]);
  });

  it('Given internal_agents.selector.exclude, When resolving a normal agent, Then the exclude does NOT apply', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: { internal_agents: { selector: { exclude: ['common'] } } },
    };
    const result = resolveMcpAssignment(section, baseContext({ isInternalAgent: false }));
    expect(result.serverNames).toEqual(['common']);
  });

  it('Given multiple matching targets (persona + tag + step), When resolved, Then all additions and excludes are applied', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
      defaults: { servers: ['common'] },
      targets: {
        personas: { coder: { servers: ['github'] } },
        tags: { legacy: { servers: ['legacy'] } },
        steps: { 'default/plan': { exclude: ['common'] } },
      },
    };
    const result = resolveMcpAssignment(
      section,
      baseContext({ persona: 'coder', tags: ['legacy'], stepQualifiedName: 'default/plan' }),
    );
    // additions: github + legacy ; exclude: common (step target)
    expect(result.serverNames.sort()).toEqual(['github', 'legacy']);
  });

  it('Given no defaults and no matching target, When resolved, Then the result is MCP-disabled', () => {
    const section: McpAssignmentSection = {
      servers: baseServers(),
    };
    const result = resolveMcpAssignment(section, baseContext({ persona: 'nobody' }));
    expect(result.serverNames).toEqual([]);
    expect(result.enabled).toBe(false);
  });
});