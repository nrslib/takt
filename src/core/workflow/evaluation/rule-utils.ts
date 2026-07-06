/**
 * Shared rule utility functions used by both engine.ts and instruction-builder.ts.
 */

import type { WorkflowState, WorkflowStep, WorkflowRule, OutputContractEntry } from '../../models/types.js';
import { evaluateWhenExpression } from './when-evaluator.js';
import { isEscapedQuote, isWhenConditionExpression, unwrapWhenConditionExpression } from '../../models/workflow-condition-expression.js';

// 決定的条件は when(<式>) の明示構文で宣言する（ai()/all()/any() と同形）。
// 裸の式をヒューリスティックで拾う旧方式は廃止: 比較演算子を含む散文が
// 誤って式扱いされる事故と、判定モデルによる「申告」の混入を構文で断つ。


export function isDeterministicCondition(condition: string): boolean {
  return isWhenConditionExpression(condition);
}

/** when(<式>) の内側の式を取り出す。when 形式以外は契約違反として throw する。 */
export function unwrapWhenCondition(condition: string): string {
  return unwrapWhenConditionExpression(condition);
}

export function isDeferredDeterministicCondition(condition: string): boolean {
  return isDeterministicCondition(condition) && unwrapWhenCondition(condition) === 'true';
}

function isReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9_.]/.test(char);
}

export function hasUnquotedFindingsReference(condition: string): boolean {
  let inString = false;

  for (let index = 0; index < condition.length; index++) {
    if (condition[index] === '"') {
      if (!isEscapedQuote(condition, index)) {
        inString = !inString;
      }
      continue;
    }
    if (inString || !condition.startsWith('findings.', index)) {
      continue;
    }
    if (isReferenceBoundary(condition[index - 1])) {
      return true;
    }
  }

  return false;
}

export function isFindingsCondition(condition: string): boolean {
  return isDeterministicCondition(condition) && hasUnquotedFindingsReference(unwrapWhenCondition(condition));
}

export function isNonAiReturnValueRule(rule: WorkflowRule, returnValue: string): boolean {
  return rule.isAiCondition !== true && rule.returnValue === returnValue;
}

export function isInvalidManagerOutputRule(rule: WorkflowRule): boolean {
  return isNonAiReturnValueRule(rule, 'need_replan')
    || isNonAiReturnValueRule(rule, 'needs_fix')
    || (rule.isAiCondition !== true && rule.next === 'fix');
}

/**
 * Check whether a step has tag-based rules (i.e., rules that require
 * [STEP:N] tag output for detection).
 *
 * Returns false when every rule can be resolved deterministically
 * or via explicit AI/aggregate handling without tag output.
 */
export function hasTagBasedRules(step: WorkflowStep): boolean {
  if (!step.rules || step.rules.length === 0) return false;
  return step.rules.some((rule) => !rule.isAiCondition && !rule.isAggregateCondition && !isDeterministicCondition(rule.condition));
}

/**
 * Check if a step has only one branch (automatic selection possible).
 * Returns true when rules.length === 1, meaning no actual choice is needed.
 */
export function hasOnlyOneBranch(step: WorkflowStep): boolean {
  return step.rules !== undefined && step.rules.length === 1;
}

/**
 * Get the auto-selected tag when there's only one branch.
 * Returns the tag for the first rule (e.g., "[STEP:1]").
 */
export function getAutoSelectedTag(step: WorkflowStep): string {
  if (!hasOnlyOneBranch(step)) {
    throw new Error('Cannot auto-select tag when multiple branches exist');
  }
  return `[${step.name.toUpperCase()}:1]`;
}

/**
 * Get report file names from a step's output contracts.
 */
export function getReportFiles(outputContracts: OutputContractEntry[] | undefined): string[] {
  if (!outputContracts || outputContracts.length === 0) return [];
  return outputContracts.map((entry) => entry.name);
}

/**
 * Get report file names that are eligible for Phase 3 status judgment.
 */
