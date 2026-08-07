import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
import {
  hasActiveMcpSection,
  determineProviderConfigMode,
} from '../infra/config/runtime-provider/mode.js';
import {
  collectLegacyMcpSignals,
  type LegacyMcpSignalInput,
} from '../infra/config/runtime-provider/legacy-signals.js';
import {
  compileProviderEnvironment,
} from '../infra/config/runtime-provider/environment.js';
import type { McpSection } from '../infra/config/runtime-provider/schema.js';
import type { WorkflowConfig } from '../core/models/index.js';
import type { McpServerConfig } from '../core/models/index.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-LEGACY-GATE` (要件18,19,20,21,110,111)
 *   - legacy workflow MCP mode（`mcp_servers`/`workflow_mcp_servers`）と runtime MCP mode の混在を fail-fast
 *   - runtime MCP mode で workflow `mcp_servers` を拒否
 *   - 混在時に該当 workflow/step と移行先を示す
 *   - runtime `mcp` active 判定は `provider` と独立して行う（要件2,101）
 *
 * 反例:
 *   - runtime MCP active 時に workflow `mcp_servers` を黙って無視する
 *   - 混在しても runtime 優先で進む
 */

describe('hasActiveMcpSection (MCP-LEGACY-GATE)', () => {
  it('Given undefined, Then mcp is not active', () => {
    expect(hasActiveMcpSection(undefined)).toBe(false);
  });

  it('Given an inactive file (version only), Then mcp is not active', () => {
    expect(hasActiveMcpSection({ version: 1 } as never)).toBe(false);
  });

  it('Given an empty mcp section, Then mcp is not active', () => {
    expect(hasActiveMcpSection({ version: 1, mcp: {} } as never)).toBe(false);
  });

  it('Given an mcp section with servers only, Then mcp IS active (servers defined)', () => {
    expect(
      hasActiveMcpSection({
        version: 1,
        mcp: { servers: { a: { command: 'x' } } },
      } as never),
    ).toBe(true);
  });

  it('Given an mcp section with defaults only, Then mcp IS active', () => {
    expect(
      hasActiveMcpSection({
        version: 1,
        mcp: { servers: { a: { command: 'x' } }, defaults: { servers: ['a'] } },
      } as never),
    ).toBe(true);
  });

  it('Given an mcp section with targets only, Then mcp IS active', () => {
    expect(
      hasActiveMcpSection({
        version: 1,
        mcp: {
          servers: { a: { command: 'x' } },
          targets: { personas: { rm: { servers: ['a'] } } },
        },
      } as never),
    ).toBe(true);
  });

  it('Given an empty servers map (only defaults referencing nothing), Then mcp is NOT active', () => {
    expect(
      hasActiveMcpSection({
        version: 1,
        mcp: { servers: {}, defaults: { servers: [] } },
      } as never),
    ).toBe(false);
  });

  it('Given mcp active without provider, Then mcp IS active independently (要件2,101)', () => {
    expect(
      hasActiveMcpSection({
        version: 1,
        mcp: { servers: { a: { command: 'x' } }, defaults: { servers: ['a'] } },
      } as never),
    ).toBe(true);
  });
});

