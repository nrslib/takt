import { describe, expect, it } from 'vitest';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';

describe('Phase1ExecutionLog', () => {
  it('keeps native structured decisions when text is empty and masks nested secrets', () => {
    const log = new Phase1ExecutionLog();
    log.recordResult({
      status: 'done',
      content: '',
      structuredOutput: {
        done: false,
        reasoning: 'Schedule another check',
        cancelPartIds: ['obsolete-part'],
        parts: [{ id: 'new-part', title: 'Inspect source', instruction: 'Read the current source' }],
        metadata: { token: 'synthetic-secret-123' },
      },
    });

    const entries = JSON.parse(log.toReportInput());
    expect(entries).toEqual([{
      kind: 'attempt_result', status: 'done', content: '',
      structuredOutput: {
        done: false,
        reasoning: 'Schedule another check',
        cancelPartIds: ['obsolete-part'],
        parts: [{ id: 'new-part', title: 'Inspect source', instruction: 'Read the current source' }],
        metadata: { token: '[REDACTED]' },
      },
    }]);
    expect(log.toReportInput()).not.toContain('synthetic-secret-123');
  });
});
