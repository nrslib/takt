import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  CompanionFinding,
  CompanionFindingStatus,
} from '../../models/companion-types.js';
import type { CompanionReviewOutput } from './contracts.js';
import {
  assertCompanionCapacity,
  COMPANION_CUMULATIVE_LIMITS,
} from './limits.js';
import { readCompanionMailboxProjection } from './mailbox-projection.js';
import { assertCompanionOutputEnvelope } from './output-envelope.js';

export const COMPANION_MAILBOX_DIRECTORY = 'companion';

type CompanionMailboxRecord = CompanionFinding | {
  readonly id: string;
  readonly status: Exclude<CompanionFindingStatus, 'open'>;
};

const FindingRecordSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['must_fix', 'should_fix', 'nit']),
  file: z.string().min(1),
  line: z.number().int().positive(),
  finding: z.string().min(1),
  status: z.literal('open'),
}).strict();

const UpdateRecordSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['resolved', 'unresolved', 'wontfix_accepted']),
}).strict();

const MailboxRecordSchema = z.union([FindingRecordSchema, UpdateRecordSchema]);

export interface CompanionMailbox {
  readonly companionName: string;
  readonly findings: readonly CompanionFinding[];
  readonly openMustFixCount: number;
  readonly nextSequence: number;
}

function isOpen(status: CompanionFindingStatus): boolean {
  return status === 'open' || status === 'unresolved';
}

function projectMailbox(
  companionName: string,
  findings: ReadonlyMap<string, CompanionFinding>,
): CompanionMailbox {
  const values = [...findings.values()];
  const sequencePrefix = `${companionName}-`;
  const maxSequence = values.reduce((max, finding) => {
    const sequence = finding.id.startsWith(sequencePrefix)
      ? Number(finding.id.slice(sequencePrefix.length))
      : 0;
    return Number.isInteger(sequence) ? Math.max(max, sequence) : max;
  }, 0);
  return {
    companionName,
    findings: values,
    openMustFixCount: values.filter(
      (finding) => finding.severity === 'must_fix' && isOpen(finding.status),
    ).length,
    nextSequence: maxSequence + 1,
  };
}

function reduceRecords(
  companionName: string,
  records: readonly CompanionMailboxRecord[],
): CompanionMailbox {
  const findings = new Map<string, CompanionFinding>();
  let nextSequence = 1;
  for (const record of records) {
    if ('severity' in record) {
      const expectedId = `${companionName}-${nextSequence}`;
      if (record.id !== expectedId || findings.has(record.id)) {
        throw new Error(`Companion mailbox expected finding "${expectedId}" but received "${record.id}"`);
      }
      findings.set(record.id, { ...record });
      nextSequence += 1;
      continue;
    }
    const previous = findings.get(record.id);
    if (!previous) {
      throw new Error(`Companion mailbox update references unknown finding "${record.id}"`);
    }
    findings.set(record.id, { ...previous, status: record.status });
  }
  return projectMailbox(companionName, findings);
}

export function loadCompanionMailbox(path: string, companionName: string): CompanionMailbox {
  return loadCompanionMailboxState(path, companionName).mailbox;
}

export function loadCompanionMailboxState(
  path: string,
  companionName: string,
): { mailbox: CompanionMailbox; projection: string } {
  const projection = readCompanionMailboxProjection(path);
  if (projection.length === 0) {
    return { mailbox: projectMailbox(companionName, new Map()), projection };
  }
  const lines = projection
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assertCompanionCapacity(
    lines.length <= COMPANION_CUMULATIVE_LIMITS.maxRecordsPerMailbox,
    'mailbox_records',
  );
  const records = lines.map((line, index) => {
    try {
      const record = JSON.parse(line);
      assertCompanionOutputEnvelope(record);
      return MailboxRecordSchema.parse(record);
    } catch (error) {
      throw new Error(`Invalid companion mailbox record at line ${index + 1}`, { cause: error });
    }
  });
  const mailbox = reduceRecords(companionName, records);
  assertMailboxCapacity(mailbox, []);
  return { mailbox, projection };
}

