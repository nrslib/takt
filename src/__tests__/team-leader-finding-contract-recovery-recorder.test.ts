import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/utils/private-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/private-file.js')>();
  return {
    ...actual,
    writeNewPrivateFileWithMode: vi.fn(actual.writeNewPrivateFileWithMode),
  };
});

import {
  writeNewPrivateFileWithMode,
} from '../shared/utils/private-file.js';
import { buildRunPaths, type RunPaths } from '../core/workflow/run/run-paths.js';
import {
  buildTeamLeaderAttemptArtifactDirectory,
} from '../core/workflow/engine/team-leader-artifacts.js';
import {
  recordFindingContractRecoveryAttempt,
} from '../core/workflow/engine/team-leader-finding-contract-recovery-recorder.js';
import type {
  FindingContractRecoveryAttemptEvent,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';

interface RejectedDigest {
  readonly hash: string;
  readonly preview: string;
  readonly full: string;
}

let root: string;
let runPaths: RunPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'takt-recovery-recorder-'));
  runPaths = buildRunPaths(root, 'run-1');
  vi.mocked(writeNewPrivateFileWithMode).mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rejectedEvent(input: {
  raw: unknown;
  attemptToken?: string;
  envelopeAttemptToken?: string;
}): FindingContractRecoveryAttemptEvent<RejectedDigest> {
  const attemptToken = input.attemptToken ?? 'attempt-token-2';
  return {
    boundaryKind: 'decision',
    type: 'rejected',
    attempt: 2,
    attemptToken,
    mode: 'strict',
    strictReason: 'evidence_or_reference_issue',
    elapsedMs: 250,
    remainingMs: 1_000,
    envelope: {
      raw: input.raw,
      attemptToken: input.envelopeAttemptToken ?? attemptToken,
      sessionId: 'session-1',
    },
    rejectedOutput: {
      attempt: 2,
      mode: 'strict',
      issueFingerprint: 'issue-fingerprint',
      repeatCount: 2,
      issues: [{
        boundaryKind: 'decision',
        code: 'decision.invalid',
        category: 'decision_contract',
        path: 'decision',
        message: 'invalid decision',
        retryability: 'corrective_retry',
      }],
      outputDigest: {
        hash: 'validation-digest',
        preview: 'digest preview must not be audited',
        full: 'digest full value must not be audited',
      },
    },
  };
}

function attemptDirectory(): ReturnType<typeof buildTeamLeaderAttemptArtifactDirectory> {
  return buildTeamLeaderAttemptArtifactDirectory({
    runPaths,
    stepName: '../../fix',
    attemptId: '../../attempt',
  });
}

function auditPath(): string {
  return join(attemptDirectory().absoluteDirectory, 'finding-contract-recovery.jsonl');
}

function record(event: FindingContractRecoveryAttemptEvent<RejectedDigest>): void {
  recordFindingContractRecoveryAttempt({
    runPaths,
    stepName: '../../fix',
    attemptId: '../../attempt',
    boundaryId: '../../boundary',
    event,
  });
}

