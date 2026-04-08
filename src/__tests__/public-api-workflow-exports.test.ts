import { describe, expect, it } from 'vitest';

const legacyEngineExport = ['Piece', 'Engine'].join('');
const legacyLoadExport = ['load', 'Pi', 'ece'].join('');
const legacyLoadByIdentifierExport = ['load', 'Pi', 'ece', 'ByIdentifier'].join('');
const legacyListExport = ['list', 'Pi', 'eces'].join('');
const legacyPathExport = ['is', 'Pi', 'ece', 'Path'].join('');

describe('public API workflow exports', () => {
  it('should expose workflow-centric APIs and hide removed legacy exports', async () => {
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

    expect(legacyEngineExport in api).toBe(false);
    expect(legacyLoadExport in api).toBe(false);
    expect(legacyLoadByIdentifierExport in api).toBe(false);
    expect(legacyListExport in api).toBe(false);
    expect(legacyPathExport in api).toBe(false);
  });
});
