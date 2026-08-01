import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

function source(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf-8');
}

describe('workflow run composition boundary', () => {
  it('run lifecycleはfile authorityに固定しSQLite実装を上位層へ露出しない', () => {
    const upperLayerSources = [
      source('src/features/tasks/execute/workflowExecution.ts'),
      source('src/features/tasks/list/taskRunForceFailStorage.ts'),
      source('src/features/tasks/list/taskForceFailActions.ts'),
    ].join('\n');

    expect(upperLayerSources).toContain('workflowRunStorage.js');
    expect(upperLayerSources).not.toMatch(
      /sqliteWorkflowRun|openRunStorage|createRunStorage/,
    );
    expect(upperLayerSources).not.toMatch(
      /storageBackend\s*===|case ['"]sqlite['"]/,
    );
    expect(upperLayerSources).not.toContain('.storageBackend');
  });

  it('compositionはrun lifecycle backendを選択せずFinding storageだけを選択する', () => {
    const composition = source(
      'src/features/tasks/execute/workflowRunStorage.ts',
    );
    const execution = source(
      'src/features/tasks/execute/workflowRunExecution.ts',
    );

    expect(composition).toContain('#findingStorageBackend');
    expect(composition).toContain("backend: 'file'");
    expect(composition).not.toMatch(/case ['"](?:file|sqlite)['"]/);
    expect(composition).not.toContain('reconcilePending');
    expect(composition).not.toContain('createForceFail');
    expect(execution).toContain('finish(');
    expect(execution).not.toContain('stageTerminal');
    expect(execution).not.toMatch(/\bcomplete\(/);
  });
});
