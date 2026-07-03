import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  createIssueAndEnqueueTaskInputSchema,
  enqueueTaskInputSchema,
  runNextTaskInputSchema,
} from '../features/mcp/schemas.js';

type JsonSchemaObject = {
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
};

function schemaProperties(schema: JsonSchemaObject): Record<string, JsonSchemaObject> {
  if (schema.properties === undefined) {
    throw new Error('Expected JSON Schema object with properties');
  }
  return schema.properties;
}

function requireSchema(schema: JsonSchemaObject | undefined, name: string): JsonSchemaObject {
  if (schema === undefined) {
    throw new Error(`Expected JSON Schema property: ${name}`);
  }
  return schema;
}

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

  it('Given oversized MCP input fields, When inputs are parsed, Then they are rejected at the tool boundary', () => {
    expect(() => enqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'x'.repeat((128 * 1024) + 1),
    })).toThrow(/too big|maximum|at most/i);
    expect(() => enqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'Implement MCP support',
      workflow: 'w'.repeat(129),
    })).toThrow(/too big|maximum|at most/i);
    expect(() => createIssueAndEnqueueTaskInputSchema.parse({
      cwd: '/repo',
      task: 'Implement MCP support',
      labels: Array.from({ length: 21 }, (_, index) => `label-${index}`),
    })).toThrow(/too big|maximum|at most/i);
    expect(() => runNextTaskInputSchema.parse({
      cwd: '/repo',
      model: 'm'.repeat(129),
    })).toThrow(/too big|maximum|at most/i);
  });

  it.each([
    ['enqueue', enqueueTaskInputSchema, { cwd: '/repo', task: 'Implement MCP support' }],
    ['issue enqueue', createIssueAndEnqueueTaskInputSchema, { cwd: '/repo', task: 'Implement MCP support' }],
    ['run-next', runNextTaskInputSchema, { cwd: '/repo' }],
  ])('Given unsafe PR numbers, When %s input is parsed, Then they are rejected', (_name, schema, baseInput) => {
    for (const prNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => schema.parse({
        ...baseInput,
        taskContext: { prNumber },
      })).toThrow(/prNumber|safe integer|positive/i);
    }
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

  it('Given MCP input schemas, When converted to JSON Schema, Then optional field descriptions are preserved', () => {
    const enqueueProperties = schemaProperties(z.toJSONSchema(enqueueTaskInputSchema, { io: 'input' }));
    const issueProperties = schemaProperties(z.toJSONSchema(createIssueAndEnqueueTaskInputSchema, { io: 'input' }));
    const runNextProperties = schemaProperties(z.toJSONSchema(runNextTaskInputSchema, { io: 'input' }));
    const taskContextProperties = schemaProperties(requireSchema(enqueueProperties.taskContext, 'taskContext'));

    expect(enqueueProperties.workflow?.description).toBe('Workflow identifier to store on the queued task. Defaults to the TAKT default workflow.');
    expect(enqueueProperties.worktree?.description).toBe('Whether the queued task should run in a TAKT-managed worktree.');
    expect(enqueueProperties.autoPr?.description).toBe('Whether successful worktree execution should automatically open a pull request.');
    expect(issueProperties.labels?.description).toBe('Issue labels to request from the configured issue provider.');
    expect(runNextProperties.provider?.description).toBe('Agent provider override for this task execution.');
    expect(runNextProperties.model?.description).toBe('Model override for this task execution.');
    expect(taskContextProperties.branch?.description).toBe('Plain local Git branch name for task execution context.');
    expect(taskContextProperties.baseBranch?.description).toBe('Plain local Git base branch name used when creating or resolving a task worktree.');
    expect(taskContextProperties.baseBranch?.description).not.toBe(taskContextProperties.branch?.description);
    expect(taskContextProperties.prNumber?.description).toBe('PR number used as task execution context, not as PR-review provenance.');
  });
});