export function applyCompanionReviewResult(input: {
  companionName: string;
  mailbox: CompanionMailbox;
  maxOpenMustFix: number;
  result: CompanionReviewOutput;
}): {
  mailbox: CompanionMailbox;
  records: CompanionMailboxRecord[];
  deferred: CompanionReviewOutput['findings'];
} {
  assertMailboxCapacity(input.mailbox, []);
  const findings = new Map(input.mailbox.findings.map((finding) => [finding.id, finding]));
  const records: CompanionMailboxRecord[] = [];
  for (const update of input.result.updates) {
    const previous = findings.get(update.id);
    if (!previous) {
      throw new Error(`Companion mailbox update references unknown finding "${update.id}"`);
    }
    const record = { id: update.id, status: update.status } as const;
    records.push(record);
    findings.set(update.id, { ...previous, status: update.status });
  }

  let nextSequence = input.mailbox.nextSequence;
  let openMustFixCount = [...findings.values()].filter(
    (finding) => finding.severity === 'must_fix' && isOpen(finding.status),
  ).length;
  const deferred: CompanionReviewOutput['findings'] = [];
  for (const finding of input.result.findings) {
    if (finding.severity === 'must_fix' && openMustFixCount >= input.maxOpenMustFix) {
      deferred.push(finding);
      continue;
    }
    const record: CompanionFinding = {
      id: `${input.companionName}-${nextSequence}`,
      ...finding,
      status: 'open',
    };
    nextSequence += 1;
    if (finding.severity === 'must_fix') openMustFixCount += 1;
    records.push(record);
    findings.set(record.id, record);
  }

  const mailbox = projectMailbox(input.companionName, findings);
  assertMailboxCapacity(mailbox, deferred);
  assertCompanionCapacity(
    records.length <= COMPANION_CUMULATIVE_LIMITS.maxRecordsPerMailbox,
    'mailbox_records',
  );
  return {
    mailbox,
    records,
    deferred,
  };
}

function assertMailboxCapacity(
  mailbox: CompanionMailbox,
  deferred: CompanionReviewOutput['findings'],
): void {
  assertCompanionCapacity(
    mailbox.findings.length <= COMPANION_CUMULATIVE_LIMITS.maxFindingsPerMailbox,
    'mailbox_findings',
  );
  assertCompanionCapacity(
    deferred.length <= COMPANION_CUMULATIVE_LIMITS.maxDeferredFindingsPerMailbox,
    'deferred_findings',
  );
}

export function buildCompanionMailboxPath(input: {
  cwd: string;
  runSlug: string;
  runPathNamespace: readonly string[];
  stepName: string;
  companionName: string;
}): string {
  assertSafeSegment(input.companionName, 'companion name');
  return join(
    buildCompanionMailboxDirectory(input),
    `${input.companionName}.jsonl`,
  );
}

export function buildCompanionMailboxDirectory(input: {
  cwd: string;
  runSlug: string;
  runPathNamespace: readonly string[];
  stepName: string;
}): string {
  assertSafeSegment(input.runSlug, 'run slug');
  assertSafeSegment(input.stepName, 'step name');
  for (const segment of input.runPathNamespace) assertSafeSegment(segment, 'run path namespace');
  const root = resolve(input.cwd, '.takt', 'runs', input.runSlug, COMPANION_MAILBOX_DIRECTORY);
  const directory = resolve(root, ...input.runPathNamespace, input.stepName);
  const fromRoot = relative(root, directory);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error('Companion mailbox path escapes its run root');
  }
  return directory;
}

function assertSafeSegment(value: string, label: string): void {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || isAbsolute(value)
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new Error(`Invalid companion mailbox ${label}: "${value}"`);
  }
}
