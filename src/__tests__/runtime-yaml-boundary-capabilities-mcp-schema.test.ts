import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema, WorkflowStepRawSchema } from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

/**
 * Issue #1208 Stage 1 — additive schema surface for `capabilities` and `mcp`.
 * The features are implemented in the following `implement` step; these assertions are
 * expected to fail until then.
 *
 * Contracts (plan.md 完了契約):
 * - CT-CAP-1  `capabilities` accepted + retained at workflow / step / parallel sub-step (order.md:51-54,62)
 * - CT-MCP-1  workflow top-level `mcp_servers` definition accepted + retained (order.md:107)
 * - CT-MCP-2  step / sub-step `mcp:` reference key accepted + retained (order.md:106)
 * - CT-MCP-4  pre-existing inline step `mcp_servers` still accepted (maintain, order.md:107)
 *
 * Discrimination notes:
 * - The step / sub-step objects are NOT `.strict()`, so an unknown `capabilities`/`mcp` key is
 *   silently stripped today: `safeParse` already returns success. The retention assertion (the
 *   value must survive on `result.data`) is what distinguishes "schema field added" from
 *   "still stripped" — a misimplementation that only relaxes the strict top level but forgets to
 *   add the step/sub-step field passes `success` yet fails retention.
 * - The workflow top-level object IS `.strict()`, so an unknown key fails `success` today; both
 *   the `success` flip and retention discriminate a missing addition.
 */

type LooseRecord = Record<string, unknown>;

const MINIMAL_STEP = { name: 'implement', instruction: '{task}' } as const;

function minimalWorkflow(extra: LooseRecord): LooseRecord {
  return { name: 'wf', steps: [{ ...MINIMAL_STEP }], ...extra };
}

describe('CT-CAP-1 capabilities key is accepted and retained', () => {
  it('Given a workflow-level `capabilities` name, When parsed, Then it is accepted and retained', () => {
    const result = WorkflowConfigRawSchema.safeParse(
      minimalWorkflow({ capabilities: 'backend-default' }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as LooseRecord).capabilities).toBe('backend-default');
    }
  });

  it('Given a step-level `capabilities` name, When parsed, Then it is accepted and retained (not stripped)', () => {
    const result = WorkflowStepRawSchema.safeParse({
      ...MINIMAL_STEP,
      name: 'review',
      capabilities: 'review-readonly',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as LooseRecord).capabilities).toBe('review-readonly');
    }
  });

  it('Given a parallel sub-step `capabilities` name, When parsed, Then it is accepted and retained (not stripped)', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'reviewers',
      parallel: [{ name: 'arch-review', instruction: 'Review architecture', capabilities: 'review-readonly' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { parallel?: LooseRecord[] };
      expect(data.parallel?.[0]?.capabilities).toBe('review-readonly');
    }
  });
});

describe('CT-MCP-1 workflow top-level mcp_servers definition', () => {
  it('Given a workflow top-level `mcp_servers` definition, When parsed, Then it is accepted and retained', () => {
    const servers = {
      browser: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-browser'] },
    };
    const result = WorkflowConfigRawSchema.safeParse(minimalWorkflow({ mcp_servers: servers }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as LooseRecord).mcp_servers).toEqual(servers);
    }
  });
});

describe('CT-MCP-2 step / sub-step mcp reference key', () => {
  it('Given a step `mcp:` reference list, When parsed, Then it is accepted and retained (not stripped)', () => {
    const result = WorkflowStepRawSchema.safeParse({ ...MINIMAL_STEP, mcp: ['browser'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as LooseRecord).mcp).toEqual(['browser']);
    }
  });

  it('Given a parallel sub-step `mcp:` reference list, When parsed, Then it is accepted and retained (not stripped)', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'reviewers',
      parallel: [{ name: 'arch-review', instruction: 'Review architecture', mcp: ['browser'] }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { parallel?: LooseRecord[] };
      expect(data.parallel?.[0]?.mcp).toEqual(['browser']);
    }
  });
});

describe('CT-MCP-4 pre-existing inline step mcp_servers is preserved', () => {
  it('Given a step with an inline `mcp_servers` stdio definition, When parsed, Then it stays accepted and retained', () => {
    const result = WorkflowStepRawSchema.safeParse({
      ...MINIMAL_STEP,
      mcp_servers: { browser: { command: 'npx' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { mcp_servers?: Record<string, { command?: string }> };
      expect(data.mcp_servers?.browser?.command).toBe('npx');
    }
  });
});

/**
 * 決定#6 — `capabilities` / `mcp` are agent-only capability declarations. `system` and
 * `workflow_call` steps never consume them, so the normalizer fails fast rather than silently
 * dropping the value (`workflowStepNormalizer.ts` throw). These are the rejection-side counterparts
 * to the acceptance tests above: the schema does NOT list `capabilities`/`mcp` among the
 * system/workflow_call forbidden fields, so parse succeeds and the normalizer throw is the only
 * enforcement point. Removing that guard makes these tests red (the value would be silently
 * dropped instead of rejected).
 */
const REJECTION_REGEX = /cannot use "capabilities"\/"mcp" on a (system|workflow_call) step/;

function normalizeSingleStep(step: LooseRecord) {
  return normalizeWorkflowConfig({ name: 'wf', steps: [step] }, process.cwd());
}

describe('capabilities/mcp are rejected on system and workflow_call steps', () => {
  it('Given a system step with `capabilities`, When normalized, Then it fails fast (not silently dropped)', () => {
    expect(() => normalizeSingleStep({
      name: 'route',
      mode: 'system',
      capabilities: 'backend-default',
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    })).toThrow(REJECTION_REGEX);
  });

  it('Given a workflow_call step with `mcp`, When normalized, Then it fails fast (not silently dropped)', () => {
    expect(() => normalizeSingleStep({
      name: 'delegate',
      kind: 'workflow_call',
      call: 'takt/review-loop',
      mcp: ['browser'],
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    })).toThrow(REJECTION_REGEX);
  });

  it('Given a system step with `mcp`, When normalized, Then it fails fast (symmetric guard)', () => {
    expect(() => normalizeSingleStep({
      name: 'route',
      mode: 'system',
      mcp: ['browser'],
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    })).toThrow(REJECTION_REGEX);
  });

  it('Given a workflow_call step with `capabilities`, When normalized, Then it fails fast (symmetric guard)', () => {
    expect(() => normalizeSingleStep({
      name: 'delegate',
      kind: 'workflow_call',
      call: 'takt/review-loop',
      capabilities: 'review-readonly',
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    })).toThrow(REJECTION_REGEX);
  });
});
