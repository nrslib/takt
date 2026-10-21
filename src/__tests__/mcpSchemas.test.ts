import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  askGoalQuestionInputSchema, enqueueTaskInputSchema, getGoalQuestionInputSchema, withdrawGoalQuestionInputSchema,
} from '../features/mcp/schemas.js';
import { goalId } from './helpers/goal-fixtures.js';

const required = {
  cwd: '/repo',
  task: 'Implement MCP support',
  workflow: 'default',
  autoPr: false,
} as const;

describe('MCP tool input schema', () => {
  it.each([true, false])('preserves explicit draftPr %s', (draftPr) => {
    expect(enqueueTaskInputSchema.parse({ ...required, draftPr })).toEqual({
      ...required,
      draftPr,
    });
  });

  it('does not default an omitted draftPr', () => {
    expect(enqueueTaskInputSchema.parse(required)).not.toHaveProperty('draftPr');
  });

  it.each([null, 'false', 0, {}])('rejects a non-boolean draftPr %#', (draftPr) => {
    expect(() => enqueueTaskInputSchema.parse({ ...required, draftPr })).toThrow();
  });

  it('exposes draftPr as an optional boolean without a JSON Schema default', () => {
    const schema = z.toJSONSchema(enqueueTaskInputSchema, { io: 'input' });
    expect(schema.properties?.draftPr).toMatchObject({ type: 'boolean' });
    expect(schema.properties?.draftPr).not.toHaveProperty('default');
    expect(schema.required).not.toContain('draftPr');
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

  it('exposes both issue alternatives in generated JSON Schema', () => {
    const schema = z.toJSONSchema(enqueueTaskInputSchema, { io: 'input' });
    expect(schema.properties?.issue).toMatchObject({
      anyOf: [
        { type: 'object', required: ['number'], additionalProperties: false },
        { type: 'object', required: ['create'], additionalProperties: false },
      ],
    });
  });
});

describe('MCP inquiry inputs', () => {
  const inquiry = { cwd: '/repo', goalId, body: '確認してください' };
  const identity = { cwd: '/repo', goalId, questionId: '650e8400-e29b-41d4-a716-446655440001' };

  it('defaults an omitted kind to question', () => {
    expect(askGoalQuestionInputSchema.parse(inquiry)).toMatchObject({ kind: 'question', recipient: 'human' });
  });

  it.each(['question', 'operation_request'])('accepts the explicit %s kind and a target SHA', (kind) => {
    const input = { ...inquiry, kind, targetSha: 'a'.repeat(40) };
    expect(askGoalQuestionInputSchema.parse(input)).toMatchObject(input);
  });

  it('explains why approvals cannot be created through the manager tool', () => {
    const result = askGoalQuestionInputSchema.safeParse({ ...inquiry, kind: 'approval' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('承認の作成が拒否されていません');
    const message = result.error.issues.map((issue) => issue.message).join('\n');
    expect(message).toMatch(/approval|承認/iu);
    expect(message).toMatch(/judg|manager|cannot.*creat|not.*allow|判断|作成でき|許可され/iu);
  });

  it.each(['unknown', '', null])('rejects an unsupported kind %j', (kind) => {
    expect(askGoalQuestionInputSchema.safeParse({ ...inquiry, kind }).success).toBe(false);
  });

  it.each(['a'.repeat(64), 'b'.repeat(40)])('accepts a supported SHA length of %s', (targetSha) => {
    expect(askGoalQuestionInputSchema.parse({ ...inquiry, targetSha })).toMatchObject({ targetSha });
  });

  it.each(['abc', 'g'.repeat(40)])('rejects an invalid target SHA %s', (targetSha) => {
    expect(askGoalQuestionInputSchema.safeParse({ ...inquiry, targetSha }).success).toBe(false);
  });

  it('accepts withdrawal with an optional unmodified reason', () => {
    expect(withdrawGoalQuestionInputSchema.parse(identity)).toEqual(identity);
    const input = { ...identity, reason: '  別の方法で解決しました\n' };
    expect(withdrawGoalQuestionInputSchema.parse(input)).toEqual(input);
  });

  it('accepts the withdrawal reason text selector', () => {
    expect(getGoalQuestionInputSchema.parse({ ...identity, path: 'withdrawalReason', maxBytes: 12 }))
      .toMatchObject({ path: 'withdrawalReason', maxBytes: 12 });
  });
});
