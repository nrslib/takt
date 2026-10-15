import { describe, expect, it } from 'vitest';
import { jsonResult, MCP_RESPONSE_MAX_BYTES, pagedResult, responseBytes, textResult } from '../features/mcp/response.js';
import { sliceUtf8 } from '../shared/utils/utf8.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { completionSummary, goalSummary, goalValuePage, goalWriteSummary, integrationSummary, questionSummary, selectGoalValue } from '../features/mcp/goalResponse.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { getGoalInputSchema, getRunInputSchema, goalWriteInputSchema } from '../features/mcp/schemas.js';
import { GoalSchema } from '../infra/goals/schema.js';

describe('bounded MCP responses', () => {
  it.each(['a', '日本語', '\\"\n\u0000', '😀'])('bounds escaped UTF-8 text and retains valid JSON for %j', (character) => {
    const result = jsonResult({ status: 'created', body: character.repeat(70000) });
    expect(result.isError).toBeUndefined();
    expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    const payload = JSON.parse(firstTextContent(result.content));
    expect(payload.status).toBe('created');
    expect(payload.body.length).toBeGreaterThan(0);
    expect(payload.truncated).toBe(true);
    expect(payload.omissions).toContainEqual({ path: 'body', totalBytes: Buffer.byteLength(character.repeat(70000)), returnedBytes: Buffer.byteLength(payload.body) });
    expect(payload.body).not.toContain('�');
  });
  it('counts the complete envelope and marker at the boundary', () => {
    const suffix = '\nreference-marker';
    for (const length of [65000, 65536, 65537]) {
      const result = jsonResult({ value: 'a'.repeat(length) }, undefined, suffix);
      expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      expect(firstTextContent(result.content).endsWith(suffix)).toBe(true);
      expect(JSON.parse(firstTextContent(result.content).slice(0, -suffix.length)).value.length).toBeGreaterThan(0);
    }
  });
  it('returns the final truncated response when the marker alone exceeds the size limit', () => {
    const suffix = '\n' + 'r'.repeat(MCP_RESPONSE_MAX_BYTES);
    const result = jsonResult({ body: 'x'.repeat(8192), rows: [1] }, undefined, suffix);

    expect(responseBytes(result)).toBeGreaterThan(MCP_RESPONSE_MAX_BYTES);
    expect(result.isError).toBeUndefined();
    const text = firstTextContent(result.content);
    expect(text.endsWith(suffix)).toBe(true);
    const payload = JSON.parse(text.slice(0, -suffix.length));
    expect(payload.body).toBe('x'.repeat(64));
    expect(payload.rows).toEqual([]);
    expect(payload.truncated).toBe(true);
    expect(payload.omissions).toEqual([
      { path: 'body', totalBytes: 8192, returnedBytes: 64 },
      { path: 'rows', totalCount: 1, returnedCount: 0 },
    ]);
    expect(payload.omittedDetails).toBe(0);
    expect(payload.retrieval).toContain('path and textOffset');
    expect(payload.retrieval).toContain('offset and a smaller limit');
  });
  it('bounds omission metadata and large collections', () => {
    const result = jsonResult({ rows: Array.from({ length: 200 }, () => ({ a: 'x'.repeat(8000), b: 'y'.repeat(8000) })) });
    const payload = JSON.parse(firstTextContent(result.content));
    expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    expect(payload.omissions.length).toBeLessThanOrEqual(50);
    expect(payload.rows.length).toBeGreaterThan(0);
    expect(payload.omissions).toContainEqual(expect.objectContaining({ path: 'rows[].a', count: payload.rows.length }));
    expect(payload.omittedDetails).toBe(0);
  });
  it('preserves real errors and small text', () => {
    expect(textResult('failed', true)).toEqual({ isError: true, content: [{ type: 'text', text: 'failed' }] });
    expect(responseBytes(textResult('失敗'.repeat(50000), true))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    expect(jsonResult({ ok: true })).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
  });
  it.each([false, true])('updates the returned range when final JSON escaping shortens a text page (tail=%s)', (tail) => {
    const text = '先頭' + '\u0000'.repeat(8000) + '末尾';
    const original = sliceUtf8(text, 0, 4096, tail);
    const result = jsonResult({ metadata: { task: '\u0000'.repeat(6000), workflow: '\u0000'.repeat(6000) }, page: original });
    const payload = JSON.parse(firstTextContent(result.content));
    const page = payload.page;
    expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    expect(page.returnedBytes).toBe(Buffer.byteLength(page.content));
    expect(page.returnedBytes).toBeLessThan(original.returnedBytes);
    expect(page.content).toBe(Buffer.from(text).subarray(page.offset, page.offset + page.returnedBytes).toString('utf8'));
    const next = sliceUtf8(text, page.nextOffset, 4096, tail);
    if (tail) {
      expect(page.content.endsWith('末尾')).toBe(true);
      expect(next.offset + next.returnedBytes).toBe(page.offset);
    } else expect(next.offset).toBe(page.offset + page.returnedBytes);
  });
  it('makes page cursors reflect the actual returned collection', () => {
    const result = pagedResult('items', Array.from({ length: 50 }, (_, index) => ({ index, body: 'x'.repeat(3000) })), 100, 10);
    const page = JSON.parse(firstTextContent(result.content));
    expect(page.nextOffset).toBe(10 + page.items.length);
    expect(page.returnedCount).toBe(page.items.length);
    expect(page.omittedCount).toBe(100 - page.items.length);
  });
  it('updates nested collection metadata when final size reduction removes entries', () => {
    const values = Array.from({ length: 50 }, () => ({ values: Array.from({ length: 50 }, () => ({ body: '\u0000'.repeat(1000) })) }));
    const result = jsonResult({ rows: values,
      page: { collection: 'rows', totalCount: 100, returnedCount: 50, omittedCount: 50, offset: 10, nextOffset: 60, truncated: true } });
    const output = JSON.parse(firstTextContent(result.content));
    expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    expect(output.rows.length).toBeGreaterThan(0);
    expect(output.rows.length).toBeLessThan(50);
    expect(output.page).toMatchObject({ returnedCount: output.rows.length, omittedCount: 100 - output.rows.length, nextOffset: 10 + output.rows.length });
  });
});

describe('UTF-8 text ranges', () => {
  it('reassembles forward ranges without splitting multibyte characters', () => {
    const original = '日本語😀'.repeat(20);
    let text = '';
    let offset = 0;
    for (;;) {
      const page = sliceUtf8(original, offset, 8);
      text += page.content;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(text).toBe(original);
  });
  it('reassembles backward ranges and handles complete and exhausted ranges', () => {
    const original = '先頭日本語😀末尾';
    let text = '';
    let offset = 0;
    for (;;) {
      const page = sliceUtf8(original, offset, 8, true);
      text = page.content + text;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(text).toBe(original);
    expect(sliceUtf8('abc', 0, 4)).toMatchObject({ content: 'abc', truncated: false, nextOffset: null });
    expect(sliceUtf8('abc', 20, 4)).toMatchObject({ content: '', nextOffset: null });
  });
});

describe('goal response projections', () => {
  it('exposes read selectors without adding them to write inputs', () => {
    const identity = { cwd: '/project', goalId: goalRecord().id };
    expect(getGoalInputSchema.safeParse({ ...identity, path: 'workLog.summary', recordId: goalRecord().id, maxBytes: 4, textOffset: 0 }).success).toBe(true);
    expect(goalWriteInputSchema.safeParse({ ...identity, path: 'workLog', limit: 1 }).success).toBe(false);
    for (const limit of [1, 50]) expect(getRunInputSchema.safeParse({ cwd: '/project', runSlug: 'run', limit }).success).toBe(true);
    for (const limit of [0, 51, 1.5]) expect(getRunInputSchema.safeParse({ cwd: '/project', runSlug: 'run', limit }).success).toBe(false);
  });
  it('selects stored fields and record IDs and rejects missing fields', () => {
    const root = { workLog: [{ id: 'record', summary: '日本語' }] };
    expect(selectGoalValue(root, 'workLog.summary', 'record')).toBe('日本語');
    expect(goalValuePage('abcdef', { textOffset: 2, maxBytes: 4 })).toMatchObject({ content: 'cdef', offset: 2 });
    expect(goalValuePage(1, {})).toEqual({ value: 1 });
    expect(() => selectGoalValue(root, 'missing')).toThrow();
    expect(() => selectGoalValue(root, 'workLog', 'missing')).toThrow();
    expect(() => selectGoalValue({ status: 'created' }, 'status', 'record')).toThrow();
  });
  it('retains status in patrol and write projections', () => {
    expect(goalSummary(goalRecord())).toMatchObject({ id: goalRecord().id, status: 'created', workLogCount: 0 });
    expect(goalWriteSummary(goalRecord())).toMatchObject({ status: 'created', executionStatus: 'active' });
    expect(completionSummary(undefined)).toBeUndefined();
    expect(integrationSummary({ status: 'merged', goal: goalRecord() })).toMatchObject({ status: 'merged', goal: { status: 'created' } });
    expect(questionSummary({ id: 'q', body: '質問', status: 'pending', recipient: 'human' })).toMatchObject({ id: 'q', body: '質問' });
  });
  it('reports how much question text and how many options were omitted', () => {
    const text = '日本語'.repeat(1000);
    const result = questionSummary({ id: 'q', body: text, status: 'answered', recipient: 'human',
      options: [text, 'a', 'b', 'c'], recommendation: text,
      answer: { text, source: 'tui', answeredAt: '2026-10-14T00:00:00Z' } });
    expect(result).toMatchObject({ optionCount: 4, truncated: true });
    expect(result.optionCount - result.options!.length).toBe(1);
    expect(result.omissions.map(({ path }) => path)).toEqual(['body', 'options.0', 'recommendation', 'answer.text']);
    expect(result.omissions.every(({ path, totalBytes }) => {
      const value = selectGoalValue(result, path);
      return typeof value === 'string' && totalBytes - Buffer.byteLength(value) === 8745;
    })).toBe(true);
  });
  it('keeps original goal totals accurate when final output further shortens previews', () => {
    const text = '日本語'.repeat(3000);
    const goal = GoalSchema.parse({ ...goalRecord(), objective: text,
      workLog: [{ id: goalRecord().id, summary: text, recordedAt: '2026-10-14T00:00:00Z' }],
      questions: [{ id: goalRecord().id, body: text, recipient: 'human', status: 'pending' }],
      completion: { goalBranch: 'goal', goalSha: 'a'.repeat(40), targetBranch: 'main', summary: text,
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
        instructions: Array.from({ length: 50 }, () => '\u0000'.repeat(4096)),
        worktrees: Array.from({ length: 50 }, () => '\u0000'.repeat(4096)) },
    });
    const result = jsonResult({ goal: goalSummary(goal) });
    const output = JSON.parse(firstTextContent(result.content)).goal;
    expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    expect(Buffer.byteLength(output.objective)).toBe(63);
    expect(output.omissions.objective.totalBytes - Buffer.byteLength(output.objective)).toBe(26937);
    expect(output.workLog[0].summaryTotalBytes - Buffer.byteLength(output.workLog[0].summary)).toBe(26937);
    expect(output.questions[0].omissions[0].totalBytes - Buffer.byteLength(output.questions[0].body)).toBe(26937);
    expect(output.completion.omissions[0].totalBytes - Buffer.byteLength(output.completion.summary)).toBe(26937);
  });
});
