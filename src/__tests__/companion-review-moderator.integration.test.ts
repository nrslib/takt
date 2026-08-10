import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moderateCompanionResult } from '../core/workflow/companion/moderator.js';
import { executeCompanionReviewRound } from '../core/workflow/companion/review-round.js';
import { CompanionReviewStateStore } from '../core/workflow/companion/review-state-store.js';
import { COMPANION_CUMULATIVE_LIMITS } from '../core/workflow/companion/limits.js';
import { assertStrictStructuredOutputSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import {
  parseModeratorOutput,
  type CompanionReviewOutput,
} from '../core/workflow/companion/contracts.js';
import type { CompanionLoopRound } from '../core/workflow/companion/loop-guard.js';

const mailboxPublicationInjection = vi.hoisted(() => ({
  path: undefined as string | undefined,
  beforeGuard: undefined as (() => void) | undefined,
  failAfterGuard: false,
}));

function readEvidenceValue(prompt: string, label: string): unknown {
  for (const line of prompt.split('\n')) {
    if (!line.startsWith('{"label":')) continue;
    const envelope = JSON.parse(line) as { label?: unknown; value?: unknown };
    if (envelope.label === label) return envelope.value;
  }
  throw new Error(`Missing companion evidence label: ${label}`);
}

vi.mock('../shared/utils/private-file.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>(
    '../shared/utils/private-file.js',
  );
  return {
    ...actual,
    writePrivateFileWithModeGuarded(
      ...args: Parameters<typeof actual.writePrivateFileWithModeGuarded>
    ) {
      const [path, content, mode, publicationGuard] = args;
      return actual.writePrivateFileWithModeGuarded(path, content, mode, () => {
        if (mailboxPublicationInjection.path === path) {
          const beforeGuard = mailboxPublicationInjection.beforeGuard;
          mailboxPublicationInjection.beforeGuard = undefined;
          beforeGuard?.();
        }
        const result = publicationGuard();
        if (mailboxPublicationInjection.path === path && mailboxPublicationInjection.failAfterGuard) {
          mailboxPublicationInjection.path = undefined;
          mailboxPublicationInjection.failAfterGuard = false;
          throw new Error('injected mailbox publication failure');
        }
        return result;
      });
    },
  };
});

afterEach(() => {
  mailboxPublicationInjection.path = undefined;
  mailboxPublicationInjection.beforeGuard = undefined;
  mailboxPublicationInjection.failAfterGuard = false;
});

function createEvaluateRound() {
  return vi.fn(async (
    digest: string,
    diffSummary: string,
    implementerExplanation: string | undefined,
    transitions: CompanionLoopRound['transitions'],
  ) => ({
    historyScope: 'history',
    round: {
      diffDigest: digest,
      diffSummary,
      ...(implementerExplanation === undefined ? {} : { implementerExplanation }),
      openCount: 0,
      transitions,
    },
    decision: { decision: 'continue' as const },
  }));
}

