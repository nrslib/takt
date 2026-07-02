import { describe, expect, it } from 'vitest';
import {
  createIssueAndEnqueueTaskInputSchema,
  enqueueTaskInputSchema,
  runNextTaskInputSchema,
} from '../features/mcp/schemas.js';

describe('MCP tool input schemas', () => {
  it('Given root tool arguments, When enqueue input is parsed, Then task settings are preserved', () => {
    const parsed = enqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'Implement MCP support',
      workflow: 'review',
      worktree: true,
      autoPr: true,
      taskContext: {
        branch: 'takt/938/add-mcp',
        baseBranch: 'main',
        prNumber: 938,
      },
    });

    expect(parsed).toEqual({
      cwd: '/repo',
      task: 'Implement MCP support',
      workflow: 'review',
      worktree: true,
      autoPr: true,
      taskContext: {
        branch: 'takt/938/add-mcp',
        baseBranch: 'main',
        prNumber: 938,
      },
    });
  });

  it('Given task content with boundary whitespace, When enqueue input is parsed, Then the original task body is preserved', () => {
    const task = '\n  # Implement MCP support\n\nKeep formatting.  \n';

    const parsed = enqueueTaskInputSchema.parse({
      cwd: '/repo',
      task,
    });

    expect(parsed.task).toBe(task);
  });

  it('Given a response-envelope shaped payload, When enqueue input is parsed, Then it is rejected', () => {
    expect(() => enqueueTaskInputSchema.parse({
      content: [{
        type: 'text',
        text: JSON.stringify({
          cwd: '/repo',
          task: 'Implement MCP support',
        }),
      }],
    })).toThrow(/cwd|task/i);
  });

  it('Given a relative cwd, When enqueue input is parsed, Then it is rejected before filesystem work', () => {
    expect(() => enqueueTaskInputSchema.parse({
      cwd: 'relative/repo',
      task: 'Implement MCP support',
    })).toThrow(/absolute/i);
  });

  it.each([
    '/tmp/takt/unsafe-worktree',
    '../outside-project',
    'feature/mcp',
  ])('Given MCP worktree path "%s", When enqueue input is parsed, Then it is rejected', (worktree) => {
    expect(() => enqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'Implement MCP support',
      worktree,
    })).toThrow(/boolean|worktree/i);
  });

  it.each([
    'HEAD:refs/heads/takt/injected',
    '@{-1}',
    '-bad',
    '--upload-pack=echo',
    'refs/heads/feature/mcp',
    'origin/main',
    'refs/remotes/origin/main',
    'invalid..name',
  ])('Given unsafe taskContext branch "%s", When enqueue input is parsed, Then it is rejected', (branch) => {
    expect(() => enqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'Implement MCP support',
      taskContext: { branch },
    })).toThrow(/branch|Invalid/i);
  });

  it('Given labels at the root tool arguments, When issue enqueue input is parsed, Then labels are preserved', () => {
    const parsed = createIssueAndEnqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'Implement MCP support',
      labels: ['enhancement', 'mcp'],
    });

    expect(parsed.labels).toEqual(['enhancement', 'mcp']);
    expect(parsed.task).toBe('Implement MCP support');
  });

  it('Given an invalid run-next PR number, When run-next input is parsed, Then it is rejected', () => {
    expect(() => runNextTaskInputSchema.parse({
      cwd: '/repo',
      taskContext: { prNumber: 0 },
    })).toThrow(/prNumber|positive/i);
  });

  it('Given run-next task context, When run-next input is parsed, Then context fields are preserved', () => {
    const parsed = runNextTaskInputSchema.parse({
      cwd: '/repo',
      taskContext: {
        branch: 'takt/938/add-mcp',
        baseBranch: 'main',
        prNumber: 938,
      },
    });

    expect(parsed.taskContext).toEqual({
      branch: 'takt/938/add-mcp',
      baseBranch: 'main',
      prNumber: 938,
    });
  });
});
