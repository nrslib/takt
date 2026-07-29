import { describe, expect, it } from 'vitest';
import { createRoutingWorkFingerprint, normalizeRoutingWorkSnapshot } from '../core/workflow/auto-routing/normalizer.js';
import { ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY } from '../core/workflow/auto-routing/contracts.js';
import {
  buildRoutingFindings,
  buildRoutingWorkSnapshot,
} from '../core/workflow/auto-routing/snapshot.js';
import {
  authorizeFindingLedgerFixture,
  emptyFindingAuthorityProjection,
} from './helpers/finding-lifecycle-fixture.js';

describe('buildRoutingWorkSnapshot', () => {
  it('Given active task context, a team part, and finding contract entries, When building a routing snapshot, Then only routing work fields are projected', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Implement the requested feature',
      userInputs: ['Focus on the failing integration path'],
      step: {
        name: 'implement',
        tags: ['implementation'],
        personaKey: 'coder',
        instruction: 'Apply the requested change',
        stepType: 'agent',
        edit: true,
        passPreviousResponse: true,
      },
      part: {
        title: 'Fix the request validator',
        instruction: 'Update validation and its tests',
      },
      lastOutput: 'The validation branch remains incomplete.',
      findings: {
        open: [
          {
            id: 'F-1000',
            severity: 'high',
            lifecycle: 'persists',
            title: 'Validator rejects a valid request',
            description: 'A valid request is rejected in the validation branch.',
            suggestion: 'Correct the validation condition.',
            location: 'src/private.ts:4',
            reviewers: ['reviewer'],
            evidence: 'private source quote',
          },
        ],
        resolved: [
          {
            id: 'F-1001',
            severity: 'high',
            lifecycle: 'resolved',
            title: 'Already fixed',
            description: 'This must not be routed.',
          },
        ],
        conflicts: [
          {
            id: 'C-1000',
            status: 'active',
            description: 'The validator behavior remains disputed.',
          },
        ],
      },
    });

    expect(snapshot).toStrictEqual({
      goal: 'Implement the requested feature',
      step: {
        name: 'implement',
        tags: ['implementation'],
        personaKey: 'coder',
        instruction: 'Apply the requested change',
        stepType: 'agent',
        edit: true,
      },
      remainingWork: [
        {
          source: 'task',
          description: 'Focus on the failing integration path',
        },
        {
          source: 'team-part',
          title: 'Fix the request validator',
          description: 'Update validation and its tests',
        },
        {
          source: 'finding',
          severity: 'high',
          lifecycle: 'persists',
          title: 'Validator rejects a valid request',
          description: 'A valid request is rejected in the validation branch.',
          suggestion: 'Correct the validation condition.',
        },
        {
          source: 'finding',
          conflict: true,
          description: 'The validator behavior remains disputed.',
        },
        {
          source: 'prior-result',
          description: 'The validation branch remains incomplete.',
        },
      ],
      progress: {
        previousAttemptFailed: false,
        noProgress: false,
        retryingSameWork: false,
      },
    });
  });

  it('Given a step that does not receive a previous response, When building a routing snapshot, Then prior output does not become remaining work', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Review a change',
      userInputs: [],
      step: {
        name: 'review',
        tags: [],
        stepType: 'normal',
        edit: false,
        passPreviousResponse: false,
      },
      lastOutput: 'This output belongs to a previous step.',
      findings: { open: [], conflicts: [] },
    });

    expect(snapshot.remainingWork).toStrictEqual([]);
  });

  it('Given a provisional open finding, When building a routing snapshot, Then its system-finding status is retained without its stable ID', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Resolve a runtime failure',
      userInputs: [],
      step: {
        name: 'fix',
        tags: ['implementation'],
        stepType: 'normal',
        edit: true,
        passPreviousResponse: false,
      },
      findings: {
        open: [
          {
            id: 'F-1002',
            severity: 'critical',
            lifecycle: 'provisional',
            title: 'Recovery boundary is incomplete',
            description: 'The recovery boundary has an unresolved observation.',
            provisional: { kind: 'raw-meaning-ambiguous' },
          },
        ],
        conflicts: [],
      },
    });

    expect(snapshot.remainingWork).toStrictEqual([
      {
        source: 'finding',
        severity: 'critical',
        lifecycle: 'provisional',
        title: 'Recovery boundary is incomplete',
        description: 'The recovery boundary has an unresolved observation.',
        provisional: true,
      },
    ]);
  });

  it('projects a nullable provisional from the ledger using only its engine-issued reason', () => {
    const observedAt = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-30T00:00:00.000Z',
    };
    const ledger = authorizeFindingLedgerFixture({
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: observedAt.timestamp,
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        target: null,
        targetIdentityHash: null,
        claimIdentityHash: null,
        semanticClaimIdentityHash: null,
        severity: null,
        title: null,
        evidenceIds: [],
        reviewers: ['reviewer-a'],
        rawFindingIds: [],
        firstSeen: observedAt,
        lastSeen: observedAt,
        revision: 1,
        provisional: {
          kind: 'raw-meaning-ambiguous',
          stableKey: 'stable-nullable-routing',
          lineageKey: 'lineage-nullable-routing',
          sourceRawFindingIds: [],
          reason: 'The reviewer observation does not yet contain a complete claim.',
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          interpretationEpochs: 0,
          gateEffect: 'block',
          firstObservedRound: 1,
        },
      }],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    });

    expect([...buildRoutingFindings(ledger).open]).toEqual([{
      id: 'F-0001',
      lifecycle: 'new',
      description: 'The reviewer observation does not yet contain a complete claim.',
      provisional: true,
    }]);
  });

  it('Given identical current work, When building routing snapshots, Then the public builder input has no iteration values', () => {
    const commonInput = {
      goal: 'Apply a focused follow-up change',
      userInputs: [],
      step: {
        name: 'implement',
        tags: ['implementation'],
        stepType: 'normal' as const,
        edit: true,
        passPreviousResponse: false,
      },
      findings: { open: [], conflicts: [] },
    };

    const first = buildRoutingWorkSnapshot(commonInput);
    const later = buildRoutingWorkSnapshot(commonInput);

    expect(later).toStrictEqual(first);
  });

  it('Given more findings than the routing snapshot cap, When a finding body changes, Then the bounded projection and stable-work fingerprint are unchanged', () => {
    const createSnapshot = (tail: string) => buildRoutingWorkSnapshot({
      goal: 'Resolve all open findings',
      userInputs: [],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
      findings: {
        open: Array.from({ length: 100 }, (_, index) => ({
          id: `F-${index}`,
          description: index === 99 ? tail : `finding-${index}`,
        })),
        conflicts: [],
      },
    });
    const first = createSnapshot('tail-a');
    const replacement = createSnapshot('tail-b');

    expect(first.remainingWork).toHaveLength(64);
    expect(normalizeRoutingWorkSnapshot(first).remainingWorkOmittedCount).toBe(36);
    expect(createRoutingWorkFingerprint(replacement)).toBe(createRoutingWorkFingerprint(first));
  });

  it('Given a finding beyond the routing snapshot cap is replaced, When fingerprinting, Then the stable-work fingerprint changes', () => {
    const createSnapshot = (tailId: string) => buildRoutingWorkSnapshot({
      goal: 'Resolve all open findings',
      userInputs: [],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
      findings: {
        open: Array.from({ length: 100 }, (_, index) => ({
          id: index === 99 ? tailId : `F-${index}`,
          description: `finding-${index}`,
        })),
        conflicts: [],
      },
    });

    expect(createRoutingWorkFingerprint(createSnapshot('F-tail-a')))
      .not.toBe(createRoutingWorkFingerprint(createSnapshot('F-tail-b')));
  });

  it('Given the same finding and active-conflict sets in reverse order, When building snapshots, Then their local work fingerprints are unchanged', () => {
    const createSnapshot = (reverse: boolean) => buildRoutingWorkSnapshot({
      goal: 'Resolve the open findings',
      userInputs: [],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
      findings: {
        open: (reverse
          ? [{ id: 'F-2', description: 'Second finding.' }, { id: 'F-1', description: 'First finding.' }]
          : [{ id: 'F-1', description: 'First finding.' }, { id: 'F-2', description: 'Second finding.' }]),
        conflicts: (reverse
          ? [{ id: 'C-2', status: 'active', description: 'Second conflict.' }, { id: 'C-1', status: 'active', description: 'First conflict.' }]
          : [{ id: 'C-1', status: 'active', description: 'First conflict.' }, { id: 'C-2', status: 'active', description: 'Second conflict.' }]),
      },
    });

    expect(createRoutingWorkFingerprint(createSnapshot(true))).toBe(createRoutingWorkFingerprint(createSnapshot(false)));
  });

  it('Given a built routing snapshot, When a caller attempts a deep mutation, Then the snapshot and its local identity remain immutable', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Resolve the open finding',
      userInputs: [],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
      findings: { open: [{ id: 'F-1', description: 'Before.' }], conflicts: [] },
    });
    const fingerprint = createRoutingWorkFingerprint(snapshot);
    const localIdentity = snapshot[ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY];

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.step)).toBe(true);
    expect(Object.isFrozen(snapshot.step.tags)).toBe(true);
    expect(Object.isFrozen(snapshot.remainingWork)).toBe(true);
    expect(Object.isFrozen(snapshot.remainingWork[0])).toBe(true);
    expect(Object.isFrozen(localIdentity)).toBe(true);
    expect(() => {
      (snapshot.remainingWork[0] as { description: string }).description = 'After.';
    }).toThrow();
    expect(normalizeRoutingWorkSnapshot(snapshot).remainingWork[0]?.description).toBe('Before.');
    expect(createRoutingWorkFingerprint(snapshot)).toBe(fingerprint);
  });
});
