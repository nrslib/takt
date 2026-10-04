import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { PartResult } from '../../models/types.js';
import type { RunPaths } from '../run/run-paths.js';
import { REPORT_INTERNAL_NAMESPACE } from '../../models/reserved-report-names.js';
import { ensurePrivateDirectory, writePrivateFile } from '../../../shared/utils/private-file.js';
import { resolvePartErrorDetail } from './team-leader-common.js';
import { safeSegment } from './team-leader-artifacts.js';

/**
 * part 実行結果の feedback に載せる要約の最大文字数。
 * 3イテレーション目でリーダープロンプトが 288,890 トークンに積み上がり
 * モデル上限 262,144 を超過した実測に基づく有界化。レポートファイルへ
 * 全文を退避し、リーダーへは先頭約 2,000 文字だけ渡す。
 */
export const TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS = 2000;

export interface TeamLeaderPartReportPath {
  /** ファイルシステム上の絶対パス */
  readonly absolutePath: string;
}

export function buildTeamLeaderPartReportPath(input: {
  runPaths: RunPaths;
  stepName: string;
  partId: string;
}): TeamLeaderPartReportPath {
  const stepSegment = safeSegment(input.stepName);
  const partSegment = safeSegment(input.partId);
  const partHash = createHash('sha256').update(input.partId).digest('hex').slice(0, 8);
  const fileName = `part-${partSegment}-${partHash}.md`;
  const relativeDirectory = join(REPORT_INTERNAL_NAMESPACE, 'team-leader', stepSegment);
  const absolutePath = join(input.runPaths.reportsAbs, relativeDirectory, fileName);
  return { absolutePath };
}

export function writeTeamLeaderPartResultReport(input: {
  runPaths: RunPaths;
  stepName: string;
  result: PartResult;
}): TeamLeaderPartReportPath {
  const reportPath = buildTeamLeaderPartReportPath({
    runPaths: input.runPaths,
    stepName: input.stepName,
    partId: input.result.part.id,
  });
  ensurePrivateDirectory(dirname(reportPath.absolutePath));
  const content = buildTeamLeaderPartResultReportContent(input.result);
  writePrivateFile(reportPath.absolutePath, content);
  return reportPath;
}

function buildTeamLeaderPartResultReportContent(result: PartResult): string {
  const header = [
    `# part ${result.part.id}: ${result.part.title}`,
    '',
    `- status: ${result.response.status}`,
    ...(result.providerInfo !== undefined
      ? [`- provider: ${result.providerInfo.provider ?? 'unknown'}`, `- model: ${result.providerInfo.model ?? 'unknown'}`]
      : []),
    ...(result.durationMs !== undefined ? [`- durationMs: ${result.durationMs}`] : []),
    '',
  ].join('\n');
  if (result.response.status === 'error') {
    return `${header}## error\n\n${resolvePartErrorDetail(result)}\n`;
  }
  return `${header}## content\n\n${result.response.content}\n`;
}

/**
 * part 実行結果全文を feedback 用に有界化する。
 * 先頭を TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS 文字で切り、
 * 続きがある場合は末尾に省略断片を示す1行を付ける。
 */
export function summarizePartResultForFeedback(fullContent: string): string {
  const maxChars = TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS;
  if (fullContent.length <= maxChars) {
    return fullContent;
  }
  const notice = (omittedChars: number): string =>
    `\n\n[truncated: ${omittedChars} chars; see report file for full content]`;
  const bodyBudget = maxChars - notice(fullContent.length).length;
  const truncated = fullContent.slice(0, bodyBudget);
  return `${truncated}${notice(fullContent.length - truncated.length)}`;
}
