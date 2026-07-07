import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('architecture boundaries', () => {
  it('keeps workflow system enqueue effect independent from task add feature modules', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/infra/workflow/system/system-enqueue-effect.ts'),
      'utf-8',
    );

    expect(source).not.toContain('features/tasks/add');
  });

  it('keeps task enqueue service boundary owned by infra task modules', () => {
    const legacyFacadePath = join(process.cwd(), 'src/features/tasks/add/enqueueService.ts');
    const addSource = readFileSync(
      join(process.cwd(), 'src/features/tasks/add/index.ts'),
      'utf-8',
    );

    expect(existsSync(legacyFacadePath)).toBe(false);
    expect(addSource).toContain('infra/task/enqueuedTaskFile.js');
    expect(addSource).not.toContain('new TaskRunner');
    expect(addSource).not.toContain('runner.addTask');
    expect(addSource).not.toContain('TaskExecutionConfigSchema');
    expect(addSource).not.toContain('summarizeTaskName');
  });
});