describe('CT-COMP-10 companion review terminal lifecycle', () => {
  it.each([
    { moderatorName: undefined, actor: 'Companion "security-reviewer"' },
    { moderatorName: 'moderator', actor: 'Moderator "moderator"' },
  ])('should identify $actor when an update references an unknown finding', async ({ moderatorName, actor }) => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-unknown-update-'));
    try {
      await expect(executeCompanionReviewRound({
        companionName: 'security-reviewer',
        trigger: 'quiet',
        diff: {
          content: 'diff',
          digest: 'digest',
          changedLines: 1,
          changedFiles: ['src/a.ts'],
          fileFingerprints: {},
          hunkFingerprints: {},
          omittedBytes: 0,
          truncated: false,
        },
        observedGeneration: 1,
        changedRegionsSincePreviousReview: [],
        diffSummary: 'summary',
        signal: new AbortController().signal,
        task: 'task',
        stepName: 'implement',
        stepInstruction: 'implement',
        activeNames: ['security-reviewer'],
        ...(moderatorName === undefined ? {} : { moderatorName }),
        stateStore: new CompanionReviewStateStore(),
        mailboxPath: () => join(root, 'security-reviewer.jsonl'),
        systemPrompt: () => 'review',
        openFindings: () => [],
        callStructured: vi.fn(async (_purpose) => ({
          status: 'done' as const,
          content: '',
          structuredOutput: { findings: [], updates: [{ id: 'missing-1', status: 'resolved' }] },
        })),
        emitFinding: vi.fn(),
        markReviewed: vi.fn(),
        evaluateRound: createEvaluateRound(),
        applyRoundDecision: vi.fn(),
        onRoundCompleted: vi.fn(),
      })).rejects.toThrow(`${actor} references unknown companion finding "missing-1"`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['without moderator and without notes', false, false],
    ['without moderator and with notes', false, true],
    ['with moderator and without notes', true, false],
    ['with moderator and with notes', true, true],
  ])('should acknowledge an empty successful round once %s', async (_label, moderated, notes) => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-empty-round-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const markReviewed = vi.fn();
    const evaluateRound = createEvaluateRound();
    const callStructured = vi.fn(async () => ({
      persona: 'security-reviewer',
      status: 'done' as const,
      content: '',
      structuredOutput: { findings: [], updates: [], notes: notes ? 'context' : null },
      timestamp: new Date('2026-08-08T00:00:00.000Z'),
    }));

    try {
      await executeCompanionReviewRound({
        companionName: 'security-reviewer',
        trigger: 'quiet',
        diff: {
          content: 'diff',
          digest: 'digest',
          changedLines: 1,
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'fingerprint' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk' },
          omittedBytes: 0,
          truncated: false,
        },
        observedGeneration: 3,
        changedRegionsSincePreviousReview: ['src/a.ts:1-1'],
        diffSummary: 'summary',
        signal: new AbortController().signal,
        task: 'task',
        stepName: 'implement',
        stepInstruction: 'implement',
        activeNames: ['security-reviewer'],
        ...(moderated ? { moderatorName: 'moderator' } : {}),
        stateStore: new CompanionReviewStateStore(),
        mailboxPath: () => mailboxPath,
        systemPrompt: () => 'review',
        openFindings: () => [],
        callStructured,
        emitFinding: vi.fn(),
        markReviewed,
        evaluateRound,
        applyRoundDecision: vi.fn(),
        onRoundCompleted: vi.fn(),
      });

      expect(callStructured).toHaveBeenCalledOnce();
      expect(markReviewed).toHaveBeenCalledOnce();
      expect(evaluateRound).toHaveBeenCalledOnce();
      expect(existsSync(mailboxPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should return the findings accepted by this round instead of the mailbox open count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-finding-count-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    stateStore.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'should_fix', file: 'src/existing.ts', line: 1, finding: 'existing' }],
        updates: [],
      },
    });

    try {
      const result = await executeCompanionReviewRound({
        companionName: 'security-reviewer',
        trigger: 'quiet',
        diff: {
          content: 'diff',
          digest: 'digest',
          changedLines: 1,
          changedFiles: ['src/a.ts'],
          fileFingerprints: {},
          hunkFingerprints: {},
          omittedBytes: 0,
          truncated: false,
        },
        observedGeneration: 1,
        changedRegionsSincePreviousReview: [],
        diffSummary: 'summary',
        signal: new AbortController().signal,
        task: 'task',
        stepName: 'implement',
        stepInstruction: 'implement',
        activeNames: ['security-reviewer'],
        stateStore,
        mailboxPath: () => mailboxPath,
        systemPrompt: () => 'review',
        openFindings: () => stateStore.get(mailboxPath, 'security-reviewer').mailbox.findings,
        callStructured: vi.fn().mockResolvedValue({
          status: 'done',
          content: '',
          structuredOutput: {
            findings: [{ severity: 'nit', file: 'src/a.ts', line: 2, finding: 'new' }],
            updates: [],
            notes: null,
          },
        }),
        emitFinding: vi.fn(),
        markReviewed: vi.fn(),
        evaluateRound: createEvaluateRound(),
        applyRoundDecision: vi.fn(),
        onRoundCompleted: vi.fn(),
      });

      expect(result.findingCount).toBe(1);
      expect(stateStore.get(mailboxPath, 'security-reviewer').mailbox.findings).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should preserve mailbox bytes, state, numbering, and events when publication fails, then retry once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-commit-failure-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    const emitFinding = vi.fn();
    const markReviewed = vi.fn();
    const evaluateRound = createEvaluateRound();
    stateStore.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'should_fix', file: 'src/base.ts', line: 1, finding: 'existing' }],
        updates: [],
      },
    });
    const stateBefore = stateStore.get(mailboxPath, 'security-reviewer');
    const bytesBefore = readFileSync(mailboxPath);
    const callStructured = vi.fn().mockResolvedValue({
      persona: 'security-reviewer',
      status: 'done' as const,
      content: '',
      structuredOutput: {
        findings: [{ severity: 'must_fix' as const, file: 'src/a.ts', line: 1, finding: 'candidate' }],
        updates: [],
        notes: 'next',
      },
      timestamp: new Date('2026-08-08T00:00:00.000Z'),
    });
    const roundInput = {
      companionName: 'security-reviewer',
      trigger: 'quiet' as const,
      diff: {
        content: 'diff',
        digest: 'digest',
        changedLines: 1,
        changedFiles: ['src/a.ts'],
        fileFingerprints: { 'src/a.ts': 'fingerprint' },
        hunkFingerprints: { 'src/a.ts:1-1': 'hunk' },
        omittedBytes: 0,
        truncated: false,
      },
      observedGeneration: 1,
      changedRegionsSincePreviousReview: ['src/a.ts:1-1'],
      diffSummary: 'summary',
      signal: new AbortController().signal,
      task: 'task',
      stepName: 'implement',
      stepInstruction: 'implement',
      activeNames: ['security-reviewer'],
      stateStore,
      mailboxPath: () => mailboxPath,
      systemPrompt: () => 'review',
      openFindings: () => [],
      callStructured,
      emitFinding,
      markReviewed,
      evaluateRound,
      applyRoundDecision: vi.fn(),
      onRoundCompleted: vi.fn(),
    };
    mailboxPublicationInjection.path = mailboxPath;
    mailboxPublicationInjection.failAfterGuard = true;

    try {
      await expect(executeCompanionReviewRound(roundInput))
        .rejects.toThrow('injected mailbox publication failure');

      expect(readFileSync(mailboxPath)).toEqual(bytesBefore);
      expect(stateStore.get(mailboxPath, 'security-reviewer')).toEqual(stateBefore);
      expect(stateStore.get(mailboxPath, 'security-reviewer').mailbox.nextSequence).toBe(2);
      expect(emitFinding).not.toHaveBeenCalled();
      expect(evaluateRound).not.toHaveBeenCalled();
      expect(markReviewed).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual(['security-reviewer.jsonl']);

      await executeCompanionReviewRound(roundInput);

      expect(readFileSync(mailboxPath, 'utf8').trim().split('\n')).toHaveLength(2);
      expect(stateStore.get(mailboxPath, 'security-reviewer').mailbox.nextSequence).toBe(3);
      expect(emitFinding).toHaveBeenCalledOnce();
      expect(emitFinding).toHaveBeenCalledWith(
        'security-reviewer',
        'security-reviewer-2',
        'must_fix',
      );
      expect(callStructured).toHaveBeenCalledOnce();
      expect(evaluateRound).toHaveBeenCalledOnce();
      expect(markReviewed).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should reject a mailbox body change immediately before publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-publication-conflict-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    const emitFinding = vi.fn();
    stateStore.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'nit', file: 'src/base.ts', line: 1, finding: 'existing' }],
        updates: [],
      },
    });
    const stateBefore = stateStore.get(mailboxPath, 'security-reviewer');
    const bytesBefore = readFileSync(mailboxPath);
    const externalRecord = Buffer.from('{"external":true}\n');
    mailboxPublicationInjection.path = mailboxPath;
    mailboxPublicationInjection.beforeGuard = () => appendFileSync(mailboxPath, externalRecord);

    try {
      await expect(executeCompanionReviewRound({
        companionName: 'security-reviewer',
        trigger: 'quiet',
        diff: {
          content: 'diff',
          digest: 'digest',
          changedLines: 1,
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'fingerprint' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk' },
          omittedBytes: 0,
          truncated: false,
        },
        observedGeneration: 1,
        changedRegionsSincePreviousReview: ['src/a.ts:1-1'],
        diffSummary: 'summary',
        signal: new AbortController().signal,
        task: 'task',
        stepName: 'implement',
        stepInstruction: 'implement',
        activeNames: ['security-reviewer'],
        stateStore,
        mailboxPath: () => mailboxPath,
        systemPrompt: () => 'review',
        openFindings: () => [],
        callStructured: vi.fn().mockResolvedValue({
          persona: 'security-reviewer',
          status: 'done',
          content: '',
          structuredOutput: {
            findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
            updates: [],
            notes: null,
          },
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        }),
        emitFinding,
        markReviewed: vi.fn(),
        evaluateRound: createEvaluateRound(),
        applyRoundDecision: vi.fn(),
        onRoundCompleted: vi.fn(),
      })).rejects.toThrow(/changed outside the engine/);

      expect(readFileSync(mailboxPath)).toEqual(Buffer.concat([bytesBefore, externalRecord]));
      expect(stateStore.get(mailboxPath, 'security-reviewer')).toEqual(stateBefore);
      expect(emitFinding).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual(['security-reviewer.jsonl']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should retain a committed owner when a later owner write fails and retry only the failed change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-owner-transaction-'));
    const mailboxDirectory = join(root, 'mailboxes');
    const securityPath = join(mailboxDirectory, 'security-reviewer.jsonl');
    const designPath = join(mailboxDirectory, 'design-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    const emitFinding = vi.fn();
    const markReviewed = vi.fn();
    const evaluateRound = createEvaluateRound();
    stateStore.apply({
      path: designPath,
      companionName: 'design-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/b.ts', line: 2, finding: 'existing' }],
        updates: [],
      },
    });
    const designProjection = readFileSync(designPath);
    const callStructured = vi.fn(async (purpose: string) => {
      if (purpose === 'reviewer') {
        return {
          status: 'done' as const,
          content: '',
          structuredOutput: {
            findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
            updates: [{ id: 'design-reviewer-1', status: 'resolved' }],
            notes: null,
          },
        };
      }
      return {
        status: 'done' as const,
        content: '',
        structuredOutput: {
          findings: [{
            action: 'accept',
            sourceIndex: 0,
            severity: null,
            finding: null,
            targetId: null,
          }],
          updates: [{ id: 'design-reviewer-1', status: 'resolved' }],
        },
      };
    });
    const roundInput = {
      companionName: 'security-reviewer',
      trigger: 'quiet' as const,
      diff: {
        content: 'diff',
        digest: 'digest',
        changedLines: 1,
        changedFiles: ['src/a.ts'],
        fileFingerprints: { 'src/a.ts': 'fingerprint' },
        hunkFingerprints: { 'src/a.ts:1-1': 'hunk' },
        omittedBytes: 0,
        truncated: false,
      },
      observedGeneration: 1,
      changedRegionsSincePreviousReview: ['src/a.ts:1-1'],
      diffSummary: 'summary',
      signal: new AbortController().signal,
      task: 'task',
      stepName: 'implement',
      stepInstruction: 'implement',
      activeNames: ['security-reviewer', 'design-reviewer'],
      moderatorName: 'moderator',
      stateStore,
      mailboxPath: (name: string) => name === 'security-reviewer' ? securityPath : designPath,
      systemPrompt: () => 'review',
      openFindings: () => [
        ...stateStore.get(securityPath, 'security-reviewer').mailbox.findings,
        ...stateStore.get(designPath, 'design-reviewer').mailbox.findings,
      ],
      callStructured,
      emitFinding,
      markReviewed,
      evaluateRound,
      applyRoundDecision: vi.fn(),
      onRoundCompleted: vi.fn(),
    };
    mailboxPublicationInjection.path = designPath;
    mailboxPublicationInjection.failAfterGuard = true;

    try {
      await expect(executeCompanionReviewRound(roundInput))
        .rejects.toThrow('injected mailbox publication failure');

      expect(stateStore.get(securityPath, 'security-reviewer').mailbox.findings).toEqual([
        expect.objectContaining({ id: 'security-reviewer-1', status: 'open' }),
      ]);
      expect(stateStore.get(designPath, 'design-reviewer').mailbox.findings).toEqual([
        expect.objectContaining({ id: 'design-reviewer-1', status: 'open' }),
      ]);
      expect(readFileSync(securityPath, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readFileSync(designPath)).toEqual(designProjection);
      expect(emitFinding).toHaveBeenCalledOnce();
      expect(emitFinding).toHaveBeenCalledWith(
        'security-reviewer',
        'security-reviewer-1',
        'must_fix',
      );
      expect(evaluateRound).not.toHaveBeenCalled();
      expect(markReviewed).not.toHaveBeenCalled();

      await executeCompanionReviewRound(roundInput);

      expect(stateStore.get(securityPath, 'security-reviewer').mailbox.findings).toEqual([
        expect.objectContaining({ id: 'security-reviewer-1', status: 'open' }),
      ]);
      expect(stateStore.get(designPath, 'design-reviewer').mailbox.findings).toEqual([
        expect.objectContaining({ id: 'design-reviewer-1', status: 'resolved' }),
      ]);
      expect(readFileSync(securityPath, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readFileSync(designPath, 'utf8').trim().split('\n')).toHaveLength(2);
      const reloadedStore = new CompanionReviewStateStore();
      expect(reloadedStore.get(securityPath, 'security-reviewer').mailbox.findings).toEqual([
        expect.objectContaining({ id: 'security-reviewer-1', status: 'open' }),
      ]);
      expect(reloadedStore.get(designPath, 'design-reviewer').mailbox.findings).toEqual([
        expect.objectContaining({ id: 'design-reviewer-1', status: 'resolved' }),
      ]);
      expect(emitFinding).toHaveBeenCalledOnce();
      expect(evaluateRound).toHaveBeenCalledOnce();
      expect(markReviewed).toHaveBeenCalledOnce();
      expect(callStructured).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should route an update by the exact finding owner when owner names share a prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-owner-prefix-'));
    const shortOwner = 'reviewer';
    const longOwner = 'reviewer-extra';
    const shortPath = join(root, `${shortOwner}.jsonl`);
    const longPath = join(root, `${longOwner}.jsonl`);
    const stateStore = new CompanionReviewStateStore();
    for (const [ownerName, path] of [[shortOwner, shortPath], [longOwner, longPath]] as const) {
      stateStore.apply({
        path,
        companionName: ownerName,
        maxOpenMustFix: 5,
        result: {
          findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: ownerName }],
          updates: [],
        },
      });
    }

    try {
      await executeCompanionReviewRound({
        companionName: shortOwner,
        trigger: 'quiet',
        diff: {
          content: 'diff',
          digest: 'digest',
          changedLines: 1,
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'fingerprint' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk' },
          omittedBytes: 0,
          truncated: false,
        },
        observedGeneration: 1,
        changedRegionsSincePreviousReview: ['src/a.ts:1-1'],
        diffSummary: 'summary',
        signal: new AbortController().signal,
        task: 'task',
        stepName: 'implement',
        stepInstruction: 'implement',
        activeNames: [shortOwner, longOwner],
        moderatorName: 'moderator',
        stateStore,
        mailboxPath: (name) => name === shortOwner ? shortPath : longPath,
        systemPrompt: () => 'review',
        openFindings: () => [],
        callStructured: vi.fn(async (purpose) => ({
          status: 'done' as const,
          content: '',
          structuredOutput: purpose === 'reviewer'
            ? {
                findings: [],
                updates: [{ id: `${longOwner}-1`, status: 'resolved' }],
                notes: null,
              }
            : {
                findings: [],
                updates: [{ id: `${longOwner}-1`, status: 'resolved' }],
              },
        })),
        emitFinding: vi.fn(),
        markReviewed: vi.fn(),
        evaluateRound: createEvaluateRound(),
        applyRoundDecision: vi.fn(),
        onRoundCompleted: vi.fn(),
      });

      expect(stateStore.get(shortPath, shortOwner).mailbox.findings[0]?.status).toBe('open');
      expect(stateStore.get(longPath, longOwner).mailbox.findings[0]?.status).toBe('resolved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should reject oversized reviewer output before storage or later prompt injection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-oversized-review-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const markReviewed = vi.fn();
    const evaluateRound = createEvaluateRound();
    const stateStore = new CompanionReviewStateStore();
    const prompts: string[] = [];
    const callStructured = vi.fn(async (_purpose, _name, _systemPrompt, prompt) => {
      prompts.push(prompt);
      return {
        status: 'done' as const,
        content: '',
        structuredOutput: prompts.length === 1
          ? {
              findings: Array.from({ length: 51 }, (_, index) => ({
                severity: 'nit',
                file: 'src/a.ts',
                line: index + 1,
                finding: `oversized-finding-${index}`,
              })),
              updates: [],
              notes: 'oversized-notes',
            }
          : { findings: [], updates: [], notes: null },
      };
    });
    const roundInput = {
      companionName: 'security-reviewer',
      trigger: 'quiet' as const,
      diff: {
        content: 'diff',
        digest: 'digest',
        changedLines: 1,
        changedFiles: ['src/a.ts'],
        fileFingerprints: {},
        hunkFingerprints: {},
        omittedBytes: 0,
        truncated: false,
      },
      observedGeneration: 1,
      changedRegionsSincePreviousReview: [],
      diffSummary: 'summary',
      signal: new AbortController().signal,
      task: 'task',
      stepName: 'implement',
      stepInstruction: 'implement',
      activeNames: ['security-reviewer'],
      stateStore,
      mailboxPath: () => mailboxPath,
      systemPrompt: () => 'review',
      openFindings: () => [],
      callStructured,
      emitFinding: vi.fn(),
      markReviewed,
      evaluateRound,
      applyRoundDecision: vi.fn(),
      onRoundCompleted: vi.fn(),
    };

    try {
      await expect(executeCompanionReviewRound(roundInput)).rejects.toThrow(/item limit/);

      const stateAfterRejection = stateStore.get(mailboxPath, 'security-reviewer');
      expect(stateAfterRejection.mailbox.findings).toEqual([]);
      expect(stateAfterRejection.deferred).toEqual([]);
      expect(stateAfterRejection.notes).toBeUndefined();
      expect(existsSync(mailboxPath)).toBe(false);
      expect(markReviewed).not.toHaveBeenCalled();
      expect(evaluateRound).not.toHaveBeenCalled();

      await executeCompanionReviewRound(roundInput);

      expect(prompts[1]).not.toContain('oversized-finding-0');
      expect(prompts[1]).not.toContain('oversized-notes');
      expect(existsSync(mailboxPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should not commit or emit after the review signal aborts before response handling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-aborted-review-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const controller = new AbortController();
    const emitFinding = vi.fn();
    const markReviewed = vi.fn();
    const evaluateRound = createEvaluateRound();

    try {
      await expect(executeCompanionReviewRound({
        companionName: 'security-reviewer',
        trigger: 'quiet',
        diff: {
          content: 'diff',
          digest: 'digest',
          changedLines: 1,
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'fingerprint' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk' },
          omittedBytes: 0,
          truncated: false,
        },
        observedGeneration: 1,
        changedRegionsSincePreviousReview: ['src/a.ts:1-1'],
        diffSummary: '{"changedFiles":["src/a.ts"]}',
        implementerExplanation: 'I retained the branch because the API requires it.',
        signal: controller.signal,
        task: 'task',
        stepName: 'implement',
        stepInstruction: 'implement',
        activeNames: ['security-reviewer'],
        stateStore: new CompanionReviewStateStore(),
        mailboxPath: () => mailboxPath,
        systemPrompt: () => 'review',
        openFindings: () => [],
        callStructured: vi.fn(async () => {
          controller.abort();
          return {
            persona: 'security-reviewer',
            status: 'done',
            content: '',
            structuredOutput: { findings: [], updates: [], notes: '' },
            timestamp: new Date('2026-08-08T00:00:00.000Z'),
          };
        }),
        emitFinding,
        markReviewed,
        evaluateRound,
        applyRoundDecision: vi.fn(),
        onRoundCompleted: vi.fn(),
      })).rejects.toMatchObject({ name: 'AbortError' });

      expect(emitFinding).not.toHaveBeenCalled();
      expect(markReviewed).not.toHaveBeenCalled();
      expect(evaluateRound).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should pass the implementer explanation and diff summary through reviewer, moderator, and history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-context-review-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const calls: Array<{
      purpose: string;
      prompt: string;
      schema: Record<string, unknown>;
    }> = [];
    const evaluateRound = createEvaluateRound();

    try {
      await executeCompanionReviewRound({
        companionName: 'security-reviewer',
        trigger: 'quiet',
        diff: {
          content: 'diff',
          digest: 'digest',
          changedLines: 1,
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'fingerprint' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk' },
          omittedBytes: 0,
          truncated: false,
        },
        observedGeneration: 1,
        changedRegionsSincePreviousReview: ['src/a.ts:1-1'],
        diffSummary: '{"changedRegions":["src/a.ts:1-1"]}',
        implementerExplanation: 'The branch is required by the public API.',
        signal: new AbortController().signal,
        task: 'task',
        stepName: 'implement',
        stepInstruction: 'implement',
        activeNames: ['security-reviewer'],
        moderatorName: 'moderator',
        stateStore: new CompanionReviewStateStore(),
        mailboxPath: () => mailboxPath,
        systemPrompt: () => 'review',
        openFindings: () => [],
        callStructured: vi.fn(async (purpose, _name, _system, prompt, schema) => {
          calls.push({ purpose, prompt, schema });
          return {
            persona: purpose,
            status: 'done',
            content: '',
            structuredOutput: purpose === 'reviewer'
              ? {
                  findings: [{
                    severity: 'must_fix',
                    file: 'src/a.ts',
                    line: 1,
                    finding: 'candidate',
                  }],
                  updates: [],
                  notes: '',
                }
              : {
                  findings: [{ action: 'reject', sourceIndex: 0 }],
                  updates: [],
                },
            timestamp: new Date('2026-08-08T00:00:00.000Z'),
          };
        }),
        emitFinding: vi.fn(),
        markReviewed: vi.fn(),
        evaluateRound,
        applyRoundDecision: vi.fn(),
        onRoundCompleted: vi.fn(),
      });

      expect(calls[0]?.prompt).toContain('The branch is required by the public API.');
      expect(readEvidenceValue(calls[1]!.prompt, 'diff_summary'))
        .toBe('{"changedRegions":["src/a.ts:1-1"]}');
      expect(readEvidenceValue(calls[1]!.prompt, 'implementer_explanation'))
        .toBe('The branch is required by the public API.');
      expect(() => assertStrictStructuredOutputSchema(calls[0]!.schema)).not.toThrow();
      expect(() => assertStrictStructuredOutputSchema(calls[1]!.schema)).not.toThrow();
      expect(evaluateRound).toHaveBeenCalledWith(
        'digest',
        '{"changedRegions":["src/a.ts:1-1"]}',
        'The branch is required by the public API.',
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should not repeat persistence, numbering, or finding publication after an event failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-event-retry-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    const emitFinding = vi.fn(() => {
      throw new Error('injected event failure');
    });
    const markReviewed = vi.fn();
    const evaluateRound = createEvaluateRound();
    const callStructured = vi.fn().mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
        updates: [],
      },
    });
    const input = {
      companionName: 'security-reviewer',
      trigger: 'quiet' as const,
      diff: {
        content: 'diff',
        digest: 'digest',
        changedLines: 1,
        changedFiles: ['src/a.ts'],
        fileFingerprints: {},
        hunkFingerprints: {},
        omittedBytes: 0,
        truncated: false,
      },
      observedGeneration: 1,
      changedRegionsSincePreviousReview: [],
      diffSummary: 'summary',
      signal: new AbortController().signal,
      task: 'task',
      stepName: 'implement',
      stepInstruction: 'implement',
      activeNames: ['security-reviewer'],
      stateStore,
      mailboxPath: () => mailboxPath,
      systemPrompt: () => 'review',
      openFindings: () => [],
      callStructured,
      emitFinding,
      markReviewed,
      evaluateRound,
      applyRoundDecision: vi.fn(),
      onRoundCompleted: vi.fn(),
    };

    try {
      await expect(executeCompanionReviewRound(input)).rejects.toThrow(
        'injected event failure',
      );
      await executeCompanionReviewRound(input);

      expect(readFileSync(mailboxPath, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(stateStore.get(mailboxPath, 'security-reviewer').mailbox).toMatchObject({
        nextSequence: 2,
        findings: [expect.objectContaining({ id: 'security-reviewer-1' })],
      });
      expect(callStructured).toHaveBeenCalledOnce();
      expect(emitFinding).toHaveBeenCalledOnce();
      expect(evaluateRound).toHaveBeenCalledOnce();
      expect(markReviewed).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should resume after a post-round abort without repeating judge or history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-round-abort-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    const firstController = new AbortController();
    const evaluateRound = createEvaluateRound();
    const markReviewed = vi.fn();
    const callStructured = vi.fn().mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: { findings: [], updates: [] },
    });
    const base = {
      companionName: 'security-reviewer',
      trigger: 'quiet' as const,
      diff: {
        content: 'diff',
        digest: 'digest',
        changedLines: 1,
        changedFiles: ['src/a.ts'],
        fileFingerprints: {},
        hunkFingerprints: {},
        omittedBytes: 0,
        truncated: false,
      },
      observedGeneration: 1,
      changedRegionsSincePreviousReview: [],
      diffSummary: 'summary',
      task: 'task',
      stepName: 'implement',
      stepInstruction: 'implement',
      activeNames: ['security-reviewer'],
      stateStore,
      mailboxPath: () => mailboxPath,
      systemPrompt: () => 'review',
      openFindings: () => [],
      callStructured,
      emitFinding: vi.fn(),
      markReviewed,
      evaluateRound,
      onRoundCompleted: vi.fn(),
    };

    try {
      await expect(executeCompanionReviewRound({
        ...base,
        signal: firstController.signal,
        applyRoundDecision: () => firstController.abort(),
      })).rejects.toMatchObject({ name: 'AbortError' });
      await executeCompanionReviewRound({
        ...base,
        signal: new AbortController().signal,
        applyRoundDecision: vi.fn(),
      });

      expect(callStructured).toHaveBeenCalledOnce();
      expect(evaluateRound).toHaveBeenCalledOnce();
      expect(markReviewed).toHaveBeenCalledOnce();
      expect(stateStore.previewRound('history', {
        diffDigest: 'probe',
        diffSummary: '',
        openCount: 0,
        transitions: [],
      }).rounds).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should not duplicate transition history or reopen counts after a judge failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-judge-retry-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    stateStore.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
        updates: [],
      },
    });
    stateStore.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [],
        updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
      },
    });
    const observedReopenCounts: Array<number | undefined> = [];
    const evaluateRound = vi.fn(async (
      digest: string,
      diffSummary: string,
      implementerExplanation: string | undefined,
      transitions: CompanionLoopRound['transitions'],
    ) => {
      const round = {
        diffDigest: digest,
        diffSummary,
        ...(implementerExplanation === undefined ? {} : { implementerExplanation }),
        openCount: 1,
        transitions,
      };
      const preview = stateStore.previewRound('history', round);
      observedReopenCounts.push(preview.transitions['security-reviewer-1']?.reopenCount);
      if (observedReopenCounts.length === 1) throw new Error('injected judge failure');
      return {
        historyScope: 'history',
        round,
        decision: { decision: 'continue' as const },
      };
    });
    const callStructured = vi.fn().mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        findings: [],
        updates: [{ id: 'security-reviewer-1', status: 'unresolved' }],
      },
    });
    const input = {
      companionName: 'security-reviewer',
      trigger: 'quiet' as const,
      diff: {
        content: 'diff',
        digest: 'digest',
        changedLines: 1,
        changedFiles: ['src/a.ts'],
        fileFingerprints: {},
        hunkFingerprints: {},
        omittedBytes: 0,
        truncated: false,
      },
      observedGeneration: 1,
      changedRegionsSincePreviousReview: [],
      diffSummary: 'summary',
      signal: new AbortController().signal,
      task: 'task',
      stepName: 'implement',
      stepInstruction: 'implement',
      activeNames: ['security-reviewer'],
      stateStore,
      mailboxPath: () => mailboxPath,
      systemPrompt: () => 'review',
      openFindings: () => [],
      callStructured,
      emitFinding: vi.fn(),
      markReviewed: vi.fn(),
      evaluateRound,
      applyRoundDecision: vi.fn(),
      onRoundCompleted: vi.fn(),
    };

    try {
      await expect(executeCompanionReviewRound(input)).rejects.toThrow(
        'injected judge failure',
      );
      await executeCompanionReviewRound(input);

      expect(observedReopenCounts).toEqual([1, 1]);
      expect(stateStore.previewRound('history', {
        diffDigest: 'probe',
        diffSummary: '',
        openCount: 1,
        transitions: [],
      }).transitions['security-reviewer-1']?.reopenCount).toBe(1);
      expect(readFileSync(mailboxPath, 'utf8').trim().split('\n')).toHaveLength(3);
      expect(callStructured).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['different digest', 'current-digest', 1],
    ['different generation', 'pending-digest', 2],
    ['different digest and generation', 'current-digest', 2],
  ])('should consume the current snapshot after resuming a pending round with %s', async (
    _label,
    currentDigest,
    currentGeneration,
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-current-snapshot-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const stateStore = new CompanionReviewStateStore();
    const markReviewed = vi.fn();
    const onRoundCompleted = vi.fn();
    let evaluationAttempt = 0;
    const evaluateRound = vi.fn(async (
      digest: string,
      diffSummary: string,
      implementerExplanation: string | undefined,
      transitions: CompanionLoopRound['transitions'],
    ) => {
      evaluationAttempt += 1;
      if (evaluationAttempt === 1) throw new Error('injected judge failure');
      return {
        historyScope: 'history',
        round: {
          diffDigest: digest,
          diffSummary,
          ...(implementerExplanation === undefined ? {} : { implementerExplanation }),
          openCount: 0,
          transitions,
        },
        decision: { decision: 'continue' as const },
      };
    });
    const callStructured = vi.fn().mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: { findings: [], updates: [] },
    });
    const common = {
      companionName: 'security-reviewer',
      trigger: 'quiet' as const,
      changedRegionsSincePreviousReview: [],
      diffSummary: 'summary',
      signal: new AbortController().signal,
      task: 'task',
      stepName: 'implement',
      stepInstruction: 'implement',
      activeNames: ['security-reviewer'],
      stateStore,
      mailboxPath: () => mailboxPath,
      systemPrompt: () => 'review',
      openFindings: () => [],
      callStructured,
      emitFinding: vi.fn(),
      markReviewed,
      evaluateRound,
      applyRoundDecision: vi.fn(),
      onRoundCompleted,
    };
    const pendingDiff = {
      content: 'pending',
      digest: 'pending-digest',
      changedLines: 1,
      changedFiles: ['src/a.ts'],
      fileFingerprints: {},
      hunkFingerprints: {},
      omittedBytes: 0,
      truncated: false,
    };
    const currentDiff = { ...pendingDiff, content: 'current', digest: currentDigest };

    try {
      await expect(executeCompanionReviewRound({
        ...common,
        diff: pendingDiff,
        observedGeneration: 1,
      })).rejects.toThrow('injected judge failure');
      await executeCompanionReviewRound({
        ...common,
        diff: currentDiff,
        observedGeneration: currentGeneration,
      });

      expect(callStructured).toHaveBeenCalledTimes(2);
      expect(markReviewed).toHaveBeenNthCalledWith(1, pendingDiff, 1);
      expect(markReviewed).toHaveBeenNthCalledWith(2, currentDiff, currentGeneration);
      expect(onRoundCompleted).toHaveBeenNthCalledWith(1, {
        snapshot: pendingDiff,
        trigger: 'quiet',
        findingCount: 0,
      });
      expect(onRoundCompleted).toHaveBeenNthCalledWith(2, {
        snapshot: currentDiff,
        trigger: 'quiet',
        findingCount: 0,
      });
      expect(evaluateRound).toHaveBeenCalledTimes(3);
      expect(stateStore.previewRound('history', {
        diffDigest: 'probe',
        diffSummary: '',
        openCount: 0,
        transitions: [],
      }).rounds).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CT-COMP-07 moderator authority', () => {
  it('should call the moderator before committing non-empty reviewer output', async () => {
    const sequence: string[] = [];
    const runModerator = vi.fn(async () => {
      sequence.push('moderate');
      return {
        findings: [{
          action: 'downgrade' as const,
          sourceIndex: 0,
          severity: 'should_fix' as const,
          finding: 'accepted with lower severity',
        }],
        updates: [],
      };
    });
    const commit = vi.fn(async () => { sequence.push('commit'); });

    await moderateCompanionResult({
      reviewerResult: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
        updates: [],
      },
      openFindings: [],
      diffSummary: 'summary',
      runModerator,
      commit,
    });

    expect(sequence).toEqual(['moderate', 'commit']);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      findings: [expect.objectContaining({ severity: 'should_fix' })],
    }));
  });

  it('should accept one source finding unchanged and commit it exactly once', async () => {
    const source = {
      severity: 'must_fix' as const,
      file: 'src/a.ts',
      line: 7,
      finding: 'candidate',
    };
    const commit = vi.fn();

    await moderateCompanionResult({
      reviewerResult: { findings: [source], updates: [] },
      openFindings: [],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue(parseModeratorOutput({
        findings: [{
          action: 'accept',
          sourceIndex: 0,
          severity: null,
          finding: null,
          targetId: null,
        }],
        updates: [],
      })),
      commit,
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ findings: [source], updates: [] });
  });

  it.each([
    ['severity', 'should_fix', null],
    ['finding text', null, 'changed candidate'],
  ] as const)(
    'should reject accept with non-null %s before commit',
    async (_label, severity, finding) => {
      const commit = vi.fn();

      await expect(moderateCompanionResult({
        reviewerResult: {
          findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
          updates: [],
        },
        openFindings: [],
        diffSummary: 'summary',
        runModerator: vi.fn().mockResolvedValue(parseModeratorOutput({
          findings: [{
            action: 'accept',
            sourceIndex: 0,
            severity,
            finding,
            targetId: null,
          }],
          updates: [],
        })),
        commit,
      })).rejects.toThrow(/accept cannot override/);

      expect(commit).not.toHaveBeenCalled();
    },
  );

  it('should not call the moderator or writer for an empty reviewer round', async () => {
    const runModerator = vi.fn();
    const commit = vi.fn();

    await moderateCompanionResult({
      reviewerResult: { findings: [], updates: [] },
      openFindings: [],
      diffSummary: 'summary',
      runModerator,
      commit,
    });

    expect(runModerator).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('should commit only moderator-approved lifecycle updates', async () => {
    const commit = vi.fn();

    await moderateCompanionResult({
      reviewerResult: {
        findings: [],
        updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
      },
      openFindings: [{
        id: 'security-reviewer-1',
        severity: 'must_fix',
        file: 'src/a.ts',
        line: 1,
        finding: 'still unsafe',
        status: 'open',
      }],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue({ findings: [], updates: [] }),
      commit,
    });

    expect(commit).toHaveBeenCalledWith({ findings: [], updates: [] });
  });

  it('should merge into a known open target without creating a new finding', async () => {
    const commit = vi.fn();
    const target = {
      id: 'design-reviewer-1',
      severity: 'must_fix' as const,
      file: 'src/a.ts',
      line: 1,
      finding: 'existing',
      status: 'open' as const,
    };

    await moderateCompanionResult({
      reviewerResult: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 2, finding: 'duplicate' }],
        updates: [],
        notes: 'keep this context',
      },
      openFindings: [target],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue({
        findings: [{ action: 'merge', sourceIndex: 0, targetId: target.id }],
        updates: [],
      }),
      commit,
    });

    expect(commit).toHaveBeenCalledWith({
      findings: [],
      updates: [],
      notes: 'keep this context',
    });
  });

  it('should reject unknown source indexes and merge targets', async () => {
    const reviewerResult = {
      findings: [{ severity: 'must_fix' as const, file: 'src/a.ts', line: 1, finding: 'candidate' }],
      updates: [],
    };
    await expect(moderateCompanionResult({
      reviewerResult,
      openFindings: [],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue({
        findings: [{ action: 'reject', sourceIndex: 1 }],
        updates: [],
      }),
      commit: vi.fn(),
    })).rejects.toThrow(/unknown finding index/);
    await expect(moderateCompanionResult({
      reviewerResult,
      openFindings: [],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue({
        findings: [{ action: 'merge', sourceIndex: 0, targetId: 'unknown-1' }],
        updates: [],
      }),
      commit: vi.fn(),
    })).rejects.toThrow(/unknown merge target/);
  });

  it('should validate action-dependent moderator fields before commit', async () => {
    const commit = vi.fn();

    await expect(moderateCompanionResult({
      reviewerResult: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
        updates: [],
      },
      openFindings: [],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue({
        findings: [{
          action: 'reject',
          sourceIndex: 0,
          severity: 'nit',
        }],
        updates: [],
      }),
      commit,
    })).rejects.toThrow(/reject cannot override/);

    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ['missing severity', undefined],
    ['unchanged severity', 'should_fix'],
    ['higher severity', 'must_fix'],
  ] as const)('should reject a downgrade with %s before commit', async (_label, severity) => {
    const commit = vi.fn();

    await expect(moderateCompanionResult({
      reviewerResult: {
        findings: [{ severity: 'should_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
        updates: [],
      },
      openFindings: [],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue({
        findings: [{
          action: 'downgrade',
          sourceIndex: 0,
          ...(severity === undefined ? {} : { severity }),
        }],
        updates: [],
      }),
      commit,
    })).rejects.toThrow(/requires a lower severity/);

    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate', [{ action: 'reject' as const, sourceIndex: 0 }, { action: 'accept' as const, sourceIndex: 0 }]],
    ['missing', [{ action: 'reject' as const, sourceIndex: 0 }]],
    ['out of range', [{ action: 'reject' as const, sourceIndex: 0 }, { action: 'reject' as const, sourceIndex: 2 }]],
  ])('should reject %s moderator cardinality before commit', async (_label, findings) => {
    const commit = vi.fn();

    await expect(moderateCompanionResult({
      reviewerResult: {
        findings: [
          { severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'first' },
          { severity: 'should_fix', file: 'src/b.ts', line: 2, finding: 'second' },
        ],
        updates: [],
      },
      openFindings: [],
      diffSummary: 'summary',
      runModerator: vi.fn().mockResolvedValue({ findings, updates: [] }),
      commit,
    })).rejects.toThrow(/exactly once|more than once|unknown finding index/);

    expect(commit).not.toHaveBeenCalled();
  });

  it('should preserve mailbox state and numbering after invalid moderator cardinality', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-invalid-moderator-'));
    const mailboxPath = join(root, 'security-reviewer.jsonl');
    const store = new CompanionReviewStateStore();
    const commit = vi.fn(async (result: CompanionReviewOutput) => {
      store.apply({
        path: mailboxPath,
        companionName: 'security-reviewer',
        maxOpenMustFix: 5,
        result,
      });
    });

    try {
      await expect(moderateCompanionResult({
        reviewerResult: {
          findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
          updates: [],
        },
        openFindings: [],
        diffSummary: 'summary',
        runModerator: vi.fn().mockResolvedValue({
          findings: [
            { action: 'reject', sourceIndex: 0 },
            { action: 'accept', sourceIndex: 0 },
          ],
          updates: [],
        }),
        commit,
      })).rejects.toThrow(/more than once/);

      expect(commit).not.toHaveBeenCalled();
      expect(store.get(mailboxPath, 'security-reviewer').mailbox.findings).toEqual([]);
      expect(existsSync(mailboxPath)).toBe(false);
      const next = store.apply({
        path: mailboxPath,
        companionName: 'security-reviewer',
        maxOpenMustFix: 5,
        result: {
          findings: [{ severity: 'nit', file: 'src/b.ts', line: 2, finding: 'next' }],
          updates: [],
        },
      });
      expect(next.records[0]).toMatchObject({ id: 'security-reviewer-1' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
