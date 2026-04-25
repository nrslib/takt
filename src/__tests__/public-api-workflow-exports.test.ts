import { describe, expect, it } from 'vitest';

describe('public API workflow exports', () => {
  it('should expose workflow-centric APIs', async () => {
    // When
    const api = await import('../index.js');

    // Then
    expect(typeof api.WorkflowEngine).toBe('function');
    expect(typeof api.loadWorkflow).toBe('function');
    expect(typeof api.loadWorkflowByIdentifier).toBe('function');
    expect(typeof api.listWorkflows).toBe('function');
    expect(typeof api.isWorkflowPath).toBe('function');

    expect('WorkflowEngine' in api).toBe(true);
    expect('loadWorkflow' in api).toBe(true);
    expect('loadWorkflowByIdentifier' in api).toBe(true);
    expect('listWorkflows' in api).toBe(true);
    expect('isWorkflowPath' in api).toBe(true);
  });
});
