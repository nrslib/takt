import { describe, expect, it } from 'vitest';
import {
  buildResumeReportConsumerKey,
  buildResumeReportConsumerKeyFromStack,
  classifyResumeReportConsumerKey,
} from '../core/workflow/run/resume-report-consumer.js';
import { makeWorkflowResumePointEntry } from './test-helpers.js';

describe('resume report consumer identity', () => {
  const outer = makeWorkflowResumePointEntry({ workflow: 'parent', workflow_ref: 'parent', step: 'delegate', kind: 'workflow_call', occurrence: 2, call_instance: 1 });
  const inner = makeWorkflowResumePointEntry({ workflow: 'child', workflow_ref: 'child', step: 'delegate', kind: 'workflow_call', occurrence: 3, call_instance: 1 });
  const active = makeWorkflowResumePointEntry({ workflow: 'leaf', workflow_ref: 'leaf', step: 'consume' });

  it('preserves every ancestor call instance independently of occurrence', () => {
    const key = buildResumeReportConsumerKeyFromStack([outer, inner, active])!;
    expect(classifyResumeReportConsumerKey(key)).toBe('valid');
    expect(JSON.parse(key).calls.map((call: { call_instance: number }) => call.call_instance)).toEqual([1, 1]);
    expect(buildResumeReportConsumerKeyFromStack([
      { ...outer, occurrence: 8 }, { ...inner, occurrence: 9 }, active,
    ])).toBe(key);
    expect(buildResumeReportConsumerKey('leaf', 'consume', [outer, inner])).toBe(key);
    for (const stack of [
      [{ ...outer, call_instance: 2 }, inner, active],
      [outer, { ...inner, call_instance: 2 }, active],
    ]) {
      expect(buildResumeReportConsumerKeyFromStack(stack)).not.toBe(key);
    }
  });

  it('keeps a root consumer valid and distinguishes its step', () => {
    const key = buildResumeReportConsumerKeyFromStack([active])!;
    expect(classifyResumeReportConsumerKey(key)).toBe('valid');
    expect(JSON.parse(key).calls).toEqual([]);
    expect(buildResumeReportConsumerKeyFromStack([{ ...active, step: 'other' }])).not.toBe(key);
    expect(buildResumeReportConsumerKeyFromStack([])).toBeUndefined();
  });

  it.each([0, -1, 1.5, '1', null])('rejects an invalid call instance %s', (callInstance) => {
    const key = JSON.stringify({ workflow: 'child', step: 'consume', calls: [{
      workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: callInstance,
    }] });
    expect(classifyResumeReportConsumerKey(key)).toBe('invalid');
  });

  it('classifies a saved key without call instances separately from malformed keys', () => {
    const call = { workflow: 'parent', step: 'delegate', kind: 'workflow_call' };
    expect(classifyResumeReportConsumerKey(JSON.stringify({ workflow: 'child', step: 'consume', calls: [call] }))).toBe('legacy');
    expect(classifyResumeReportConsumerKey(JSON.stringify({ workflow: 'child', step: 'consume', calls: [{ ...call, extra: true }] }))).toBe('invalid');
    expect(classifyResumeReportConsumerKey('{')).toBe('invalid');
  });
});
