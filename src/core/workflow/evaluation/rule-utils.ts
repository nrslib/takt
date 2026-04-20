/**
 * Shared rule utility functions used by both engine.ts and instruction-builder.ts.
 */

import type { WorkflowStep, OutputContractEntry } from '../../models/types.js';

const DETERMINISTIC_CONDITION_PATTERN = /^(true|false|exists\(.*\)|(?:context|structured|effect)\..*|.*(?:==|!=|>=|<=|>|<).*)$/;

export function isDeterministicCondition(condition: string): boolean {
  return DETERMINISTIC_CONDITION_PATTERN.test(condition.trim());
}

export function isDeferredDeterministicCondition(condition: string): boolean {
  return condition.trim() === 'true';
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
