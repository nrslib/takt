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
 * - CT-CAP-5 when a step carries BOTH `capabilities` and a direct `provider_options`, the
 *   capabilities sit at the lowest layer and the direct `provider_options` wins; allowedTools is
 *   replaced by the winning layer, not unioned (workflowStepNormalizer.ts:385-393).
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
    expect(step.providerOptions?.claude?.allowedTools).toEqual(['Read', 'Grep']);
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
    expect(inherits.providerOptions?.claude?.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
    // The overriding step replaces it entirely — Grep/Bash from the default must NOT leak in.
    expect(overrides.providerOptions?.claude?.allowedTools).toEqual(['Read']);
  });
});

describe('CT-CAP-5 capabilities and direct provider_options coexist on the same step', () => {
  it('should let provider_options win by replacement when a step declares both `capabilities` and `provider_options`', () => {
    writeCapabilitySet('caps-read-grep', 'claude:\n  allowed_tools:\n    - Read\n    - Grep\n');
    const config = normalize({}, [
      {
        name: 'coexist',
        instruction: '{task}',
        capabilities: 'provider-options/caps-read-grep.yaml',
        provider_options: { claude: { allowed_tools: ['Read', 'Bash'] } },
      },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    // Capabilities [Read, Grep] are the lowest layer; the direct provider_options [Read, Bash]
    // replaces allowedTools wholesale. The capability-only `Grep` discriminates all three outcomes:
    //   provider_options wins (replace) → [Read, Bash]  ← contract
    //   union                            → [Read, Grep, Bash]
    //   capabilities win (reverse order) → [Read, Grep]
    expect(step.providerOptions?.claude?.allowedTools).toEqual(['Read', 'Bash']);
  });
});
