import { execFileSync } from 'node:child_process';
import { extname, posix, resolve } from 'node:path';
import { readRegularFileNoFollow } from '../../shared/utils/private-file.js';
import { isSensitiveProjectFilePath } from '../../shared/utils/sensitive-file-path.js';
import { assertPathSegmentsAreSafe } from '../../shared/utils/pathBoundary.js';
import { resolveReviewCompletionPath } from './review-completion-path.js';

const MAX_REFERENCE_SEEDS = 24;
const MAX_REFERENCE_CANDIDATES = 16;
const MAX_TRACKED_PATHS = 2048;
const MAX_TRACKED_PATH_LIST_BYTES = 4 * 1024 * 1024;
const MAX_SCANNED_SOURCE_BYTES = 8 * 1024 * 1024;

const REVIEWABLE_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.css', '.go', '.graphql', '.gql', '.h', '.hpp',
  '.html', '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.mjs', '.php', '.py', '.rb',
  '.rs', '.scss', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx', '.vue', '.xml', '.yaml',
  '.yml',
]);

const REVIEWABLE_SOURCE_FILE_NAMES = new Set([
  'dockerfile',
  'gemfile',
  'makefile',
  'package.json',
  'tsconfig.json',
]);

const GENERIC_REFERENCE_SEEDS = new Set([
  'config', 'context', 'data', 'default', 'error', 'handler', 'input', 'item', 'message',
  'options', 'output', 'params', 'request', 'response', 'result', 'return', 'source', 'state',
  'target', 'type', 'value',
]);

export type ReviewCompletionReferenceOmissionReason =
  | 'reference_binary_file'
  | 'reference_candidate_limit'
  | 'reference_discovery_unavailable'
  | 'reference_file_size_limit'
  | 'reference_file_unavailable'
  | 'reference_inventory_limit'
  | 'reference_scan_limit'
  | 'reference_seed_limit';

export type ReviewCompletionReferenceKind =
  | 'config_key'
  | 'declaration'
  | 'import_specifier'
  | 'module_name';

export interface ReviewCompletionReferenceEvidence {
  readonly path: string;
  readonly line: number;
  readonly relationKind: ReviewCompletionReferenceKind;
  readonly seed: string;
}

export interface ReviewCompletionReferenceDiscoveryResult {
  readonly references: readonly ReviewCompletionReferenceEvidence[];
  readonly omissions: ReadonlyMap<ReviewCompletionReferenceOmissionReason, number>;
}

export interface ReviewCompletionReferenceDiscoveryLimits {
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
}

interface ReferenceSeed {
  readonly value: string;
  readonly kind: ReviewCompletionReferenceKind;
}

type SourceReadResult =
  | { readonly kind: 'content'; readonly content: string }
  | { readonly kind: 'binary' }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'unavailable' };

function addOmission(
  counts: Map<ReviewCompletionReferenceOmissionReason, number>,
  reason: ReviewCompletionReferenceOmissionReason,
  count = 1,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + count);
}

function decodeNulPaths(content: Buffer): string[] {
  if (content.length === 0) return [];
  if (content.at(-1) !== 0) throw new Error('git ls-files output is not NUL terminated');
  const decoded = content.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(content)) {
    throw new Error('git ls-files output is not reversibly UTF-8 encoded');
  }
  return decoded.slice(0, -1).split('\0');
}

function trackedPaths(cwd: string): string[] {
  return decodeNulPaths(execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_TRACKED_PATH_LIST_BYTES,
  }));
}

function decodeUtf8(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  const decoded = content.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(content) ? decoded : undefined;
}

function isCanonicalRepositoryPath(path: string): boolean {
  return path.length > 0
    && !path.includes('\0')
    && !posix.isAbsolute(path)
    && path !== '.'
    && path !== '..'
    && !path.startsWith('../')
    && posix.normalize(path) === path;
}

function isReviewableSource(path: string): boolean {
  const lowerName = posix.basename(path).toLowerCase();
  return REVIEWABLE_SOURCE_FILE_NAMES.has(lowerName)
    || REVIEWABLE_SOURCE_EXTENSIONS.has(extname(lowerName));
}

function addSeed(
  seeds: Map<string, ReviewCompletionReferenceKind>,
  value: string,
  kind: ReviewCompletionReferenceKind,
): void {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 128) return;
  if (GENERIC_REFERENCE_SEEDS.has(trimmed.toLowerCase())) return;
  if (/\s|\0/.test(trimmed)) return;
  if (!seeds.has(trimmed)) seeds.set(trimmed, kind);
}

