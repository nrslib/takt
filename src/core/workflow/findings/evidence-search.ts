import { readRegularFileNoFollow } from '../../../shared/utils/private-file.js';
import { decodeSourceUtf8 } from './source-quote.js';
import { resolveRealPathWithinProject } from './admission-validation.js';
import { FINDING_EVIDENCE_ISSUANCE_LIMITS } from '../../models/finding-contract-limits.js';
import type { RawFinding, ReviewerAnomalyEntry } from './types.js';
import type { RestatementRequestV1 } from './review-publication.js';
import { selectRestatementSourceClaimAtom } from './reviewer-anomalies.js';

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

interface EvidenceSearchWindow {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

function lineCount(lines: readonly string[]): number {
  return lines.length === 1 && lines[0] === '' ? 0 : lines.length;
}

function windowForFile(
  path: string,
  content: string,
  anchorLine: number | undefined,
): EvidenceSearchWindow {
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const totalLines = lineCount(lines);
  const maxLines = FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteLines;
  if (Buffer.byteLength(content, 'utf8') <= FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes) {
    return {
      path,
      startLine: 1,
      endLine: totalLines,
      content: lines.map((line, index) => `${index + 1}: ${line}`).join('\n'),
    };
  }
  const center = Math.min(Math.max(anchorLine ?? 1, 1), Math.max(totalLines, 1));
  let startLine = Math.max(1, center - Math.floor(maxLines / 2));
  const endLine = Math.min(totalLines, startLine + maxLines - 1);
  startLine = Math.max(1, endLine - maxLines + 1);
  const selectedLines: string[] = [];
  for (const line of lines.slice(startLine - 1, endLine)) {
    const candidate = [...selectedLines, line].join('\n');
    if (Buffer.byteLength(candidate, 'utf8') > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes) {
      break;
    }
    selectedLines.push(line);
  }
  const boundedEndLine = startLine + selectedLines.length - 1;
  return {
    path,
    startLine,
    endLine: boundedEndLine,
    content: selectedLines
      .map((line, index) => `${startLine + index}: ${line}`)
      .join('\n'),
  };
}

function readWindow(cwd: string, path: string, anchorLine: number | undefined): EvidenceSearchWindow | undefined {
  const resolution = resolveRealPathWithinProject(cwd, path);
  if (!resolution.ok || resolution.stat.size > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes) {
    return undefined;
  }
  try {
    const content = decodeSourceUtf8(readRegularFileNoFollow(resolution.realPath, resolution.stat));
    return windowForFile(path, content, anchorLine);
  } catch {
    return undefined;
  }
}

function anchorLineFor(raw: RawFinding, path: string): number | undefined {
  const quote = raw.evidence.find((evidence) => (
    evidence.kind === 'file_quote' && evidence.path === path
  ));
  return quote?.kind === 'file_quote' ? quote.startLine : undefined;
}

/**
 * エンジンが選んだ claim・要求履歴・実ファイル窓を、単発 normalizer の入力へ
 * まとめる。窓の行番号を本文へ付けるため、normalizer は source text を返さず
 * `file_quote` の path/range だけを提案できる。
 */
export function buildFindingEvidenceSearchRequest(input: {
  cwd: string;
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
  const windows = input.request.targetPaths.flatMap((path) => {
    const window = readWindow(input.cwd, path, anchorLineFor(input.sourceRaw, path));
    return window === undefined ? [] : [window];
  });
  const history = input.presentationHistory === undefined || input.presentationHistory.length === 0
    ? '(none)'
    : input.presentationHistory.join('\n');
  const renderedWindows = windows.length === 0
    ? '(target files could not be read; return rawFindings: [])'
    : boundRenderedWindows(windows);
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
    'Source windows (line numbers are part of the engine-provided context):',
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

function renderWindow(window: EvidenceSearchWindow): string {
  return `[FILE ${window.path} lines ${window.startLine}-${window.endLine}]\n${window.content}`;
}

function boundRenderedWindows(windows: readonly EvidenceSearchWindow[]): string {
  const rendered: string[] = [];
  let bytes = 0;
  for (const window of windows) {
    const next = renderWindow(window);
    const nextBytes = Buffer.byteLength(next, 'utf8') + (rendered.length === 0 ? 0 : 2);
    if (bytes + nextBytes > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxReviewerBytes) {
      break;
    }
    rendered.push(next);
    bytes += nextBytes;
  }
  return rendered.length === 0
    ? '(target windows exceed the evidence-search context limit; return rawFindings: [])'
    : rendered.join('\n\n');
}