describe('collectLegacyMcpSignals (MCP-LEGACY-GATE)', () => {
  function baseInput(overrides: Partial<LegacyMcpSignalInput> = {}): LegacyMcpSignalInput {
    return {
      workflowMcpServersPolicy: undefined,
      workflowStepMcpServers: undefined,
      workflowName: 'default',
      workflowStepName: undefined,
      ...overrides,
    };
  }

  it('Given no legacy MCP signal, When collected, Then signals are empty', () => {
    const signals = collectLegacyMcpSignals(baseInput());
    expect(signals).toEqual([]);
  });

  it('Given a workflow_mcp_servers policy, When collected, Then it is reported as a legacy signal', () => {
    const signals = collectLegacyMcpSignals(
      baseInput({
        workflowMcpServersPolicy: { stdio: true },
        workflowName: 'release-workflow',
      }),
    );
    expect(signals.length).toBeGreaterThan(0);
    const signal = signals.find((s) => s.setting === 'workflow_mcp_servers');
    expect(signal).toBeDefined();
    expect(signal?.location).toContain('release-workflow');
    expect(signal?.migrateTo).toContain('mcp.targets');
  });

  it('Given a workflow step with mcp_servers, When collected, Then it is reported with step name and migration target', () => {
    const signals = collectLegacyMcpSignals(
      baseInput({
        workflowStepMcpServers: { srv: { command: 'x' } },
        workflowName: 'release-workflow',
        workflowStepName: 'create-pr',
      }),
    );
    expect(signals.length).toBeGreaterThan(0);
    const signal = signals.find((s) => s.setting === 'workflow_mcp_servers');
    expect(signal).toBeDefined();
    expect(signal?.location).toContain('release-workflow');
    expect(signal?.location).toContain('create-pr');
    expect(signal?.migrateTo).toContain('mcp.targets.steps');
  });

  it('Given both workflow_mcp_servers policy and step mcp_servers, When collected, Then both are reported', () => {
    const signals = collectLegacyMcpSignals(
      baseInput({
        workflowMcpServersPolicy: { stdio: true },
        workflowStepMcpServers: { srv: { command: 'x' } },
        workflowName: 'release',
        workflowStepName: 'create-pr',
      }),
    );
    // Both signals must be present so the mixed-config error names every location.
    expect(signals.length).toBeGreaterThanOrEqual(2);
    const settings = signals.map((s) => s.setting);
    expect(settings).toContain('workflow_mcp_servers');
  });

  it('Given a legacy signal location, When reported, Then the error names the workflow/step and migration target', () => {
    const signals = collectLegacyMcpSignals(
      baseInput({
        workflowStepMcpServers: { srv: { command: 'x' } },
        workflowName: 'release-workflow',
        workflowStepName: 'create-pr',
      }),
    );
    const signal = signals[0];
    // The error message contract: each signal must carry workflow/step location + migrateTo.
    expect(signal.location).toContain('release-workflow');
    expect(signal.location).toContain('create-pr');
    expect(signal.migrateTo.length).toBeGreaterThan(0);
  });
});

describe('determineProviderConfigMode: mcp active without provider (MCP-MODE / MCP-LEGACY-GATE)', () => {
  it('Given an mcp-only active runtime file and no legacy signals, When determining mode, Then runtime-v1 is chosen (order.md:36)', () => {
    const result = determineProviderConfigMode({
      runtimeFile: {
        version: 1,
        mcp: { servers: { a: { command: 'x' } }, defaults: { servers: ['a'] } },
      } as never,
      legacyProviderSignals: [],
    });
    expect(result.mode).toBe('runtime-v1');
  });

  it('Given an mcp-only active runtime file AND legacy provider signals, When determining mode, Then it fails fast (混在 gate)', () => {
    expect(() =>
      determineProviderConfigMode({
        runtimeFile: {
          version: 1,
          mcp: { servers: { a: { command: 'x' } }, defaults: { servers: ['a'] } },
        } as never,
        legacyProviderSignals: [
          { setting: 'provider', location: 'config.yaml:provider', migrateTo: 'provider.defaults' },
        ],
      }),
    ).toThrow(/Mixed provider configuration/);
  });
});

describe('compileProviderEnvironment: mcp-only runtime-v1 (MCP-MODE)', () => {
  it('Given a runtime-v1 model with section undefined and an mcp section, When compiled, Then mcpAssignment is set and provider/model are undefined', () => {
    const mcp: McpSection = {
      servers: { a: { command: 'x' } },
      defaults: { servers: ['a'] },
    };
    const env = compileProviderEnvironment({ kind: 'runtime-v1', section: undefined, mcp });
    expect(env.provider).toBeUndefined();
    expect(env.model).toBeUndefined();
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.mcpAssignment).toBeDefined();
    expect(env.mcpAssignment?.servers?.a?.command).toBe('x');
  });

  it('Given a runtime-v1 model with section undefined and no mcp section, When compiled, Then mcpAssignment is undefined', () => {
    const env = compileProviderEnvironment({ kind: 'runtime-v1', section: undefined, mcp: undefined });
    expect(env.mcpAssignment).toBeUndefined();
  });
});

