import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { enqueueTaskInputSchema, listTasksInputSchema } from '../features/mcp/schemas.js';

const required = {
  cwd: '/repo',
  task: 'Implement MCP support',
  workflow: 'default',
  autoPr: false,
} as const;

describe('MCP tool input schema', () => {
  it('accepts exactly an absolute cwd for task listing', () => {
    expect(listTasksInputSchema.parse({ cwd: '/repo' })).toEqual({ cwd: '/repo' });
  });

  it.each([
    {},
    { cwd: 'repo' },
    { cwd: '/repo', status: 'pending' },
  ])('rejects non-minimal task listing input %#', (input) => {
    expect(() => listTasksInputSchema.parse(input)).toThrow();
  });

  it('preserves normal enqueue fields and task boundary whitespace', () => {
    const task = '\n# Implement MCP support\n\nKeep formatting.  \n';
    expect(enqueueTaskInputSchema.parse({
      ...required,
      task,
      worktree: true,
      taskContext: { branch: 'feature/mcp', baseBranch: 'main', prNumber: 938 },
    })).toEqual({
      ...required,
      task,
      worktree: true,
      taskContext: { branch: 'feature/mcp', baseBranch: 'main', prNumber: 938 },
    });
  });

  it('accepts either an existing issue number or issue creation settings', () => {
    expect(enqueueTaskInputSchema.parse({
      ...required,
      issue: { number: 938 },
    }).issue).toEqual({ number: 938 });
    expect(enqueueTaskInputSchema.parse({
      ...required,
      issue: { create: true, title: 'MCP consolidation', labels: ['enhancement', 'mcp'] },
    }).issue).toEqual({
      create: true,
      title: 'MCP consolidation',
      labels: ['enhancement', 'mcp'],
    });
  });

  it.each([
    { issue: { number: 0 } },
    { issue: { number: Number.MAX_SAFE_INTEGER + 1 } },
    { issue: { number: 1.5 } },
    { issue: { create: true, title: '   ' } },
    { issue: { create: true, labels: [''] } },
    { issue: { create: true, labels: ['  '] } },
    { issue: { number: 938, create: true } },
    { issue: { number: 938, unknown: true } },
    { issue: { create: true, unknown: true } },
  ])('rejects invalid or ambiguous issue input %#', (extra) => {
    expect(() => enqueueTaskInputSchema.parse({ ...required, ...extra })).toThrow();
  });

  it('rejects root labels from the removed issue-specific tool', () => {
    expect(() => enqueueTaskInputSchema.parse({
      ...required,
      labels: ['enhancement'],
    })).toThrow(/unrecognized|unknown/i);
  });

  it('requires explicit workflow and autoPr decisions', () => {
    expect(() => enqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'Implement MCP support',
    })).toThrow(/workflow|autoPr/i);
  });

  it('rejects relative cwd, blank task, oversized values, and custom worktree paths', () => {
    expect(() => enqueueTaskInputSchema.parse({ ...required, cwd: 'repo' })).toThrow(/absolute/i);
    expect(() => enqueueTaskInputSchema.parse({ ...required, task: '  ' })).toThrow(/task/i);
    expect(() => enqueueTaskInputSchema.parse({ ...required, task: 'x'.repeat((128 * 1024) + 1) })).toThrow();
    expect(() => enqueueTaskInputSchema.parse({ ...required, workflow: 'w'.repeat(129) })).toThrow();
    expect(() => enqueueTaskInputSchema.parse({ ...required, worktree: '/tmp/worktree' })).toThrow();
    expect(() => enqueueTaskInputSchema.parse({
      ...required,
      issue: { create: true, labels: Array.from({ length: 21 }, (_, index) => `label-${index}`) },
    })).toThrow();
  });

  it('enforces issue title and label length boundaries', () => {
    expect(enqueueTaskInputSchema.parse({
      ...required,
      issue: {
        create: true,
        title: 't'.repeat(255),
        labels: ['l'.repeat(100)],
      },
    }).issue).toEqual({
      create: true,
      title: 't'.repeat(255),
      labels: ['l'.repeat(100)],
    });
    expect(() => enqueueTaskInputSchema.parse({
      ...required,
      issue: { create: true, title: 't'.repeat(256) },
    })).toThrow();
    expect(() => enqueueTaskInputSchema.parse({
      ...required,
      issue: { create: true, labels: ['l'.repeat(101)] },
    })).toThrow();
  });

  it('exposes the nested issue schema in generated JSON Schema', () => {
    const schema = z.toJSONSchema(enqueueTaskInputSchema, { io: 'input' }) as {
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.properties?.issue?.description).toContain('existing issue number or create settings');
  });
});
