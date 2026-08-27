import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CompanionFinding } from '../../models/companion-types.js';
import type { CompanionReviewOutput } from './contracts.js';
import { appendPrivateFile, ensurePrivateDirectory } from '../../../shared/utils/private-file.js';

export const COMPANION_MAILBOX_DIRECTORY = 'companion';

export function appendCompanionMailboxFindings(input: {
  readonly path: string;
  readonly companionName: string;
  readonly reviewedAt: string;
  readonly reviewedDigest: string;
  readonly findings: CompanionReviewOutput['findings'];
}): CompanionFinding[] {
  const rows = input.findings.map((finding) => ({
    companion: input.companionName,
    reviewedAt: input.reviewedAt,
    reviewedDigest: input.reviewedDigest,
    ...finding,
  }));
  if (rows.length === 0) return rows;

  ensurePrivateDirectory(dirname(input.path));
  appendPrivateFile(
    input.path,
    rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
  );
  return rows;
}

export function buildCompanionMailboxPath(input: {
  cwd: string;
  /** Absolute run root supplied by the execution locator (central or local). */
  runRootDirectory?: string;
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
  /** Absolute run root supplied by the execution locator (central or local). */
  runRootDirectory?: string;
  runSlug: string;
  runPathNamespace: readonly string[];
  stepName: string;
}): string {
  assertSafeSegment(input.runSlug, 'run slug');
  assertSafeSegment(input.stepName, 'step name');
  for (const segment of input.runPathNamespace) assertSafeSegment(segment, 'run path namespace');
  const runRoot = input.runRootDirectory === undefined
    ? resolve(input.cwd, '.takt', 'runs', input.runSlug)
    : resolve(input.runRootDirectory);
  const root = resolve(runRoot, COMPANION_MAILBOX_DIRECTORY);
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
