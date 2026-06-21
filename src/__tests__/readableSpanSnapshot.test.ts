import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { readableSpanSnapshot } from '../infra/observability/readableSpanSnapshot.js';

describe('readableSpanSnapshot', () => {
  it('copies name, attributes, startTime and endTime from the span', () => {
    const attributes = { 'takt.run.id': 'run-1', 'takt.step.name': 'implement' };
    const span = {
      name: 'step.implement',
      attributes,
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_205, 0],
    } as unknown as ReadableSpan;

    expect(readableSpanSnapshot(span)).toEqual({
      name: 'step.implement',
      attributes,
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_205, 0],
    });
  });

  it('passes the attributes object through by reference so processors read live values', () => {
    const attributes = { 'takt.run.id': 'run-1' };
    const span = { name: 'step.implement', attributes } as unknown as ReadableSpan;

    expect(readableSpanSnapshot(span).attributes).toBe(attributes);
  });

  it('preserves missing startTime and endTime as undefined', () => {
    const span = {
      name: 'step.implement',
      attributes: { 'takt.run.id': 'run-1' },
    } as unknown as ReadableSpan;

    const snapshot = readableSpanSnapshot(span);
    expect(snapshot.startTime).toBeUndefined();
    expect(snapshot.endTime).toBeUndefined();
  });
});
