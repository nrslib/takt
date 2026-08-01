import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

function source(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf-8');
}

describe('workflow run lifecycle boundary', () => {
  it('run lifecycleはfile artifact lifecycleとしてSQLite実装を上位層へ露出しない', () => {
    const upperLayerSources = [
      source('src/features/tasks/execute/workflowExecution.ts'),
      source('src/features/tasks/list/taskRunForceFailStorage.ts'),
      source('src/features/tasks/list/taskForceFailActions.ts'),
    ].join('\n');

    expect(upperLayerSources).toContain('workflowRunLifecycle.js');
    expect(upperLayerSources).not.toMatch(
      /sqliteWorkflowRun|openRunStorage|createRunStorage/,
    );
  });

  it('lifecycleはrun backendを選択せずFinding storageだけを構成する', () => {
    const composition = source(
      'src/features/tasks/execute/workflowRunLifecycle.ts',
    );
    const execution = source(
      'src/features/tasks/execute/workflowRunExecution.ts',
    );

    expect(composition).toContain('FindingStorageResolver');
    expect(composition).not.toMatch(/case ['"](?:file|sqlite)['"]/);
    expect(composition).not.toContain('reconcilePending');
    expect(composition).not.toContain('createForceFail');
    expect(execution).toContain('finish(');
    expect(execution).not.toContain('stageTerminal');
    expect(execution).not.toMatch(/\bcomplete\(/);
  });
});