function extractSeeds(
  changedFiles: readonly { readonly path: string; readonly content: string }[],
  diff: string | undefined,
  omissions: Map<ReviewCompletionReferenceOmissionReason, number>,
): ReferenceSeed[] {
  const seeds = new Map<string, ReviewCompletionReferenceKind>();
  for (const file of changedFiles) {
    addSeed(seeds, posix.basename(file.path, posix.extname(file.path)), 'module_name');
  }
  const source = `${changedFiles.map(({ content }) => content).join('\n')}\n${diff ?? ''}`;
  const patterns: readonly [RegExp, ReviewCompletionReferenceKind][] = [
    [/\b(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, 'declaration'],
    [/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"\r\n]+)['"]/g, 'import_specifier'],
    [/(?:^|\n)[+\- ]*\s*["']?([A-Za-z_][\w.-]*)["']?\s*:/g, 'config_key'],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      addSeed(seeds, match[1] ?? '', kind);
    }
  }
  const bounded = [...seeds].slice(0, MAX_REFERENCE_SEEDS)
    .map(([value, kind]) => ({ value, kind }));
  if (seeds.size > bounded.length) {
    addOmission(omissions, 'reference_seed_limit', seeds.size - bounded.length);
  }
  return bounded;
}

interface CompiledReferenceSeed {
  readonly seed: ReferenceSeed;
  readonly pattern: RegExp;
}

function compileReferenceSeeds(seeds: readonly ReferenceSeed[]): CompiledReferenceSeed[] {
  return seeds.map((seed) => ({
    seed,
    pattern: new RegExp(
      `(^|[^A-Za-z0-9_$])${seed.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_$]|$)`,
    ),
  }));
}

function referenceMatch(
  path: string,
  lines: readonly string[],
  compiledSeed: CompiledReferenceSeed,
): ReviewCompletionReferenceEvidence | undefined {
  const lineIndex = lines.findIndex((line) => compiledSeed.pattern.test(line));
  if (lineIndex < 0) return undefined;
  return {
    path,
    line: lineIndex + 1,
    relationKind: compiledSeed.seed.kind,
    seed: compiledSeed.seed.value,
  };
}

function safelyReadSource(
  cwd: string,
  path: string,
  limits: ReviewCompletionReferenceDiscoveryLimits,
): SourceReadResult {
  if (!isCanonicalRepositoryPath(path)
    || Buffer.byteLength(path, 'utf8') > limits.maxPathBytes
    || isSensitiveProjectFilePath(path)
    || !isReviewableSource(path)) {
    return { kind: 'skip' };
  }
  try {
    const inspected = assertPathSegmentsAreSafe(
      cwd,
      resolve(cwd, path),
      (_violation, segmentPath) => new Error(`Unsafe review completion reference path: ${segmentPath}`),
    );
    if (inspected === null) return { kind: 'unavailable' };
    const resolution = resolveReviewCompletionPath(cwd, path);
    if (!resolution.ok) return { kind: 'unavailable' };
    if (resolution.stat.size > limits.maxFileBytes) return { kind: 'oversized' };
    const content = decodeUtf8(readRegularFileNoFollow(resolution.realPath, resolution.stat));
    return content === undefined ? { kind: 'binary' } : { kind: 'content', content };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Source content remains host-local. Returned seeds already occur in changed
 * evidence, so discovery does not create a new source-text disclosure channel.
 */
export function discoverReviewCompletionReferences(input: {
  readonly cwd: string;
  readonly changedFiles: readonly { readonly path: string; readonly content: string }[];
  readonly diff: string | undefined;
  readonly excludedPaths: ReadonlySet<string>;
  readonly limits: ReviewCompletionReferenceDiscoveryLimits;
}): ReviewCompletionReferenceDiscoveryResult {
  const omissions = new Map<ReviewCompletionReferenceOmissionReason, number>();
  const seeds = extractSeeds(input.changedFiles, input.diff, omissions);
  if (seeds.length === 0) return { references: [], omissions };
  const compiledSeeds = compileReferenceSeeds(seeds);

  let inventory: string[];
  try {
    inventory = trackedPaths(input.cwd);
  } catch {
    addOmission(omissions, 'reference_discovery_unavailable');
    return { references: [], omissions };
  }
  const candidates = inventory.filter((path) => (
    !input.excludedPaths.has(path)
    && isCanonicalRepositoryPath(path)
    && Buffer.byteLength(path, 'utf8') <= input.limits.maxPathBytes
    && !isSensitiveProjectFilePath(path)
    && isReviewableSource(path)
  ));
  const boundedInventory = candidates.slice(0, MAX_TRACKED_PATHS);
  if (candidates.length > boundedInventory.length) {
    addOmission(omissions, 'reference_inventory_limit', candidates.length - boundedInventory.length);
  }

  const references: ReviewCompletionReferenceEvidence[] = [];
  let scannedBytes = 0;
  for (const [index, path] of boundedInventory.entries()) {
    const source = safelyReadSource(input.cwd, path, input.limits);
    if (source.kind === 'skip') continue;
    if (source.kind === 'oversized') {
      addOmission(omissions, 'reference_file_size_limit');
      continue;
    }
    if (source.kind === 'binary') {
      addOmission(omissions, 'reference_binary_file');
      continue;
    }
    if (source.kind === 'unavailable') {
      addOmission(omissions, 'reference_file_unavailable');
      continue;
    }
    const bytes = Buffer.byteLength(source.content, 'utf8');
    if (scannedBytes + bytes > MAX_SCANNED_SOURCE_BYTES) {
      addOmission(omissions, 'reference_scan_limit', boundedInventory.length - index);
      break;
    }
    scannedBytes += bytes;
    const lines = source.content.split('\n');
    let reference: ReviewCompletionReferenceEvidence | undefined;
    for (const compiledSeed of compiledSeeds) {
      reference = referenceMatch(path, lines, compiledSeed);
      if (reference !== undefined) break;
    }
    if (reference === undefined) continue;
    if (references.length < MAX_REFERENCE_CANDIDATES) {
      references.push(reference);
    } else {
      addOmission(omissions, 'reference_candidate_limit');
    }
  }
  return { references, omissions };
}
