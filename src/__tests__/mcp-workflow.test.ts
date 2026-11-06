import { describe, expect, it, vi } from 'vitest';
import { getTaktWorkflow } from '../features/mcp/workflowOperations.js';
import { MCP_RESPONSE_MAX_BYTES, responseBytes } from '../features/mcp/response.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { firstTextContent } from './helpers/mcp-content.js';

vi.mock('../infra/config/index.js', () => ({ loadWorkflowByIdentifier: vi.fn() }));

describe('workflow detail response', () => {
  it('bounds escaped and multibyte descriptions and marks omissions', () => {
    const workflow: WorkflowConfig = {
      name: 'large', initialStep: 'work', maxSteps: 10, description: '\0日本語'.repeat(30000),
      steps: [{ name: 'work', description: '\0日本語'.repeat(30000), personaDisplayName: '', instruction: '',
        rules: [{ condition: { kind: 'when', expression: 'true' }, next: 'COMPLETE' }] }],
    };
    vi.mocked(loadWorkflowByIdentifier).mockReturnValue(workflow);
    const result = getTaktWorkflow({ cwd: '/repo', workflow: 'large' }, {});
    expect(result.isError).toBeUndefined();
    expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    const value = JSON.parse(firstTextContent(result.content));
    expect(value.truncated).toBe(true);
    expect(value.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'description' })]));
    expect(value.steps[0]).toMatchObject({ name: 'work', kind: 'agent' });
  });

  it('returns a tool error for an unknown workflow', () => {
    vi.mocked(loadWorkflowByIdentifier).mockReturnValue(null);
    expect(getTaktWorkflow({ cwd: '/repo', workflow: 'missing' }, {}).isError).toBe(true);
  });
});