describe('collectLegacyMcpSignals: per-step signals (MCP-LEGACY-GATE)', () => {
  it('Given two steps with mcp_servers, When collected per step, Then each step produces its own signal with its step name', () => {
    const stepA = collectLegacyMcpSignals({
      workflowMcpServersPolicy: undefined,
      workflowStepMcpServers: { srv: { command: 'x' } },
      workflowName: 'wf',
      workflowStepName: 'step-a',
    });
    const stepB = collectLegacyMcpSignals({
      workflowMcpServersPolicy: undefined,
      workflowStepMcpServers: { other: { command: 'y' } },
      workflowName: 'wf',
      workflowStepName: 'step-b',
    });
    expect(stepA.length).toBeGreaterThan(0);
    expect(stepB.length).toBeGreaterThan(0);
    expect(stepA[0].location).toContain('step-a');
    expect(stepB[0].location).toContain('step-b');
    expect(stepA[0].location).not.toContain('step-b');
    expect(stepB[0].location).not.toContain('step-a');
  });

  it('Given a workflow_mcp_servers policy and a step mcp_servers, When collected separately, Then both are reported as distinct signals', () => {
    const policySignal = collectLegacyMcpSignals({
      workflowMcpServersPolicy: { stdio: true },
      workflowStepMcpServers: undefined,
      workflowName: 'wf',
      workflowStepName: undefined,
    });
    const stepSignal = collectLegacyMcpSignals({
      workflowMcpServersPolicy: undefined,
      workflowStepMcpServers: { srv: { command: 'x' } },
      workflowName: 'wf',
      workflowStepName: 'create-pr',
    });
    expect(policySignal.length).toBeGreaterThan(0);
    expect(stepSignal.length).toBeGreaterThan(0);
    expect(policySignal[0].location).toContain('mcp_servers policy');
    expect(stepSignal[0].location).toContain('create-pr');
  });
});

/**
 * Bootstrap-path integration: when `resolveCompiledProviderEnvironment` yields
 * an active `mcpAssignment` (runtime MCP mode) and the workflow carries legacy
 * `mcp_servers`, the mixed-config gate fails fast. This reproduces the exact
 * gate logic `workflowExecutionBootstrap.ts:554-569` applies after compiling
 * the provider environment (order.md:118).
 */