export function getJudgmentReportFiles(outputContracts: OutputContractEntry[] | undefined): string[] {
  if (!outputContracts || outputContracts.length === 0) return [];
  return outputContracts
    .filter((entry) => entry.useJudge !== false)
    .map((entry) => entry.name);
}

/**
 * 即時決定的条件（findings.* 等、'true' の deferred を除く）を順に実状態で
 * 評価し、最初に成立した rule index を返す。Phase 3 判定の採用前に
 * エンジン所有の事実を先行させるための共有ヘルパ
 * （RuleEvaluator.evaluateImmediateDeterministicConditions と同一規則）。
 */
export function findImmediateDeterministicMatch(
  rules: readonly WorkflowRule[] | undefined,
  state: WorkflowState,
  interactive: boolean | undefined,
  startIndex: number,
  endExclusive: number,
): number {
  if (!rules) return -1;
  const upperBound = Math.min(endExclusive, rules.length);
  for (let i = Math.max(startIndex, 0); i < upperBound; i++) {
    const rule = rules[i];
    if (!rule) continue;
    if (rule.interactiveOnly && interactive !== true) continue;
    if (rule.isAiCondition || rule.isAggregateCondition) continue;
    if (!isDeterministicCondition(rule.condition)) continue;
    if (isDeferredDeterministicCondition(rule.condition)) continue;
    if (evaluateWhenExpression(unwrapWhenCondition(rule.condition), state)) {
      return i;
    }
  }
  return -1;
}

export interface Phase3AdoptionInput {
  ruleIndex: number;
  method: string;
}

export interface Phase3AdoptionResult<T extends Phase3AdoptionInput> {
  /** 先行する決定的ルールで置き換えた（または元のままの）判定結果 */
  result: T;
  /** ガード不成立等で採用せず、通常のルール評価へフォールバックすべきか */
  blocked: boolean;
}

/**
 * Phase 3 判定結果の採用判定（StepExecutor / ParallelRunner 共通）。
 * 1) エンジン所有の即時決定的条件を先行評価し、成立していればそちらを採用
 * 2) 採用対象ルールのガード、または自身が決定的条件の場合は実状態で再評価し、
 *    不成立なら採用せずフォールバック
 */
export function resolvePhase3Adoption<T extends Phase3AdoptionInput>(
  rules: readonly WorkflowRule[] | undefined,
  phase3Result: T,
  state: WorkflowState,
  interactive: boolean | undefined,
  evaluate: (expression: string, state: WorkflowState) => boolean,
): Phase3AdoptionResult<T> {
  let result = phase3Result;
  // 先行採用は RuleEvaluator の位置準拠と同界: 判定が選んだルールより前に
  // ある決定的ルールだけが先行する（後ろのルールは first-match-wins に従い
  // 採用済みタグを覆さない。後段の防御はガード条件が担う）。
  const preemptIndex = findImmediateDeterministicMatch(rules, state, interactive, 0, phase3Result.ruleIndex);
  if (preemptIndex !== -1) {
    result = { ...result, ruleIndex: preemptIndex, method: 'auto_select' };
  }
  const rule = rules?.[result.ruleIndex];
  const blocked = (rule?.guardCondition !== undefined && !evaluate(rule.guardCondition, state))
    || (rule !== undefined
      && isDeterministicCondition(rule.condition)
      && !evaluate(unwrapWhenCondition(rule.condition), state));
  return { result, blocked };
}

/**
 * 判定（Phase 3 / タグ / 構造化）でモデルが選択してよいルールか。
 * interactiveOnly の対話外ルールと、エンジンが実状態から評価する
 * 決定的条件（when(...)）は選択対象にしない。
 */
export function isJudgeableRule(rule: WorkflowRule | undefined, interactive: boolean): boolean {
  if (rule === undefined) return false;
  if (rule.interactiveOnly && !interactive) return false;
  return !isDeterministicCondition(rule.condition);
}

