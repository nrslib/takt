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

/** when(<式>) の内側の式を取り出す。when 形式でなければそのまま返す。 */
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
): number {
  if (!rules) return -1;
  for (let i = 0; i < rules.length; i++) {
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

