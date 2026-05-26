import type { MorePartsResponse } from '../../../agents/agent-usecases.js';
import type { Language, PartDefinition, PartResult } from '../../models/types.js';
import { AGENT_FAILURE_CATEGORIES } from '../../../shared/types/agent-failure.js';
import {
  isTimeoutContinuationPartId,
  TIMEOUT_CONTINUATION_ID_PREFIX,
} from '../team-leader-continuation-ids.js';

export function createTimeoutContinuationFeedback(args: {
  partResults: PartResult[];
  scheduledIds: string[];
  remainingPartBudget: number;
  coveredTimedOutPartIds: ReadonlySet<string>;
  unfinishedScheduledPartCount: number;
  language?: Language;
}): MorePartsResponse | undefined {
  const timedOutPartIds = collectUncoveredPartTimeoutIds(args.partResults, args.coveredTimedOutPartIds);

  if (timedOutPartIds.length === 0 && canDeferTimeoutContinuationPlanning(args)) {
    return {
      done: false,
      reasoning: buildTimeoutContinuationDeferredReason(args.language),
      parts: [],
    };
  }

  if (timedOutPartIds.length === 0 && canFinishTimeoutContinuationPlanning(args)) {
    return {
      done: true,
      reasoning: buildTimeoutContinuationDoneReason(args.language),
      parts: [],
    };
  }

  if (!canCreateTimeoutContinuation(args.partResults, timedOutPartIds, args.remainingPartBudget)) {
    return undefined;
  }

  const continuationId = buildUnusedTimeoutContinuationId(args.scheduledIds);

  return {
    done: false,
    reasoning: buildTimeoutContinuationReason(args.language),
    parts: [buildTimeoutContinuationPart(timedOutPartIds, continuationId, args.language)],
  };
}

export function collectUncoveredPartTimeoutIds(
  partResults: PartResult[],
  coveredTimedOutPartIds: ReadonlySet<string>,
): string[] {
  return partResults
    .filter(isPartTimeoutResult)
    .map((result) => result.part.id)
    .filter((partId) => !isTimeoutContinuationPartId(partId))
    .filter((partId) => !coveredTimedOutPartIds.has(partId));
}

function canFinishTimeoutContinuationPlanning(args: {
  partResults: PartResult[];
  coveredTimedOutPartIds: ReadonlySet<string>;
  unfinishedScheduledPartCount: number;
}): boolean {
  return args.coveredTimedOutPartIds.size > 0
    && args.unfinishedScheduledPartCount === 0
    && !hasFailedTimeoutContinuationResult(args.partResults)
    && args.partResults.every(isSuccessfulOrPartTimeoutResult);
}

function canDeferTimeoutContinuationPlanning(args: {
  partResults: PartResult[];
  coveredTimedOutPartIds: ReadonlySet<string>;
  unfinishedScheduledPartCount: number;
}): boolean {
  return args.coveredTimedOutPartIds.size > 0
    && args.unfinishedScheduledPartCount > 0
    && !hasFailedTimeoutContinuationResult(args.partResults)
    && args.partResults.every(isSuccessfulOrPartTimeoutResult);
}

function canCreateTimeoutContinuation(
  partResults: PartResult[],
  timedOutPartIds: string[],
  remainingPartBudget: number,
): boolean {
  return remainingPartBudget > 0
    && timedOutPartIds.length > 0
    && !hasFailedTimeoutContinuationResult(partResults)
    && partResults.every(isSuccessfulOrPartTimeoutResult);
}

export function hasFailedTimeoutContinuationResult(partResults: PartResult[]): boolean {
  return partResults.some((result) => (
    isTimeoutContinuationPartId(result.part.id) && result.response.status === 'error'
  ));
}

function isSuccessfulOrPartTimeoutResult(result: PartResult): boolean {
  return result.response.status === 'done' || isPartTimeoutResult(result);
}

function isPartTimeoutResult(result: PartResult): boolean {
  return result.response.status === 'error'
    && result.response.failureCategory === AGENT_FAILURE_CATEGORIES.PART_TIMEOUT;
}

function buildUnusedTimeoutContinuationId(scheduledIds: string[]): string {
  const usedIds = new Set(scheduledIds);
  if (!usedIds.has(TIMEOUT_CONTINUATION_ID_PREFIX)) {
    return TIMEOUT_CONTINUATION_ID_PREFIX;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${TIMEOUT_CONTINUATION_ID_PREFIX}-${suffix}`;
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }
}

function buildTimeoutContinuationPart(
  timedOutPartIds: string[],
  continuationId: string,
  language?: Language,
): PartDefinition {
  return {
    id: continuationId,
    title: language === 'ja' ? 'タイムアウト後の継続実装' : 'Timeout continuation',
    instruction: buildTimeoutContinuationInstruction(timedOutPartIds, language),
  };
}

function buildTimeoutContinuationInstruction(timedOutPartIds: string[], language?: Language): string {
  const idList = timedOutPartIds.join(', ');
  if (language === 'ja') {
    return [
      'タイムアウトした part の継続作業を行ってください。',
      '',
      `対象 part: ${idList}`,
      '',
      '- 既存差分を破壊しない',
      '- タイムアウトした part の結果と現在の作業ツリーを確認する',
      '- 完了済みの作業はやり直さず、未完了作業だけを引き継ぐ',
      '- 実装に必要な最小範囲だけを変更する',
      '- 重い全体検証は、必要な場合のみ最終確認として実行する',
    ].join('\n');
  }

  return [
    'Continue the work from the timed-out part.',
    '',
    `Timed-out part: ${idList}`,
    '',
    '- Preserve existing changes',
    '- Inspect the timed-out part result and the current working tree',
    '- Do not redo completed work; carry over only unfinished work',
    '- Change only the minimum scope needed to complete the implementation',
    '- Run heavy full verification only as a final check when needed',
  ].join('\n');
}

function buildTimeoutContinuationReason(language?: Language): string {
  return language === 'ja'
    ? 'part_timeout 後に feedback が失敗したため、既存差分を引き継ぐ継続 part を作成します。'
    : 'Feedback failed after part_timeout, so create a continuation part that preserves existing changes.';
}

function buildTimeoutContinuationDoneReason(language?: Language): string {
  return language === 'ja'
    ? 'timeout 継続 part は既に実行済みのため、追加計画を終了します。'
    : 'The timeout continuation part has already run, so finish planning.';
}

function buildTimeoutContinuationDeferredReason(language?: Language): string {
  return language === 'ja'
    ? '未完了の scheduled part が残っているため、timeout 継続計画の完了判定を保留します。'
    : 'Scheduled parts are still unfinished, so defer finishing timeout continuation planning.';
}
