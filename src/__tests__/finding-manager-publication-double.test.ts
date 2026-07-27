import {
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  FindingLedger,
  FindingManagerValidationReport,
} from '../core/workflow/findings/types.js';
import { stagePendingManagerCommit } from '../core/workflow/findings/manager-pending-commit.js';
import { findingManagerValidationReportFileName } from '../core/workflow/findings/manager-report-content.js';
import {
  createFindingManagerPublicationDouble,
  RevisionedFindingLedgerTestRepository,
} from './helpers/finding-manager-publication.js';

function report(stepName: string, retryCount = 0): FindingManagerValidationReport {
  return {
    version: 1,
    runId: 'run-1',
    stepName,
    retryCount,
    ledgerUpdated: false,
    finalErrors: [],
    attempts: [],
  };
}

describe('Finding manager publication contract double', () => {
  let reportDir: string;

  beforeEach(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'takt-manager-publication-double-'));
  });

  afterEach(() => {
    rmSync(reportDir, { recursive: true, force: true });
  });

  async function publish(value: FindingManagerValidationReport) {
    const repository = new RevisionedFindingLedgerTestRepository({
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const publicationDouble = createFindingManagerPublicationDouble((current) => {
      const targetPath = join(
        reportDir,
        findingManagerValidationReportFileName(current),
      );
      writeFileSync(targetPath, JSON.stringify(current, null, 2));
      return targetPath;
    }, repository);
    const publication = publicationDouble.bindManagerValidationPublication(
      'round-1',
      publicationDouble.planManagerValidationPublication('round-1', value),
    );
    await publicationDouble.commitManagerLedger((ledger) => ({
      ledger: {
        ...ledger,
        stopBudget: {
          roundMarkers: ['round-1'],
          firstRoundAt: ledger.updatedAt,
          exhausted: false,
        },
      },
      publication: {
        roundMarker: 'round-1',
        report: value,
      },
      result: undefined,
    }));
    const receipt = publicationDouble.publishManagerValidationPublication(publication);
    return {
      publicationDouble,
      publication,
      receipt,
      repository,
      replacePending: async (
        replace: (
          pending: NonNullable<FindingLedger['pendingManagerCommit']>,
        ) => NonNullable<FindingLedger['pendingManagerCommit']>,
      ) => {
        const ledger = repository.loadLedger();
        const pending = ledger.pendingManagerCommit;
        if (pending === undefined) {
          throw new Error('Expected a pending manager commit');
        }
        repository.corruptStateForFixture({
          ...ledger,
          pendingManagerCommit: replace(pending),
        });
      },
    };
  }

  it.each([
    ['review team', 'findings-manager-validation.review-team.json'],
    ['reviewer 日本語 A', 'findings-manager-validation.reviewer-A.json'],
    ['review/security', 'findings-manager-validation.review-security.json'],
  ])('uses the shared report filename contract for %s', (stepName, expected) => {
    const repository = new RevisionedFindingLedgerTestRepository({
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const publicationDouble = createFindingManagerPublicationDouble(
      () => join(reportDir, expected),
      repository,
    );

    expect(publicationDouble.planManagerValidationPublication(
      'round-filename',
      report(stepName),
    ).fileName).toBe(expected);
  });

  it('rejects a step name that is empty after sanitization', () => {
    const repository = new RevisionedFindingLedgerTestRepository({
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const publicationDouble = createFindingManagerPublicationDouble(
      () => join(reportDir, 'unused.json'),
      repository,
    );

    expect(() => publicationDouble.planManagerValidationPublication(
      'round-empty',
      report(' 日本語 / '),
    )).toThrow(/step name/i);
  });

  it('rejects a publication planned for another test repository', () => {
    const ledger = {
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    } satisfies FindingLedger;
    const first = createFindingManagerPublicationDouble(
      () => join(reportDir, 'first.json'),
      new RevisionedFindingLedgerTestRepository(ledger),
    );
    const second = createFindingManagerPublicationDouble(
      () => join(reportDir, 'second.json'),
      new RevisionedFindingLedgerTestRepository(ledger),
    );
    const publication = first.planManagerValidationPublication(
      'round-repository',
      report('reviewers'),
    );

    expect(() => second.bindManagerValidationPublication(
      'round-repository',
      publication,
    )).toThrow(/Invalid test manager publication/);
  });

  it('rejects general mutation drift while a manager publication is pending', async () => {
    const { repository } = await publish(report('reviewers'));

    await expect(repository.updateLedger((ledger) => {
      const withoutPending = { ...ledger };
      delete withoutPending.pendingManagerCommit;
      return {
        ledger: {
          ...withoutPending,
          nextId: withoutPending.nextId + 1,
        },
        result: undefined,
      };
    })).rejects.toThrow(/pending.*dedicated finalization/i);
  });

  it('rejects pending creation and replacement through the general mutation API', async () => {
    const initial: FindingLedger = {
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    const repository = new RevisionedFindingLedgerTestRepository(initial);
    const publicationDouble = createFindingManagerPublicationDouble(
      () => join(reportDir, 'unused.json'),
      repository,
    );
    const value = report('reviewers');
    const publication = publicationDouble.planManagerValidationPublication(
      'round-1',
      value,
    );

    await expect(repository.updateLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: ['round-1'],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker: 'round-1',
        publication,
      }),
      result: undefined,
    }))).rejects.toThrow(/cannot be staged through the general mutation API/i);

    await publicationDouble.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          roundMarkers: ['round-1'],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      result: undefined,
      publication: {
        roundMarker: 'round-1',
        report: value,
      },
    }));
    await expect(repository.updateLedger((current) => ({
      ledger: {
        ...current,
        pendingManagerCommit: {
          ...current.pendingManagerCommit!,
          publication: {
            ...current.pendingManagerCommit!.publication,
            destinationRunId: 'forged-run',
          },
        },
      },
      result: undefined,
    }))).rejects.toThrow(/pending.*dedicated finalization/i);
  });

  it('isolates direct callback mutation from the test repository comparison baseline', async () => {
    const initial: FindingLedger = {
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    const repository = new RevisionedFindingLedgerTestRepository(initial);
    const publicationDouble = createFindingManagerPublicationDouble(
      () => join(reportDir, 'unused.json'),
      repository,
    );
    const value = report('reviewers');
    const publication = publicationDouble.planManagerValidationPublication(
      'round-1',
      value,
    );
    const staged = stagePendingManagerCommit({
      previousLedger: initial,
      completedLedger: {
        ...initial,
        stopBudget: {
          roundMarkers: ['round-1'],
          firstRoundAt: initial.updatedAt,
          exhausted: false,
        },
      },
      roundMarker: 'round-1',
      publication,
    });

    await expect(repository.updateLedger((current) => {
      current.pendingManagerCommit = staged.pendingManagerCommit;
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/cannot be staged through the general mutation API/i);

    await publicationDouble.commitManagerLedger(() => ({
      ledger: staged,
      result: undefined,
    }));

    await expect(repository.updateLedger((current) => {
      current.pendingManagerCommit!.publication.destinationRunId = 'forged-run';
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/pending.*dedicated finalization/i);

    await expect(repository.updateLedger((current) => {
      delete current.pendingManagerCommit;
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/pending.*dedicated finalization/i);

    await expect(repository.updateLedger(
      (current) => ({ ledger: current, result: undefined }),
      (current, mutation) => {
        delete current.pendingManagerCommit;
        mutation.ledger = current;
        return { mutation, publish: true };
      },
    )).rejects.toThrow(/pending.*dedicated finalization/i);

    await expect(publicationDouble.commitManagerLedger((current) => {
      delete current.pendingManagerCommit;
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/pending.*dedicated finalization/i);

    expect(repository.loadLedger()).toEqual(staged);
  });

  it('keeps clone-ineligible mutation results outside the callback clone boundary', async () => {
    const initial: FindingLedger = {
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    const repository = new RevisionedFindingLedgerTestRepository(initial);
    const result = (): string => 'not cloneable';

    const committed = await repository.updateLedger(
      (current) => ({ ledger: current, result }),
      (_current, mutation) => {
        expect(mutation.result).toBe(result);
        return { mutation, publish: true };
      },
    );

    expect(committed.result).toBe(result);
  });

  it('accepts a new round marker at its canonical sorted-set position', async () => {
    const initial: FindingLedger = {
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      stopBudget: {
        roundMarkers: ['z-round'],
        firstRoundAt: '2026-07-26T00:00:00.000Z',
        exhausted: false,
      },
    };
    const repository = new RevisionedFindingLedgerTestRepository(initial);
    const publicationDouble = createFindingManagerPublicationDouble(
      () => join(reportDir, 'findings-manager-validation.reviewers.json'),
      repository,
    );

    await publicationDouble.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          ...current.stopBudget!,
          roundMarkers: ['a-round', 'z-round'],
        },
      },
      publication: {
        roundMarker: 'a-round',
        report: report('reviewers'),
      },
      result: undefined,
    }));

    expect(
      repository.loadLedger().pendingManagerCommit?.completed.stopBudget
        ?.roundMarkers,
    ).toEqual([
      'a-round',
      'z-round',
    ]);
  });

  it('rejects forged fields on the dedicated manager commit boundary', async () => {
    const repository = new RevisionedFindingLedgerTestRepository({
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const publicationDouble = createFindingManagerPublicationDouble(
      () => join(reportDir, 'unused.json'),
      repository,
    );

    await expect(publicationDouble.commitManagerLedger((current) => ({
      ledger: current,
      result: undefined,
      publication: {
        roundMarker: 'round-1',
        report: report('reviewers'),
        domainId: 'forged',
      },
    } as never))).rejects.toThrow(/forged publication fields/i);
  });

  it('isolates corrupt-state fixtures from the normal mutation path', async () => {
    const initial: FindingLedger = {
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    const repository = new RevisionedFindingLedgerTestRepository(initial);
    repository.corruptStateForFixture({
      ...initial,
      nextId: 0,
    });

    await expect(repository.updateLedger((ledger) => ({
      ledger,
      result: undefined,
    }))).rejects.toThrow();
  });

  it.each([
    ['stopBudget', ['round-a', 'round-a']],
    ['reviewIntegrity', ['round-b', 'round-a']],
  ] as const)('rejects noncanonical %s.roundMarkers at the test repository load boundary', (
    field,
    roundMarkers,
  ) => {
    const initial: FindingLedger = {
      workflowName: 'test',
      nextId: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    const repository = new RevisionedFindingLedgerTestRepository(initial);
    repository.corruptStateForFixture({
      ...initial,
      [field]: {
        roundMarkers: [...roundMarkers],
        firstRoundAt: initial.updatedAt,
        exhausted: false,
      },
    });

    expect(() => repository.loadLedger()).toThrow(/binary-sorted unique set/);
  });

  it('rejects content tampering after publication', async () => {
    const { publicationDouble, publication, receipt } = await publish(report('reviewers'));
    writeFileSync(
      join(reportDir, publication.fileName),
      JSON.stringify(report('reviewers', 1), null, 2),
    );

    await expect(publicationDouble.finalizeManagerValidationPublication(
      publication,
      receipt,
    )).rejects.toThrow();
  });

  it('rejects replacement even when the replacement has the same content', async () => {
    const value = report('reviewers');
    const { publicationDouble, publication, receipt } = await publish(value);
    const replacement = join(reportDir, 'replacement.json');
    writeFileSync(replacement, JSON.stringify(value, null, 2));
    renameSync(replacement, join(reportDir, publication.fileName));

    await expect(publicationDouble.finalizeManagerValidationPublication(
      publication,
      receipt,
    )).rejects.toThrow();
  });

  it('rejects swapping published files between streams', async () => {
    const first = await publish(report('reviewers'));
    const second = await publish(report('security-reviewers'));
    const firstPath = join(reportDir, first.publication.fileName);
    const secondPath = join(reportDir, second.publication.fileName);
    const swapPath = join(reportDir, 'swap.json');
    renameSync(firstPath, swapPath);
    renameSync(secondPath, firstPath);
    renameSync(swapPath, secondPath);

    await expect(first.publicationDouble.finalizeManagerValidationPublication(
      first.publication,
      first.receipt,
    )).rejects.toThrow();
    await expect(second.publicationDouble.finalizeManagerValidationPublication(
      second.publication,
      second.receipt,
    )).rejects.toThrow();
  });

  it.each([
    {
      name: 'round marker',
      replace: (pending: NonNullable<FindingLedger['pendingManagerCommit']>) => ({
        ...pending,
        roundMarker: 'round-2',
      }),
    },
    {
      name: 'domain',
      replace: (pending: NonNullable<FindingLedger['pendingManagerCommit']>) => ({
        ...pending,
        publication: { ...pending.publication, domainId: 'd'.repeat(64) },
      }),
    },
    {
      name: 'origin',
      replace: (pending: NonNullable<FindingLedger['pendingManagerCommit']>) => ({
        ...pending,
        publication: { ...pending.publication, originRunId: 'run-2' },
      }),
    },
    {
      name: 'destination',
      replace: (pending: NonNullable<FindingLedger['pendingManagerCommit']>) => ({
        ...pending,
        publication: { ...pending.publication, destinationRunId: 'run-2' },
      }),
    },
    {
      name: 'file name',
      replace: (pending: NonNullable<FindingLedger['pendingManagerCommit']>) => ({
        ...pending,
        publication: { ...pending.publication, fileName: 'other.json' },
      }),
    },
    {
      name: 'content hash',
      replace: (pending: NonNullable<FindingLedger['pendingManagerCommit']>) => ({
        ...pending,
        publication: { ...pending.publication, contentSha256: 'e'.repeat(64) },
      }),
    },
    {
      name: 'report content',
      replace: (pending: NonNullable<FindingLedger['pendingManagerCommit']>) => ({
        ...pending,
        publication: {
          ...pending.publication,
          report: { ...pending.publication.report, retryCount: 1 },
        },
      }),
    },
  ])('rejects pending $name drift before finalization', async ({ replace }) => {
    const {
      publicationDouble,
      publication,
      receipt,
      replacePending,
    } = await publish(report('reviewers'));
    await replacePending(replace);

    await expect(publicationDouble.finalizeManagerValidationPublication(
      publication,
      receipt,
    )).rejects.toThrow(/publication|pending/i);
  });

  it('allows exactly one finalizer to commit a shared pending revision', async () => {
    const {
      publicationDouble,
      publication,
      receipt,
      repository,
    } = await publish(report('reviewers'));
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalize = async () => {
      ready += 1;
      await barrier;
      return publicationDouble.finalizeManagerValidationPublication(
        publication,
        receipt,
      );
    };
    const first = finalize();
    const second = finalize();
    expect(ready).toBe(2);
    release();

    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(repository.loadLedger().pendingManagerCommit).toBeUndefined();
    expect(repository.loadLedger().stopBudget?.roundMarkers).toEqual(['round-1']);
  });
});