describe('Finding Contract recovery recorder', () => {
  it('stores rejected raw output as an atomic private artifact referenced by the audit record', () => {
    const secret = 'raw-secret-value';
    const raw = { decision: 'invalid', secret, nested: { complete: true } };

    record(rejectedEvent({ raw }));

    const auditText = readFileSync(auditPath(), 'utf8');
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain('digest preview must not be audited');
    expect(auditText).not.toContain('digest full value must not be audited');
    expect(auditText).not.toContain('"preview"');
    const audit = JSON.parse(auditText) as {
      boundaryId: string;
      attemptToken: string;
      rawOutputDigest?: unknown;
      rawOutputArtifact: { path: string; sha256: string; bytes: number };
      rejectedDecision: { outputDigest: Record<string, unknown> };
    };
    expect(audit.boundaryId).toBe('../../boundary');
    expect(audit.attemptToken).toBe('attempt-token-2');
    expect(audit.rawOutputDigest).toBeUndefined();
    expect(audit.rejectedDecision.outputDigest).toEqual({ hash: 'validation-digest' });

    const artifactPath = join(root, audit.rawOutputArtifact.path);
    const content = readFileSync(artifactPath, 'utf8');
    expect(JSON.parse(content)).toEqual(raw);
    expect(audit.rawOutputArtifact).toEqual({
      path: expect.stringMatching(/finding-contract-rejected-[a-f0-9]{64}\.json$/),
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    });
    if (process.platform !== 'win32') {
      expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    }
    expect(writeNewPrivateFileWithMode).toHaveBeenCalledWith(artifactPath, content, 0o600);
  });

  it('keeps traversal-shaped identifiers out of the artifact path', () => {
    record(rejectedEvent({
      raw: { decision: 'invalid' },
      attemptToken: '../../../../token',
      envelopeAttemptToken: '../../../../token',
    }));

    const audit = JSON.parse(readFileSync(auditPath(), 'utf8')) as {
      rawOutputArtifact: { path: string };
    };
    const artifactPath = resolve(root, audit.rawOutputArtifact.path);
    const expectedRoot = `${resolve(attemptDirectory().absoluteDirectory)}${sep}`;
    expect(artifactPath.startsWith(expectedRoot)).toBe(true);
    expect(audit.rawOutputArtifact.path).not.toContain('../../boundary');
    expect(audit.rawOutputArtifact.path).not.toContain('../../../../token');
  });

  it('fails before appending another audit record when the artifact name conflicts', () => {
    const event = rejectedEvent({ raw: { decision: 'invalid' } });
    record(event);

    expect(() => record(event)).toThrow('Private artifact file already exists');
    expect(readFileSync(auditPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('fails without an audit reference when private artifact publication fails', () => {
    vi.mocked(writeNewPrivateFileWithMode).mockImplementationOnce(() => {
      throw new Error('injected artifact write failure');
    });

    expect(() => record(rejectedEvent({ raw: { decision: 'invalid' } })))
      .toThrow('injected artifact write failure');
    expect(existsSync(auditPath())).toBe(false);
  });

  it('fails when the event and envelope attempt tokens do not match', () => {
    expect(() => record(rejectedEvent({
      raw: { decision: 'invalid' },
      attemptToken: 'event-token',
      envelopeAttemptToken: 'other-token',
    }))).toThrow('Finding Contract recovery event attempt token does not match its envelope');
    expect(existsSync(auditPath())).toBe(false);
  });

  it('preserves accepted and terminated audit metadata without embedding output previews', () => {
    const accepted: FindingContractRecoveryAttemptEvent<RejectedDigest> = {
      boundaryKind: 'decision',
      type: 'accepted',
      attempt: 3,
      attemptToken: 'accepted-token',
      mode: 'strict',
      strictReason: 'repeated_output',
      elapsedMs: 500,
      remainingMs: 750,
      envelope: {
        raw: { decision: 'complete', secret: 'accepted-raw-secret' },
        attemptToken: 'accepted-token',
        sessionId: 'session-accepted',
      },
      acceptedValue: { decision: 'complete', secret: 'accepted-value-secret' },
    };
    const terminated: FindingContractRecoveryAttemptEvent<RejectedDigest> = {
      boundaryKind: 'decision',
      type: 'terminated',
      attempt: 4,
      attemptToken: 'terminated-token',
      mode: 'strict',
      elapsedMs: 750,
      remainingMs: 0,
      terminationReason: 'deadline',
      terminationError: {
        name: 'FindingContractRecoveryDeadlineError',
        message: 'deadline reached',
      },
    };

    record(accepted);
    record(terminated);

    const auditText = readFileSync(auditPath(), 'utf8');
    expect(auditText).not.toContain('accepted-raw-secret');
    expect(auditText).not.toContain('accepted-value-secret');
    expect(auditText).not.toContain('"preview"');
    const records = auditText.trim().split('\n').map((line) => JSON.parse(line) as {
      type: string;
      rawOutputDigest?: { hash: string };
      normalizedOutputDigest?: { hash: string };
      sessionId?: string;
      terminationReason?: string;
      terminationError?: { name: string; message: string };
    });
    expect(records[0]).toEqual(expect.objectContaining({
      type: 'accepted',
      sessionId: 'session-accepted',
      rawOutputDigest: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      normalizedOutputDigest: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }));
    expect(records[1]).toEqual(expect.objectContaining({
      type: 'terminated',
      terminationReason: 'deadline',
      terminationError: {
        name: 'FindingContractRecoveryDeadlineError',
        message: 'deadline reached',
      },
    }));
    expect(writeNewPrivateFileWithMode).not.toHaveBeenCalled();
  });
});
