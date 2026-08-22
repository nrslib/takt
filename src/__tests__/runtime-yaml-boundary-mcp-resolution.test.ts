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
  it('should resolve the definition onto the step when a step `mcp:` reference matches a top-level definition', () => {
    const config = normalize({ mcp_servers: { browser: BROWSER } }, [
      { name: 'implement', instruction: '{task}', mcp: ['browser'] },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.mcpServers?.browser).toEqual(BROWSER);
  });

  it('should fail fast naming the server when a step `mcp:` reference has no matching definition', () => {
    expect(() => normalize({ mcp_servers: { browser: BROWSER } }, [
      { name: 'implement', instruction: '{task}', mcp: ['ghost'] },
    ])).toThrow(/ghost|not defined/i);
  });

  it('should fail fast when a `mcp:` reference is present and no top-level definitions exist', () => {
    expect(() => normalize({}, [
      { name: 'implement', instruction: '{task}', mcp: ['browser'] },
    ])).toThrow(/browser|not defined/i);
  });

  it('should resolve the definition onto the sub-step when a parallel sub-step declares a `mcp:` reference', () => {
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
  it('should fail fast as disabled-by-default when a resolved stdio reference has no transport policy', () => {
    // BROWSER has no `type`, so it resolves as a stdio transport; with no policy, stdio is denied.
    // Regression guard: a bundled default pulled in by `mcp:` reference must hit the SAME deny gate
    // as an inline `mcp_servers` definition, not slip through because it arrived via a reference.
    expect(() => normalizeDenyByDefault({ mcp_servers: { browser: BROWSER } }, [
      { name: 'implement', instruction: '{task}', mcp: ['browser'] },
    ])).toThrow(/disabled by default|browser|stdio/i);
  });
});

describe('CT-MCP-4 inline mcp_servers preserved alongside references', () => {
  it('should keep the inline definition when a step declares an inline `mcp_servers`', () => {
    const config = normalize({}, [
      { name: 'implement', instruction: '{task}', mcp_servers: { local: { command: 'node' } } },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.mcpServers?.local?.command).toBe('node');
  });

  it('should let the inline definition win when it collides with a referenced definition of the same name', () => {
    // The resolution contract is `{ ...resolved, ...inline }`: an explicit inline override must not
    // be shadowed by the workflow-bundled default it shares a name with.
    const config = normalize({ mcp_servers: { browser: BROWSER } }, [
      {
        name: 'implement',
        instruction: '{task}',
        mcp: ['browser'],
        mcp_servers: { browser: { command: 'inline-browser' } },
      },
    ]);
    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.mcpServers?.browser).toEqual({ command: 'inline-browser' });
  });
});

describe('mcp reference lookup is own-property only', () => {
  it('should fail fast when a `mcp:` reference names an Object.prototype member', () => {
    // `definitions[name]` would hand back `Object.prototype.toString` — a function silently
    // installed as an MCP server. The reference must be unresolved instead.
    expect(() => normalize({ mcp_servers: { browser: BROWSER } }, [
      { name: 'implement', instruction: '{task}', mcp: ['toString'] },
    ])).toThrow(/toString|not defined/i);
  });

  it('should fail fast when a `mcp:` reference names a prototype member and no definitions exist', () => {
    expect(() => normalize({}, [
      { name: 'implement', instruction: '{task}', mcp: ['constructor'] },
    ])).toThrow(/constructor|not defined/i);
  });
});
