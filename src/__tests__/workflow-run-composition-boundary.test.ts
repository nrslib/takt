import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

function source(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf-8');
}

describe('workflow run composition boundary', () => {
  it('workflow orchestrationとforce-fail actionはgeneric compositionだけを参照する', () => {
    const upperLayerSources = [
      source('src/features/tasks/execute/workflowExecution.ts'),
      source('src/features/tasks/list/taskRunForceFailStorage.ts'),
      source('src/features/tasks/list/taskForceFailActions.ts'),
    ].join('\n');

    expect(upperLayerSources).toContain('workflowRunStorage.js');
    expect(upperLayerSources).not.toMatch(
      /fileWorkflowRun|sqliteWorkflowRun|openRunStorage|createRunStorage/,
    );
    expect(upperLayerSources).not.toContain('workflowRunForceFailAdapters');
    expect(upperLayerSources).not.toMatch(
      /storageBackend\s*===|case ['"](?:file|sqlite)['"]/,
    );
    expect(upperLayerSources).not.toContain('.storageBackend');
  });

  it('backend選択は唯一のcomposition factoryにだけ存在する', () => {
    const composition = source(
      'src/features/tasks/execute/workflowRunStorage.ts',
    );
    const execution = source(
      'src/features/tasks/execute/workflowRunExecution.ts',
    );

    expect(composition.match(/case 'file'/g)).toHaveLength(1);
    expect(composition.match(/case 'sqlite'/g)).toHaveLength(1);
    expect(execution).toContain('finish(');
    expect(execution).not.toContain('stageTerminal');
    expect(execution).not.toMatch(/\bcomplete\(/);
  });
});