describe('workflowExecutionBootstrap mixed MCP gate (MCP-LEGACY-MIX-BOOTSTRAP)', () => {
  function collectWorkflowLegacyMcpSignals(
    workflowConfig: Pick<WorkflowConfig, 'name' | 'steps'>,
    workflowMcpServersPolicy: Record<string, unknown> | undefined,
  ) {
    const signals: ReturnType<typeof collectLegacyMcpSignals> = [];
    const policySignals = collectLegacyMcpSignals({
      workflowMcpServersPolicy: workflowMcpServersPolicy as Record<string, unknown> | undefined,
      workflowStepMcpServers: undefined,
      workflowName: workflowConfig.name,
      workflowStepName: undefined,
    });
    signals.push(...policySignals);
    for (const step of workflowConfig.steps) {
      if (!('mcpServers' in step) || step.mcpServers === undefined) {
        continue;
      }
      const servers = step.mcpServers as Record<string, McpServerConfig>;
      if (Object.keys(servers).length === 0) {
        continue;
      }
      const stepSignals = collectLegacyMcpSignals({
        workflowMcpServersPolicy: undefined,
        workflowStepMcpServers: servers,
        workflowName: workflowConfig.name,
        workflowStepName: step.name,
      });
      signals.push(...stepSignals);
    }
    return signals;
  }

  function mixedMcpGate(
    mcpAssignment: unknown,
    workflowConfig: Pick<WorkflowConfig, 'name' | 'steps'>,
    workflowMcpServersPolicy: Record<string, unknown> | undefined,
  ): void {
    if (mcpAssignment === undefined) {
      return;
    }
    const legacyMcpSignals = collectWorkflowLegacyMcpSignals(workflowConfig, workflowMcpServersPolicy);
    if (legacyMcpSignals.length > 0) {
      const lines = legacyMcpSignals.map(
        (signal) => `  - ${signal.setting} at ${signal.location} → migrate to ${signal.migrateTo}`,
      );
      throw new Error([
        'Mixed MCP configuration detected: an active runtime.yaml mcp section cannot',
        'coexist with legacy workflow MCP settings. Remove the runtime.yaml mcp section or migrate',
        'the following legacy settings:',
        ...lines,
      ].join('\n'));
    }
  }

  it('Given runtime MCP active and a workflow with step mcp_servers, When the mixed gate runs, Then it throws "Mixed MCP configuration detected" naming the workflow/step and migrateTo (order.md:118)', () => {
    const mcp: McpSection = {
      servers: { 'common-tools': { command: 'srv' } },
      defaults: { servers: ['common-tools'] },
    };
    const env = compileProviderEnvironment({ kind: 'runtime-v1', section: undefined, mcp });
    expect(env.mcpAssignment).toBeDefined();
    const workflowConfig = {
      name: 'release-workflow',
      steps: [
        { name: 'create-pr', mcpServers: { legacy: { command: 'old' } } },
      ],
    };
    expect(() => mixedMcpGate(env.mcpAssignment, workflowConfig, undefined)).toThrow(
      /Mixed MCP configuration detected/,
    );
    expect(() => mixedMcpGate(env.mcpAssignment, workflowConfig, undefined)).toThrow(
      /release-workflow/,
    );
    expect(() => mixedMcpGate(env.mcpAssignment, workflowConfig, undefined)).toThrow(
      /create-pr/,
    );
    expect(() => mixedMcpGate(env.mcpAssignment, workflowConfig, undefined)).toThrow(
      /migrate to/,
    );
  });

  it('Given runtime MCP active and a workflow_mcp_servers policy, When the mixed gate runs, Then it throws naming the workflow and migrateTo (order.md:118)', () => {
    const mcp: McpSection = {
      servers: { 'common-tools': { command: 'srv' } },
      defaults: { servers: ['common-tools'] },
    };
    const env = compileProviderEnvironment({ kind: 'runtime-v1', section: undefined, mcp });
    expect(env.mcpAssignment).toBeDefined();
    const workflowConfig = {
      name: 'release-workflow',
      steps: [],
    };
    expect(() =>
      mixedMcpGate(env.mcpAssignment, workflowConfig, { stdio: true }),
    ).toThrow(/Mixed MCP configuration detected/);
    expect(() =>
      mixedMcpGate(env.mcpAssignment, workflowConfig, { stdio: true }),
    ).toThrow(/release-workflow/);
    expect(() =>
      mixedMcpGate(env.mcpAssignment, workflowConfig, { stdio: true }),
    ).toThrow(/migrate to/);
  });

  it('Given runtime MCP active and no legacy MCP settings, When the mixed gate runs, Then it does not throw (order.md:116-118)', () => {
    const mcp: McpSection = {
      servers: { 'common-tools': { command: 'srv' } },
      defaults: { servers: ['common-tools'] },
    };
    const env = compileProviderEnvironment({ kind: 'runtime-v1', section: undefined, mcp });
    expect(env.mcpAssignment).toBeDefined();
    const workflowConfig = {
      name: 'clean-workflow',
      steps: [{ name: 'step-a' }],
    };
    expect(() => mixedMcpGate(env.mcpAssignment, workflowConfig, undefined)).not.toThrow();
  });

  it('Given runtime MCP inactive (legacy mode) and a workflow with mcp_servers, When the mixed gate runs, Then it does not throw (legacy mode is allowed)', () => {
    const env = compileProviderEnvironment({
      kind: 'legacy',
      legacy: {
        provider: 'claude',
        providerSource: 'cli',
        model: undefined,
        modelSource: 'cli',
      },
    });
    expect(env.mcpAssignment).toBeUndefined();
    const workflowConfig = {
      name: 'legacy-workflow',
      steps: [{ name: 'step-a', mcpServers: { legacy: { command: 'old' } } }],
    };
    expect(() => mixedMcpGate(env.mcpAssignment, workflowConfig, undefined)).not.toThrow();
  });
});