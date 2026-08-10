import { describe, expect, it } from 'vitest';
import {
  assertFindingRawObservationExactCover,
  FindingRawObservationExactCoverError,
} from '../core/workflow/findings/finding-raw-settlement.js';

const knownDestinations = new Map([
  ['finding', new Set(['F-0001'])],
  ['conflict', new Set(['C-0001'])],
  ['rejected-observation', new Set(['F-0001'])],
  ['reviewer-anomaly', new Set(['A-0001'])],
] as const);

describe('finding manager raw observation exact cover', () => {
  it('normalizes a reviewer anomaly landing with admission and task failures to one landing', () => {
    const summary = assertFindingRawObservationExactCover({
      expectedRawFindingIds: ['raw-anomaly'],
      settlements: [{
        sourceRawFindingIds: ['raw-anomaly'],
        destination: { kind: 'reviewer-anomaly', id: 'A-0001' },
      }],
      failures: [
        { rawFindingId: 'raw-anomaly', phase: 'manager-admission', reason: 'quote mismatch' },
        { rawFindingId: 'raw-anomaly', phase: 'manager-task:raw', reason: 'task rejected' },
      ],
      knownDestinationIds: knownDestinations,
    });

    expect(summary.settlements).toEqual([{
      rawFindingIds: ['raw-anomaly'],
      destination: { kind: 'reviewer-anomaly', id: 'A-0001' },
    }]);
    expect(summary.failures).toEqual([]);
  });

  it('keeps a true double landing as an exact-cover error', () => {
    expect(() => assertFindingRawObservationExactCover({
      expectedRawFindingIds: ['raw-duplicate'],
      settlements: [
        {
          rawFindingIds: ['raw-duplicate'],
          destination: { kind: 'finding', id: 'F-0001' },
        },
        {
          rawFindingIds: ['raw-duplicate'],
          destination: { kind: 'reviewer-anomaly', id: 'A-0001' },
        },
      ],
      failures: [],
      knownDestinationIds: knownDestinations,
    })).toThrow(FindingRawObservationExactCoverError);
  });

  it('deduplicates multiple explicit failures when no authoritative landing exists', () => {
    const summary = assertFindingRawObservationExactCover({
      expectedRawFindingIds: ['raw-failed'],
      settlements: [],
      failures: [
        { rawFindingId: 'raw-failed', phase: 'manager-admission', reason: 'invalid evidence' },
        { rawFindingId: 'raw-failed', phase: 'manager-task:raw', reason: 'task failed' },
      ],
    });

    expect(summary.failures).toEqual([{
      rawFindingId: 'raw-failed',
      phase: 'manager-admission',
      reason: 'invalid evidence',
    }]);
  });

  it('counts three raw findings at one landing and two at explicit failures', () => {
    const summary = assertFindingRawObservationExactCover({
      expectedRawFindingIds: ['raw-001', 'raw-002', 'raw-003', 'raw-004', 'raw-005'],
      settlements: [{
        rawFindingIds: ['raw-001', 'raw-002', 'raw-003'],
        destination: { kind: 'finding', id: 'F-0001' },
      }],
      failures: [
        { rawFindingId: 'raw-004', phase: 'manager-task:raw', reason: 'input overflow' },
        { rawFindingId: 'raw-005', phase: 'manager-admission', reason: 'invalid evidence' },
      ],
      knownDestinationIds: knownDestinations,
    });

    expect(summary.settlements).toEqual([{
      rawFindingIds: ['raw-001', 'raw-002', 'raw-003'],
      destination: { kind: 'finding', id: 'F-0001' },
    }]);
    expect(summary.failures.map((failure) => failure.rawFindingId))
      .toEqual(['raw-004', 'raw-005']);
  });

  it.each([
    {
      name: 'missing raw',
      input: {
        expectedRawFindingIds: ['raw-001'],
        settlements: [],
        failures: [],
      },
    },
    {
      name: 'duplicate in one landing',
      input: {
        expectedRawFindingIds: ['raw-001'],
        settlements: [{
          rawFindingIds: ['raw-001', 'raw-001'],
          destination: { kind: 'finding' as const, id: 'F-0001' },
        }],
        failures: [],
      },
    },
    {
      name: 'unknown raw',
      input: {
        expectedRawFindingIds: ['raw-001'],
        settlements: [{
          rawFindingIds: ['raw-999'],
          destination: { kind: 'finding' as const, id: 'F-0001' },
        }],
        failures: [],
      },
    },
    {
      name: 'mismatched landing destination',
      input: {
        expectedRawFindingIds: ['raw-001'],
        settlements: [{
          rawFindingIds: ['raw-001'],
          destination: { kind: 'finding' as const, id: 'F-9999' },
        }],
        failures: [],
      },
    },
  ])('hard-fails for $name', ({ input }) => {
    expect(() => assertFindingRawObservationExactCover({
      ...input,
      knownDestinationIds: knownDestinations,
    })).toThrow(FindingRawObservationExactCoverError);
  });

  it('normalizes provisional rawFindingIds and sourceRawFindingIds as one landing', () => {
    const summary = assertFindingRawObservationExactCover({
      expectedRawFindingIds: ['raw-001', 'raw-002'],
      settlements: [{
        rawFindingIds: ['raw-001'],
        sourceRawFindingIds: ['raw-001', 'raw-002'],
        destination: { kind: 'finding', id: 'F-0001' },
      }],
      failures: [],
      knownDestinationIds: knownDestinations,
    });

    expect(summary.settlements).toEqual([{
      rawFindingIds: ['raw-001', 'raw-002'],
      destination: { kind: 'finding', id: 'F-0001' },
    }]);
  });

  it('throws the engine invariant error directly rather than a provider failure', () => {
    try {
      assertFindingRawObservationExactCover({
        expectedRawFindingIds: ['raw-001'],
        settlements: [],
        failures: [],
      });
      throw new Error('test setup did not fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FindingRawObservationExactCoverError);
      expect((error as Error).message).not.toContain('provider failure');
    }
  });
});
