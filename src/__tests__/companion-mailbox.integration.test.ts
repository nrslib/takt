import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCompanionReviewResult,
  buildCompanionMailboxPath,
  loadCompanionMailbox,
} from '../core/workflow/companion/mailbox.js';
import {
  appendCompanionMailboxRecords,
  buildCompanionMailboxProjection,
} from '../core/workflow/companion/mailbox-projection.js';
import {
  CompanionReviewOutputSchema,
  type CompanionReviewOutput,
} from '../core/workflow/companion/contracts.js';
import type { CompanionLoopRound } from '../core/workflow/companion/loop-guard.js';
import { COMPANION_CUMULATIVE_LIMITS } from '../core/workflow/companion/limits.js';
import {
  CompanionReviewAuthority,
  CompanionReviewStateStore,
} from '../core/workflow/companion/review-state-store.js';

describe('CT-COMP-06 stateless review and append-only mailbox', () => {
  let root: string;
  let mailboxPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-companion-mailbox-'));
    mailboxPath = join(root, 'security-reviewer.jsonl');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should accept the documented structured review output', () => {
    expect(CompanionReviewOutputSchema.safeParse({
      findings: [{
        severity: 'must_fix',
        file: 'src/auth/login.ts',
        line: 42,
        finding: 'Plaintext password logging',
      }],
      updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
      notes: 'Recheck the logging branch next round.',
    }).success).toBe(true);
  });

  it('should reject unknown severities and unknown lifecycle statuses', () => {
    expect(CompanionReviewOutputSchema.safeParse({
      findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, finding: 'bad' }],
      updates: [],
    }).success).toBe(false);
    expect(CompanionReviewOutputSchema.safeParse({
      findings: [],
      updates: [{ id: 'security-reviewer-1', status: 'closed' }],
    }).success).toBe(false);
  });

  it('should assign IDs in the engine and append lifecycle updates as separate JSONL records', () => {
    const initial = loadCompanionMailbox(mailboxPath, 'security-reviewer');
    const first = applyCompanionReviewResult({
      companionName: 'security-reviewer',
      mailbox: initial,
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 3, finding: 'unsafe write' }],
        updates: [],
      },
    });
    const firstProjection = buildCompanionMailboxProjection('', first.records);
    appendCompanionMailboxRecords(mailboxPath, '', first.records);
    const second = applyCompanionReviewResult({
      companionName: 'security-reviewer',
      mailbox: first.mailbox,
      maxOpenMustFix: 5,
      result: {
        findings: [],
        updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
      },
    });
    appendCompanionMailboxRecords(mailboxPath, firstProjection, second.records);

    const lines = readFileSync(mailboxPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        id: 'security-reviewer-1',
        severity: 'must_fix',
        file: 'src/a.ts',
        line: 3,
        finding: 'unsafe write',
        status: 'open',
      },
      { id: 'security-reviewer-1', status: 'resolved' },
    ]);
    expect(loadCompanionMailbox(mailboxPath, 'security-reviewer').findings[0]?.status).toBe('resolved');
  });

  it('should continue ID allocation after reloading the same run and step mailbox', () => {
    appendCompanionMailboxRecords(mailboxPath, '', [{
      id: 'security-reviewer-1',
      severity: 'nit',
      file: 'src/a.ts',
      line: 1,
      finding: 'minor',
      status: 'open',
    }]);

    const mailbox = loadCompanionMailbox(mailboxPath, 'security-reviewer');
    const result = applyCompanionReviewResult({
      companionName: 'security-reviewer',
      mailbox,
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'should_fix', file: 'src/b.ts', line: 2, finding: 'improve' }],
        updates: [],
      },
    });

    expect(result.records[0]).toMatchObject({ id: 'security-reviewer-2' });
  });

  it('should reject a lifecycle update for an ID not owned by the mailbox', () => {
    const mailbox = loadCompanionMailbox(mailboxPath, 'security-reviewer');

    expect(() => applyCompanionReviewResult({
      companionName: 'security-reviewer',
      mailbox,
      maxOpenMustFix: 5,
      result: {
        findings: [],
        updates: [{ id: 'design-reviewer-1', status: 'resolved' }],
      },
    })).toThrow(/design-reviewer-1/);
  });

  it('should defer must_fix overflow while admitting lower severities without entering the fix gate', () => {
    const mailbox = loadCompanionMailbox(mailboxPath, 'security-reviewer');
    const result = applyCompanionReviewResult({
      companionName: 'security-reviewer',
      mailbox,
      maxOpenMustFix: 1,
      result: {
        findings: [
          { severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'first blocker' },
          { severity: 'must_fix', file: 'src/b.ts', line: 2, finding: 'overflow blocker' },
          { severity: 'should_fix', file: 'src/c.ts', line: 3, finding: 'later improvement' },
          { severity: 'nit', file: 'src/d.ts', line: 4, finding: 'minor style' },
        ],
        updates: [],
      },
    });

    expect(result.mailbox.openMustFixCount).toBe(1);
    expect(result.deferred).toEqual([
      expect.objectContaining({ finding: 'overflow blocker' }),
    ]);
    expect(result.records.map((record) => record.severity)).toEqual([
      'must_fix',
      'should_fix',
      'nit',
    ]);
  });

  it('should retain matching findings from different companions when no moderator is configured', () => {
    const designPath = join(root, 'design-reviewer.jsonl');
    const sharedFinding = {
      severity: 'should_fix' as const,
      file: 'src/a.ts',
      line: 5,
      finding: 'same reported issue',
    };
    const security = applyCompanionReviewResult({
      companionName: 'security-reviewer',
      mailbox: loadCompanionMailbox(mailboxPath, 'security-reviewer'),
      maxOpenMustFix: 5,
      result: { findings: [sharedFinding], updates: [] },
    });
    const design = applyCompanionReviewResult({
      companionName: 'design-reviewer',
      mailbox: loadCompanionMailbox(designPath, 'design-reviewer'),
      maxOpenMustFix: 5,
      result: { findings: [sharedFinding], updates: [] },
    });

    expect(security.records[0]).toMatchObject({ id: 'security-reviewer-1' });
    expect(design.records[0]).toMatchObject({ id: 'design-reviewer-1' });
  });

  it('should reject malformed, out-of-order, and unknown-update projection records', () => {
    writeFileSync(mailboxPath, [
      JSON.stringify({ id: 'security-reviewer-2', severity: 'must_fix', file: 'a', line: 1, finding: 'bad', status: 'open' }),
      JSON.stringify({ id: 'security-reviewer-1', status: 'resolved' }),
      '',
    ].join('\n'));

    expect(() => loadCompanionMailbox(mailboxPath, 'security-reviewer')).toThrow();
  });

  it('should reject an external projection change without changing authoritative state', () => {
    const store = new CompanionReviewStateStore();
    store.get(mailboxPath, 'security-reviewer');
    appendFileSync(mailboxPath, '{"forged":true}\n');

    expect(() => store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'unsafe' }],
        updates: [],
      },
    })).toThrow(/changed outside the engine/);

    expect(store.get(mailboxPath, 'security-reviewer').mailbox.findings).toEqual([]);
    expect(readFileSync(mailboxPath, 'utf8')).toBe('{"forged":true}\n');
  });

  it('should keep visible projection changes out of shared run authority after store recreation', () => {
    const authority = new CompanionReviewAuthority();
    const store = new CompanionReviewStateStore(authority);
    store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'unsafe' }],
        updates: [],
      },
    });
    appendFileSync(mailboxPath, `${JSON.stringify({ id: 'security-reviewer-1', status: 'resolved' })}\n`);

    expect(() => store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: { findings: [], updates: [] },
    })).toThrow(/changed outside the engine/);

    const recreated = new CompanionReviewStateStore(authority);
    expect(recreated.get(mailboxPath, 'security-reviewer').mailbox.openMustFixCount).toBe(1);
    expect(loadCompanionMailbox(mailboxPath, 'security-reviewer').openMustFixCount).toBe(0);
  });

  it('should preserve file, memory state, and numbering when append fails', () => {
    const store = new CompanionReviewStateStore();
    const blockedDirectory = join(root, 'blocked');
    const outside = join(root, 'outside');
    const blockedPath = join(blockedDirectory, 'security-reviewer.jsonl');
    mkdirSync(outside);
    const before = store.get(blockedPath, 'security-reviewer');
    symlinkSync(outside, blockedDirectory, 'dir');

    expect(() => store.apply({
      path: blockedPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'first' }],
        updates: [],
        notes: 'next notes',
      },
    })).toThrow(/symbolic link/);

    expect(store.get(blockedPath, 'security-reviewer')).toEqual(before);
    expect(existsSync(join(outside, 'security-reviewer.jsonl'))).toBe(false);

    unlinkSync(blockedDirectory);
    const retried = store.apply({
      path: blockedPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'first' }],
        updates: [],
        notes: 'next notes',
      },
    });

    expect(retried.records).toEqual([
      expect.objectContaining({ id: 'security-reviewer-1', finding: 'first' }),
    ]);
    expect(loadCompanionMailbox(blockedPath, 'security-reviewer').findings).toHaveLength(1);
  });

  it('should publish an update and deferred finding together only after a successful retry', () => {
    let rejectAppend = false;
    const append = vi.fn((path: string, currentProjection: string, records: readonly object[]) => {
      if (rejectAppend) throw new Error('injected append failure');
      return appendCompanionMailboxRecords(path, currentProjection, records);
    });
    const store = new CompanionReviewStateStore(
      new CompanionReviewAuthority(),
      { append },
    );
    store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 1,
      result: {
        findings: [
          { severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'first' },
          { severity: 'must_fix', file: 'src/b.ts', line: 2, finding: 'deferred' },
        ],
        updates: [],
      },
    });
    const before = store.get(mailboxPath, 'security-reviewer');
    const persistedBefore = readFileSync(mailboxPath, 'utf8');
    rejectAppend = true;

    expect(() => store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 1,
      result: {
        findings: [],
        updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
      },
    })).toThrow(/injected append failure/);

    expect(store.get(mailboxPath, 'security-reviewer')).toEqual(before);
    expect(readFileSync(mailboxPath, 'utf8')).toBe(persistedBefore);

    rejectAppend = false;
    const retried = store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 1,
      result: {
        findings: [],
        updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
      },
    });

    expect(retried.records).toEqual([
      { id: 'security-reviewer-1', status: 'resolved' },
      expect.objectContaining({ id: 'security-reviewer-2', finding: 'deferred' }),
    ]);
    expect(loadCompanionMailbox(mailboxPath, 'security-reviewer').findings).toEqual([
      expect.objectContaining({ id: 'security-reviewer-1', status: 'resolved' }),
      expect.objectContaining({ id: 'security-reviewer-2', status: 'open' }),
    ]);
  });

  it('should accept the mailbox finding limit and reject one finding above it on reload', () => {
    const records = Array.from(
      { length: COMPANION_CUMULATIVE_LIMITS.maxFindingsPerMailbox },
      (_, index) => ({
        id: `security-reviewer-${index + 1}`,
        severity: 'nit' as const,
        file: 'src/a.ts',
        line: 1,
        finding: `finding-${index}`,
        status: 'open' as const,
      }),
    );
    writeFileSync(mailboxPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

    expect(loadCompanionMailbox(mailboxPath, 'security-reviewer').findings).toHaveLength(
      COMPANION_CUMULATIVE_LIMITS.maxFindingsPerMailbox,
    );
    appendFileSync(mailboxPath, `${JSON.stringify({
      id: `security-reviewer-${records.length + 1}`,
      severity: 'nit',
      file: 'src/a.ts',
      line: 1,
      finding: 'overflow',
      status: 'open',
    })}\n`);

    expect(() => loadCompanionMailbox(mailboxPath, 'security-reviewer')).toThrow(
      /mailbox_findings/,
    );
  });

  it('should accept the mailbox record limit and reject one record above it on reload', () => {
    const records = [{
      id: 'security-reviewer-1',
      severity: 'nit',
      file: 'src/a.ts',
      line: 1,
      finding: 'finding',
      status: 'open',
    }, ...Array.from(
      { length: COMPANION_CUMULATIVE_LIMITS.maxRecordsPerMailbox - 1 },
      (_, index) => ({
        id: 'security-reviewer-1',
        status: index % 2 === 0 ? 'resolved' : 'unresolved',
      }),
    )];
    writeFileSync(mailboxPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

    expect(loadCompanionMailbox(mailboxPath, 'security-reviewer').findings).toHaveLength(1);
    appendFileSync(mailboxPath, `${JSON.stringify({
      id: 'security-reviewer-1',
      status: 'resolved',
    })}\n`);

    expect(() => loadCompanionMailbox(mailboxPath, 'security-reviewer')).toThrow(
      /mailbox_records/,
    );
  });

  it('should accept the projection byte limit and reject one byte above it before parsing', () => {
    const limit = COMPANION_CUMULATIVE_LIMITS.maxMailboxProjectionBytes;
    const records: string[] = [];
    let sequence = 1;
    while (true) {
      const prefix = JSON.stringify({
        id: `security-reviewer-${sequence}`,
        severity: 'nit',
        file: 'src/a.ts',
        line: 1,
        finding: '',
        status: 'open',
      });
      const overhead = Buffer.byteLength(prefix, 'utf8') + 1;
      const remaining = limit - Buffer.byteLength(records.join(''), 'utf8');
      const findingBytes = Math.min(16 * 1024, remaining - overhead);
      if (findingBytes < 1) break;
      records.push(`${prefix.replace('"finding":""', `"finding":"${'x'.repeat(findingBytes)}"`)}\n`);
      sequence += 1;
    }
    const projection = records.join('');
    expect(Buffer.byteLength(projection, 'utf8')).toBe(limit);
    writeFileSync(mailboxPath, projection);
    expect(() => loadCompanionMailbox(mailboxPath, 'security-reviewer')).not.toThrow();

    appendFileSync(mailboxPath, '\n');
    expect(() => loadCompanionMailbox(mailboxPath, 'security-reviewer')).toThrow(
      /mailbox_projection_bytes/,
    );
  });

  it('should re-inject deferred must_fix findings after an open slot becomes available', () => {
    const store = new CompanionReviewStateStore();
    const first = store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 1,
      result: {
        findings: [
          { severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'first' },
          { severity: 'must_fix', file: 'src/b.ts', line: 2, finding: 'deferred' },
        ],
        updates: [],
      },
    });
    expect(first.deferred).toHaveLength(1);

    const second = store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 1,
      result: { findings: [], updates: [{ id: 'security-reviewer-1', status: 'resolved' }] },
    });

    expect(second.deferred).toHaveLength(0);
    expect(second.records).toEqual([
      { id: 'security-reviewer-1', status: 'resolved' },
      expect.objectContaining({ id: 'security-reviewer-2', finding: 'deferred' }),
    ]);
  });

  it('should preserve deferred state when one finding exceeds its cumulative limit', () => {
    const store = new CompanionReviewStateStore();
    store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 0,
      result: {
        findings: Array.from(
          { length: COMPANION_CUMULATIVE_LIMITS.maxDeferredFindingsPerMailbox },
          (_, index) => ({
            severity: 'must_fix' as const,
            file: 'src/a.ts',
            line: index + 1,
            finding: `deferred-${index}`,
          }),
        ),
        updates: [],
      },
    });
    const before = store.get(mailboxPath, 'security-reviewer');

    expect(() => store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 0,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/b.ts', line: 1, finding: 'overflow' }],
        updates: [],
        notes: 'must not commit',
      },
    })).toThrow(/deferred_findings/);

    expect(store.get(mailboxPath, 'security-reviewer')).toEqual(before);
    expect(existsSync(mailboxPath)).toBe(false);
  });

  it('should persist each owner in an independent regular JSONL file', () => {
    const mailboxDirectory = join(root, 'mailboxes');
    const securityPath = join(mailboxDirectory, 'security-reviewer.jsonl');
    const designPath = join(mailboxDirectory, 'design-reviewer.jsonl');
    const store = new CompanionReviewStateStore();

    store.apply({
      path: securityPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'nit', file: 'src/a.ts', line: 1, finding: 'security' }],
        updates: [],
      },
    });
    store.apply({
      path: designPath,
      companionName: 'design-reviewer',
      maxOpenMustFix: 5,
      result: {
        findings: [{ severity: 'should_fix', file: 'src/b.ts', line: 2, finding: 'design' }],
        updates: [],
      },
    });

    expect(lstatSync(mailboxDirectory).isDirectory()).toBe(true);
    expect(lstatSync(mailboxDirectory).isSymbolicLink()).toBe(false);
    expect(readdirSync(mailboxDirectory).sort()).toEqual([
      'design-reviewer.jsonl',
      'security-reviewer.jsonl',
    ]);
    expect(lstatSync(securityPath).isFile()).toBe(true);
    expect(lstatSync(designPath).isFile()).toBe(true);
    expect(loadCompanionMailbox(securityPath, 'security-reviewer').findings).toEqual([
      expect.objectContaining({ id: 'security-reviewer-1', finding: 'security' }),
    ]);
    expect(loadCompanionMailbox(designPath, 'design-reviewer').findings).toEqual([
      expect.objectContaining({ id: 'design-reviewer-1', finding: 'design' }),
    ]);
    expect(readdirSync(root)).toEqual(['mailboxes']);
  });

  it('should isolate stored state from apply inputs and all returned projections', () => {
    const store = new CompanionReviewStateStore();
    const input: CompanionReviewOutput = {
      findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'original' }],
      updates: [],
      notes: 'original notes',
    };
    const applied = store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 5,
      result: input,
    });
    input.findings[0]!.finding = 'mutated input';
    (applied.mailbox.findings[0]! as { finding: string }).finding = 'mutated apply mailbox';
    const appliedRecord = applied.records[0];
    if (appliedRecord !== undefined && 'finding' in appliedRecord) {
      (appliedRecord as { finding: string }).finding = 'mutated apply record';
    }
    const exposed = store.get(mailboxPath, 'security-reviewer');
    (exposed.mailbox.findings[0]! as { finding: string }).finding = 'mutated get result';
    (exposed.deferred as CompanionReviewOutput['findings']).push({
      severity: 'nit',
      file: 'src/b.ts',
      line: 2,
      finding: 'mutated',
    });

    const stored = store.get(mailboxPath, 'security-reviewer');
    expect(stored.mailbox.findings[0]?.finding).toBe('original');
    expect(stored.notes).toBe('original notes');
    expect(stored.deferred).toEqual([]);
  });

  it('should isolate stored deferred findings from the apply result', () => {
    const store = new CompanionReviewStateStore();
    const applied = store.apply({
      path: mailboxPath,
      companionName: 'security-reviewer',
      maxOpenMustFix: 0,
      result: {
        findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'deferred' }],
        updates: [],
      },
    });

    (applied.deferred[0]! as { finding: string }).finding = 'mutated apply result';

    expect(store.get(mailboxPath, 'security-reviewer').deferred).toEqual([
      expect.objectContaining({ finding: 'deferred' }),
    ]);
  });

  it('should isolate stored loop history from round inputs and returned snapshots', () => {
    const store = new CompanionReviewStateStore();
    const round: CompanionLoopRound = {
      diffDigest: 'first',
      diffSummary: 'summary',
      openCount: 1,
      transitions: [{ id: 'security-reviewer-1', from: 'resolved', to: 'unresolved' }],
    };
    const first = store.recordRound('scope', round);
    (round.transitions[0]! as { id: string }).id = 'mutated input';
    (first.rounds[0]!.transitions[0]! as { id: string }).id = 'mutated result';
    (first.transitions['security-reviewer-1']! as { reopenCount: number }).reopenCount = 100;

    const second = store.recordRound('scope', {
      diffDigest: 'second',
      diffSummary: 'summary',
      openCount: 1,
      transitions: [{ id: 'security-reviewer-1', from: 'resolved', to: 'unresolved' }],
    });

    expect(second.rounds[0]?.transitions[0]?.id).toBe('security-reviewer-1');
    expect(second.transitions['security-reviewer-1']?.reopenCount).toBe(2);
  });

  it('should isolate recent fix rounds from returned history snapshots', () => {
    const store = new CompanionReviewStateStore();
    const first = store.recordRound('scope', {
      diffDigest: 'first',
      diffSummary: 'summary',
      openCount: 1,
      transitions: [],
      fixRound: 1,
    });
    (first.recentFixRounds[0]! as { diffDigest: string }).diffDigest = 'mutated result';

    const second = store.recordRound('scope', {
      diffDigest: 'second',
      diffSummary: 'summary',
      openCount: 1,
      transitions: [],
      fixRound: 2,
    });

    expect(second.recentFixRounds).toEqual([
      { sequence: 1, diffDigest: 'first', openCount: 1 },
      { sequence: 2, diffDigest: 'second', openCount: 1 },
    ]);
  });

  it.each(['../escape', '/absolute', 'nested/name', 'nested\\name'])(
    'should reject unsafe mailbox path segments: %s',
    (stepName) => {
      expect(() => buildCompanionMailboxPath({
        cwd: root,
        runSlug: 'run',
        runPathNamespace: [],
        stepName,
        companionName: 'security-reviewer',
      })).toThrow(/Invalid companion mailbox/);
    },
  );

  it('should reject a symlink inside the companion mailbox root', () => {
    const outside = join(root, 'outside');
    const companionRoot = join(root, '.takt', 'runs', 'run', 'companion');
    mkdirSync(outside, { recursive: true });
    mkdirSync(companionRoot, { recursive: true });
    symlinkSync(outside, join(companionRoot, 'implement'));
    const path = buildCompanionMailboxPath({
      cwd: root,
      runSlug: 'run',
      runPathNamespace: [],
      stepName: 'implement',
      companionName: 'security-reviewer',
    });

    expect(() => appendCompanionMailboxRecords(path, '', [])).toThrow(/symbolic link/);
  });

  it('should reject a symlink used as the .takt mailbox ancestor', () => {
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'runs'), { recursive: true });
    symlinkSync(outside, join(root, '.takt'));
    const path = buildCompanionMailboxPath({
      cwd: root,
      runSlug: 'run',
      runPathNamespace: [],
      stepName: 'implement',
      companionName: 'security-reviewer',
    });

    expect(() => appendCompanionMailboxRecords(path, '', [])).toThrow(/symbolic link/);
  });
});
