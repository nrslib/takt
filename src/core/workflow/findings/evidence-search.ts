import { decodeSourceUtf8 } from './source-quote.js';
import { FINDING_EVIDENCE_ISSUANCE_LIMITS } from '../../models/finding-contract-limits.js';
import type { RawFinding, ReviewerAnomalyEntry } from './types.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';
import type { RestatementRequestV1 } from './review-publication.js';
import { selectRestatementSourceClaimAtom } from './reviewer-anomalies.js';

const MAX_WINDOWS_PER_FILE = Math.floor(
  FINDING_EVIDENCE_ISSUANCE_LIMITS.maxReviewerBytes
    / FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes,
);

export interface FindingEvidenceSearchRequest {
  readonly ownerReviewerStepName: string;
  readonly request: RestatementRequestV1;
  readonly reportContent: string;
}

export function findingEvidenceSearchReportName(
  ownerReviewerStepName: string,
  anomalyId: string,
): string {
  return `evidence-search-${ownerReviewerStepName}-${anomalyId}`;
}

export interface FindingEvidenceSearchWindow {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

function lineCount(lines: readonly string[]): number {
  return lines.length === 1 && lines[0] === '' ? 0 : lines.length;
}

function renderLines(
  lines: readonly string[],
  startLine: number,
): string {
  return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

function windowForLines(
  path: string,
  lines: readonly string[],
  startLine: number,
): FindingEvidenceSearchWindow | undefined {
  const selectedLines: string[] = [];
  for (const line of lines) {
    const candidate = renderLines([...selectedLines, line], startLine);
    if (Buffer.byteLength(candidate, 'utf8') > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes) {
      break;
    }
    selectedLines.push(line);
  }
  if (selectedLines.length === 0) {
    return undefined;
  }
  return {
    path,
    startLine,
    endLine: startLine + selectedLines.length - 1,
    content: renderLines(selectedLines, startLine),
  };
}

function windowsForFile(
  path: string,
  content: string,
  anchorLine: number | undefined,
): readonly FindingEvidenceSearchWindow[] | undefined {
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const totalLines = lineCount(lines);
  if (Buffer.byteLength(content, 'utf8') <= FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes) {
    return [{
      path,
      startLine: 1,
      endLine: totalLines,
      content: renderLines(lines, 1),
    }];
  }

  const maxLines = FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteLines;
  if (anchorLine !== undefined) {
    const center = Math.min(Math.max(anchorLine, 1), Math.max(totalLines, 1));
    let startLine = Math.max(1, center - Math.floor(maxLines / 2));
    const endLine = Math.min(totalLines, startLine + maxLines - 1);
    startLine = Math.max(1, endLine - maxLines + 1);
    const window = windowForLines(path, lines.slice(startLine - 1, endLine), startLine);
    return window === undefined ? undefined : [window];
  }

  const windows: FindingEvidenceSearchWindow[] = [];
  let startLine = 1;
  while (startLine <= totalLines) {
    if (windows.length >= MAX_WINDOWS_PER_FILE) {
      return undefined;
    }
    const window = windowForLines(
      path,
      lines.slice(startLine - 1, startLine - 1 + maxLines),
      startLine,
    );
    if (window === undefined) {
      return undefined;
    }
    windows.push(window);
    startLine = window.endLine + 1;
  }
  return windows;
}

function snapshotWindow(
  snapshot: ReviewScopeProofSnapshot,
  path: string,
  anchorLine: number | undefined,
): readonly FindingEvidenceSearchWindow[] | undefined {
  const entry = snapshot.queryInventory.find((candidate) => candidate.path === path);
  if (
    entry === undefined
    || entry.kind !== 'file'
    || entry.coverage !== 'complete'
    || entry.content === undefined
    || entry.content.length > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes
  ) {
    return undefined;
  }
  try {
    return windowsForFile(path, decodeSourceUtf8(entry.content), anchorLine);
  } catch {
    return undefined;
  }
}

export function findingEvidenceAnchorLineFor(raw: RawFinding, path: string): number | undefined {
  const quote = raw.evidence.find((evidence) => (
    evidence.kind === 'file_quote' && evidence.path === path
  ));
  return quote?.kind === 'file_quote' ? quote.startLine : undefined;
}

/**
 * Immutable review-scope snapshot から、指定された target path の bounded window を作る。
 * 1 path でも snapshot から取得できなければ全体を unavailable とする。
 */
export function buildFindingEvidenceSearchWindows(input: {
  snapshot: ReviewScopeProofSnapshot;
  targetPaths: readonly string[];
  anchorLines?: ReadonlyMap<string, number | undefined>;
}): readonly FindingEvidenceSearchWindow[] {
  const windowsByPath = input.targetPaths.map((path) => (
    snapshotWindow(input.snapshot, path, input.anchorLines?.get(path))
  ));
  return windowsByPath.every((pathWindows) => pathWindows !== undefined)
    ? windowsByPath.flatMap((pathWindows) => pathWindows)
    : [];
}

/**
 * claim と request に対応する immutable snapshot の内容だけを normalizer へ渡す。
 * 現行ファイルを読み直さないことで、publication の evidence と同じ digest 束縛を
 * 維持する。元 quote が無い場合は全窓が context に収まるときだけ探索する。
 */
export function buildFindingEvidenceSearchRequest(input: {
  snapshot: ReviewScopeProofSnapshot;
  ownerReviewerStepName: string;
  anomaly: ReviewerAnomalyEntry;
  sourceRaw: RawFinding;
  request: RestatementRequestV1;
  presentationCount: number;
  presentationHistory?: readonly string[];
}): FindingEvidenceSearchRequest | undefined {
  const claim = selectRestatementSourceClaimAtom(input.anomaly, input.sourceRaw);
  if (claim === undefined) {
    return undefined;
  }
  const anchorLines = new Map(input.request.targetPaths.map((path) => (
    [path, findingEvidenceAnchorLineFor(input.sourceRaw, path)] as const
  )));
  // target path の一部だけを見せて候補を作ると、見えていないファイルについての
  // claim を誤って採用し得る。1ファイルでも snapshot 不在・窓数超過なら、全体を
  // unavailable として従来の null 候補へ倒す。
  const windows = buildFindingEvidenceSearchWindows({
    snapshot: input.snapshot,
    targetPaths: input.request.targetPaths,
    anchorLines,
  });
  const history = input.presentationHistory === undefined || input.presentationHistory.length === 0
    ? '(none)'
    : input.presentationHistory.join('\n');
  const renderedWindows = renderFindingEvidenceSearchWindows(windows);
  const reportContent = [
    'Evidence-search request (engine-provided source only)',
    `Anomaly ID: ${input.anomaly.id}`,
    `Owner reviewer: ${input.ownerReviewerStepName}`,
    `Restatement presentations already used: ${input.presentationCount}`,
    '',
    'Original claim (copy this exact block into candidate.description):',
    '<<<CLAIM>>>',
    claim,
    '<<<END CLAIM>>>',
    '',
    'Prior claimed excerpt/history:',
    input.anomaly.claimedExcerpt === undefined
      ? history
      : `${history}\nThe prior claim text is the original claim above and is intentionally not repeated.`,
    `Mismatch reason recorded by intake: ${input.anomaly.mismatchReason}`,
    '',
    'Target paths:',
    input.request.targetPaths.length === 0 ? '(none)' : input.request.targetPaths.join('\n'),
    '',
    `Source windows (snapshot ${input.snapshot.reviewScopeSnapshotId}; line numbers are engine-provided):`,
    renderedWindows,
    '',
    'Return one candidate only when a source window supports the original claim. The engine will materialize and byte-check any file_quote request.',
  ].join('\n');
  return {
    ownerReviewerStepName: input.ownerReviewerStepName,
    request: input.request,
    reportContent,
  };
}

function renderWindow(window: FindingEvidenceSearchWindow): string {
  return `[FILE ${window.path} lines ${window.startLine}-${window.endLine}]\n${window.content}`;
}

export function renderFindingEvidenceSearchWindows(
  windows: readonly FindingEvidenceSearchWindow[],
): string {
  if (windows.length === 0) {
    return '(target files are unavailable in the supplied snapshot; return rawFindings: [])';
  }
  const rendered: string[] = [];
  let bytes = 0;
  for (const window of windows) {
    const next = renderWindow(window);
    const nextBytes = Buffer.byteLength(next, 'utf8') + (rendered.length === 0 ? 0 : 2);
    if (bytes + nextBytes > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxReviewerBytes) {
      return '(target files exceed the evidence-search context limit; return rawFindings: [])';
    }
    rendered.push(next);
    bytes += nextBytes;
  }
  return rendered.join('\n\n');
}
