import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import type { AgentWorkflowStep } from '../core/models/index.js';

/**
 * Issue #1208 Stage 1 — `mcp:` reference resolution against workflow top-level `mcp_servers`
 * (the consumption side of CT-MCP-1/2).
 *
 * Contracts (plan.md 完了契約):
 * - CT-MCP-3 a `mcp:` reference resolves against the workflow-bundled `mcp_servers` definitions; an
 *   unresolved name fails fast at load time (order.md:110). The runtime.yaml override layer is a
 *   later stage; the workflow-bundled default is the resolution source here.
 * - CT-MCP-4 pre-existing inline step `mcp_servers` keeps working alongside references.
 *
 * Discrimination: an unresolved reference must throw (not silently drop), and a resolved reference
 * must materialize the referenced definition on the normalized step's `mcpServers`.
 */

const BROWSER = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-browser'] };

// Resolved references are gated by the same deny-by-default transport policy as inline definitions
// (CT-MCP-5), so the tests that assert successful resolution allow stdio explicitly.
const ALLOW_STDIO = { stdio: true } as const;

function normalize(extra: Record<string, unknown>, steps: Array<Record<string, unknown>>) {
  return normalizeWorkflowConfig(
    { name: 'wf', ...extra, steps },
    process.cwd(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ALLOW_STDIO,
  );
}

// Same call, but with NO transport policy (8th argument undefined) — deny-by-default is in force.
function normalizeDenyByDefault(extra: Record<string, unknown>, steps: Array<Record<string, unknown>>) {
  return normalizeWorkflowConfig({ name: 'wf', ...extra, steps }, process.cwd());
}

describe('CT-MCP-3 mcp reference resolution', () => {
  it('Given a step `mcp:` reference and a matching top-level definition, When normalized, Then it resolves onto the step', () => {
    const config = normalize({ mcp_servers: { browser: BROWSER } }, [
      { name: 'implement', instruction: '{task}', mcp: ['browser'] },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.mcpServers?.browser).toEqual(BROWSER);
  });

  it('Given a step `mcp:` reference with no matching definition, When normalized, Then it fails fast naming the server', () => {
    expect(() => normalize({ mcp_servers: { browser: BROWSER } }, [
      { name: 'implement', instruction: '{task}', mcp: ['ghost'] },
    ])).toThrow(/ghost|not defined/i);
  });

  it('Given a reference with no top-level definitions at all, When normalized, Then it fails fast', () => {
    expect(() => normalize({}, [
      { name: 'implement', instruction: '{task}', mcp: ['browser'] },
    ])).toThrow(/browser|not defined/i);
  });

  it('Given a parallel sub-step `mcp:` reference, When normalized, Then it resolves onto the sub-step', () => {
    const config = normalize({ mcp_servers: { browser: BROWSER } }, [
      {
        name: 'reviewers',
        parallel: [{ name: 'arch-review', instruction: 'Review architecture', mcp: ['browser'] }],
      },
    ]);
    const parent = config.steps[0] as AgentWorkflowStep;
    const sub = parent.parallel?.[0] as AgentWorkflowStep;
    expect(sub.mcpServers?.browser).toEqual(BROWSER);
  });
});

describe('CT-MCP-5 resolved references pass through the deny-by-default transport gate', () => {
  it('Given a resolved stdio reference and no transport policy, When normalized, Then it fails fast as disabled-by-default', () => {
    // BROWSER has no `type`, so it resolves as a stdio transport; with no policy, stdio is denied.
    // Regression guard: a bundled default pulled in by `mcp:` reference must hit the SAME deny gate
    // as an inline `mcp_servers` definition, not slip through because it arrived via a reference.
    expect(() => normalizeDenyByDefault({ mcp_servers: { browser: BROWSER } }, [
      { name: 'implement', instruction: '{task}', mcp: ['browser'] },
    ])).toThrow(/disabled by default|browser|stdio/i);
  });
});

describe('CT-MCP-4 inline mcp_servers preserved alongside references', () => {
  it('Given a step with an inline `mcp_servers`, When normalized, Then the inline definition survives', () => {
    const config = normalize({}, [
      { name: 'implement', instruction: '{task}', mcp_servers: { local: { command: 'node' } } },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.mcpServers?.local?.command).toBe('node');
  });
});
