import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import type { AgentWorkflowStep } from '../core/models/index.js';

/**
 * Issue #1208 Stage 1 — `capabilities:` reference resolution (the consumption side of CT-CAP-1).
 *
 * Contracts (plan.md 完了契約):
 * - CT-CAP-2 a `capabilities` reference resolves via the reused provider-options resolver; an
 *   unresolved name fails fast at load time (order.md:41,157).
 * - CT-CAP-3 through the `capabilities` path only capability leaves (allowed_tools / network_access /
 *   sandbox / skills) are permitted; a quality/machine leaf fails fast (order.md:61).
 * - CT-CAP-4 a step's `capabilities` REPLACES the workflow-level default — it does not merge
 *   (order.md:54).
 * - CT-CAP-5 direct `provider_options` is rejected at the workflow load boundary; capabilities
 *   remain the workflow YAML surface and runtime.yaml owns provider options.
 *
 * Path-like references resolve relative to the workflow directory (the resolver's existing path
 * form), which lets these load-time contracts be exercised without a full 4-layer lookup context.
 */

let tempDir: string;

function writeCapabilitySet(name: string, body: string): void {
  writeFileSync(join(tempDir, 'provider-options', `${name}.yaml`), body);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'takt-capabilities-resolution-'));
  mkdirSync(join(tempDir, 'provider-options'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function normalize(extra: Record<string, unknown>, steps: Array<Record<string, unknown>>) {
  return normalizeWorkflowConfig({ name: 'wf', ...extra, steps }, tempDir);
}

describe('CT-CAP-2 capabilities reference resolution', () => {
  it('should carry the capability options onto the step when the capability-set resolves', () => {
    writeCapabilitySet('backend', 'claude:\n  allowed_tools:\n    - Read\n    - Grep\n');
    const config = normalize({}, [
      { name: 'implement', instruction: '{task}', capabilities: 'provider-options/backend.yaml' },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.capabilityProviderOptions?.claude?.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('should fail fast when the capability-set name does not resolve', () => {
    expect(() => normalize({}, [
      { name: 'implement', instruction: '{task}', capabilities: 'provider-options/ghost.yaml' },
    ])).toThrow(/capabilities|not found/i);
  });
});

describe('CT-CAP-3 capability-set leaf purification', () => {
  it('should fail fast when a capability-set carries a non-capability leaf (claude.effort)', () => {
    writeCapabilitySet('quality', 'claude:\n  effort: high\n');
    expect(() => normalize({}, [
      { name: 'implement', instruction: '{task}', capabilities: 'provider-options/quality.yaml' },
    ])).toThrow(/capabilit|effort|capability leaf/i);
  });

  it('should reject Codex fast_mode from a capability-set', () => {
    writeCapabilitySet('fast-mode', 'codex:\n  fast_mode: true\n');
    expect(() => normalize({}, [
      { name: 'implement', instruction: '{task}', capabilities: 'provider-options/fast-mode.yaml' },
    ])).toThrow(/codex\.fastMode.*not a capability leaf|resolved to no capability options/);
  });

  it('should accept a capability-set when it carries only capability leaves', () => {
    writeCapabilitySet('caps', 'codex:\n  network_access: true\n  skills:\n    repo: true\n');
    expect(() => normalize({}, [
      { name: 'implement', instruction: '{task}', capabilities: 'provider-options/caps.yaml' },
    ])).not.toThrow();
  });
});

describe('CT-CAP-4 step capabilities replace the workflow default', () => {
  it('should replace and not merge the workflow default when a step overrides `capabilities`', () => {
    writeCapabilitySet('wide', 'claude:\n  allowed_tools:\n    - Read\n    - Grep\n    - Bash\n');
    writeCapabilitySet('narrow', 'claude:\n  allowed_tools:\n    - Read\n');
    const config = normalize({ capabilities: 'provider-options/wide.yaml' }, [
      { name: 'inherits', instruction: '{task}' },
      { name: 'overrides', instruction: '{task}', capabilities: 'provider-options/narrow.yaml' },
    ]);
    const inherits = config.steps[0] as AgentWorkflowStep;
    const overrides = config.steps[1] as AgentWorkflowStep;
    // The step without its own capabilities inherits the workflow default.
    expect(inherits.capabilityProviderOptions?.claude?.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
    // The overriding step replaces it entirely — Grep/Bash from the default must NOT leak in.
    expect(overrides.capabilityProviderOptions?.claude?.allowedTools).toEqual(['Read']);
  });
});

describe('CT-CAP-5 removed workflow provider options', () => {
  it('should reject direct provider_options even when a step declares capabilities', () => {
    writeCapabilitySet('caps-read-grep', 'claude:\n  allowed_tools:\n    - Read\n    - Grep\n');
    expect(() => normalize({}, [
      {
        name: 'coexist',
        instruction: '{task}',
        capabilities: 'provider-options/caps-read-grep.yaml',
        provider_options: { claude: { allowed_tools: ['Read', 'Bash'] } },
      },
    ])).toThrow(/runtime\.yaml/);
  });
});

describe('capabilities reach the engine provider-options layers', () => {
  // 検出済みの後退: capabilities は step.providerOptions にだけ畳み込まれ、エンジンが実際に
  // 読む layer 側に乗らず実行時 no-op になっていた。このテストは実行時経路そのものを固定する。
  it('should expose the resolved capability options on the runtime layer merge when a step declares capabilities', async () => {
    const { mergeStepProviderOptionsLayers, resolveStepCapabilityProviderOptions } = await import(
      '../infra/config/providerOptions.js'
    );
    writeCapabilitySet('runtime-check', 'claude:\n  allowed_tools:\n    - Read\nopencode:\n  network_access: true\n');
    const config = normalize({}, [
      { name: 'implement', instruction: '{task}', capabilities: 'provider-options/runtime-check.yaml' },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(resolveStepCapabilityProviderOptions(step)).toEqual({
      claude: { allowedTools: ['Read'] },
      opencode: { networkAccess: true },
    });
    expect(mergeStepProviderOptionsLayers(step, { providerRouting: undefined, personaProviders: undefined }))
      .toEqual({ claude: { allowedTools: ['Read'] }, opencode: { networkAccess: true } });
  });

  it('should reject the workflow provider_options layer instead of merging it', () => {
    writeCapabilitySet('base-tools', 'claude:\n  allowed_tools:\n    - Read\n');
    expect(() => normalize(
      { workflow_config: { provider_options: { claude: { allowed_tools: ['Read', 'Edit'] } } } },
      [{ name: 'implement', instruction: '{task}', capabilities: 'provider-options/base-tools.yaml' }],
    )).toThrow(/runtime\.yaml/);
  });
});

describe('capabilities accepts a list of set names', () => {
  it('should merge listed sets left to right onto the step when capabilities is a list', () => {
    writeCapabilitySet('tools', 'claude:\n  allowed_tools:\n    - Read\n');
    writeCapabilitySet('skills-grant', 'codex:\n  skills:\n    repo: true\n    user: true\n');
    const config = normalize({}, [
      {
        name: 'implement',
        instruction: '{task}',
        capabilities: ['provider-options/tools.yaml', 'provider-options/skills-grant.yaml'],
      },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.capabilityProviderOptions).toEqual({
      claude: { allowedTools: ['Read'] },
      codex: { skills: { repo: true, user: true } },
    });
  });

  it('should let a later listed set win when multiple listed sets declare the same leaf', () => {
    writeCapabilitySet('narrow', 'claude:\n  allowed_tools:\n    - Read\n');
    writeCapabilitySet('wide', 'claude:\n  allowed_tools:\n    - Read\n    - Edit\n');
    const config = normalize({}, [
      {
        name: 'implement',
        instruction: '{task}',
        capabilities: ['provider-options/narrow.yaml', 'provider-options/wide.yaml'],
      },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.capabilityProviderOptions?.claude?.allowedTools).toEqual(['Read', 'Edit']);
  });

  it('should fail fast when any listed set does not resolve', () => {
    writeCapabilitySet('tools', 'claude:\n  allowed_tools:\n    - Read\n');
    expect(() => normalize({}, [
      {
        name: 'implement',
        instruction: '{task}',
        capabilities: ['provider-options/tools.yaml', 'provider-options/ghost.yaml'],
      },
    ])).toThrow(/capabilities|not found/i);
  });

  it('should fail fast when any listed set carries a non-capability leaf', () => {
    writeCapabilitySet('tools', 'claude:\n  allowed_tools:\n    - Read\n');
    writeCapabilitySet('impure', 'claude:\n  effort: high\n');
    expect(() => normalize({}, [
      {
        name: 'implement',
        instruction: '{task}',
        capabilities: ['provider-options/tools.yaml', 'provider-options/impure.yaml'],
      },
    ])).toThrow(/not a capability leaf/);
  });
});
