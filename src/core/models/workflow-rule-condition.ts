import {
  isWhenConditionExpression,
  isEscapedQuote,
  parseAggregateConditionArgs,
  parseAggregateConditionExpression,
  parseAiConditionExpression,
  splitTopLevelClausesOrThrow,
  unwrapWhenConditionExpression,
} from './workflow-condition-expression.js';
import { parseWhenConditionExpression } from './workflow-when-expression.js';

export type WorkflowRuleCondition =
  | { kind: 'semantic'; label: string }
  | { kind: 'when'; expression: string }
  | { kind: 'aggregate'; aggregate: 'all' | 'any'; targetConditions: WorkflowRuleCondition[] }
  | { kind: 'and'; left: WorkflowRuleCondition; right: WorkflowRuleCondition };

/** A semantic label selectable during Phase 3 status judgment. */
export interface SemanticRuleCandidate {
  label: string;
  appendix?: string;
}

interface SemanticRuleSource {
  condition: WorkflowRuleCondition;
  interactiveOnly?: boolean;
  appendix?: string;
}

export interface SemanticAppendixRule extends SemanticRuleSource {
  ruleIndex: number;
}

export interface SemanticAppendixConflict {
  ruleIndex: number;
  label: string;
}

export function isParallelSubStepRuleCondition(condition: WorkflowRuleCondition): boolean {
  return condition.kind === 'semantic'
    || condition.kind === 'when'
    || (
      condition.kind === 'and'
      && condition.left.kind === 'semantic'
      && condition.right.kind === 'when'
    );
}

export function parseWorkflowRuleCondition(value: string): WorkflowRuleCondition {
  const condition = value.trim();
  if (condition.length === 0) {
    throw new Error('Workflow rule condition must not be empty');
  }
  if (parseAiConditionExpression(condition) !== undefined) {
    throw new Error('workflow rule conditions do not support ai()');
  }

  const clauses = splitTopLevelClausesOrThrow(condition, '&&', 'workflow rule condition');
  if (clauses.length > 1) {
    if (clauses.length !== 2) {
      throw new Error(`Invalid workflow rule condition: ${value}`);
    }
    const left = parseWorkflowRuleCondition(clauses[0]!);
    const right = parseWorkflowRuleCondition(clauses[1]!);
    if (right.kind !== 'when' || left.kind === 'when' || left.kind === 'and') {
      throw new Error(`Invalid workflow rule condition: ${value}`);
    }
    return { kind: 'and', left, right };
  }

  if (isWhenConditionExpression(condition)) {
    const expression = unwrapWhenConditionExpression(condition);
    if (expression.trim().length === 0) {
      throw new Error(`Workflow rule condition must not have an empty when() expression: ${value}`);
    }
    parseWhenConditionExpression(expression);
    return { kind: 'when', expression };
  }
  const aggregate = parseAggregateConditionExpression(condition);
  if (aggregate !== undefined) {
    const targetConditions = parseAggregateConditionArgs(aggregate.argsText).map((target) => {
      const childCondition = parseWorkflowRuleCondition(target);
      if (!isParallelSubStepRuleCondition(childCondition)) {
        throw new Error(`Aggregate condition target must be valid for a parallel sub-step: ${target}`);
      }
      return childCondition;
    });
    return {
      kind: 'aggregate',
      aggregate: aggregate.type,
      targetConditions,
    };
  }
  if (/^(all|any|when|ai)\(/.test(condition)) {
    throw new Error(`Invalid workflow rule condition: ${value}`);
  }
  return { kind: 'semantic', label: condition };
}

export function formatWorkflowRuleCondition(condition: WorkflowRuleCondition): string {
  switch (condition.kind) {
    case 'semantic': return condition.label;
    case 'when': return `when(${condition.expression})`;
    case 'aggregate': return `${condition.aggregate}(${condition.targetConditions
      .map((target) => JSON.stringify(formatWorkflowRuleCondition(target))).join(', ')})`;
    case 'and': return `${formatWorkflowRuleCondition(condition.left)} && ${formatWorkflowRuleCondition(condition.right)}`;
  }
}

export function semanticLabelsOf(condition: WorkflowRuleCondition): string[] {
  switch (condition.kind) {
    case 'semantic': return [condition.label];
    case 'and': return semanticLabelsOf(condition.left);
    default: return [];
  }
}

export function findSemanticAppendixConflicts(
  rules: readonly SemanticAppendixRule[],
): SemanticAppendixConflict[] {
  const appendices = new Map<string, string | undefined>();
  const conflicts: SemanticAppendixConflict[] = [];

  for (const rule of rules) {
    const label = semanticLabelsOf(rule.condition)[0];
    if (label === undefined) continue;
    if (!appendices.has(label)) {
      appendices.set(label, rule.appendix);
      continue;
    }
    if (appendices.get(label) !== rule.appendix) {
      conflicts.push({ ruleIndex: rule.ruleIndex, label });
    }
  }

  return conflicts;
}

export function hasAggregateCondition(condition: WorkflowRuleCondition): boolean {
  return condition.kind === 'aggregate'
    || (condition.kind === 'and'
      && (hasAggregateCondition(condition.left) || hasAggregateCondition(condition.right)));
}

/**
 * Returns each selectable semantic label once, in its first YAML appearance.
 */
export function semanticRuleCandidatesOf(
  rules: readonly SemanticRuleSource[],
  interactive: boolean,
): SemanticRuleCandidate[] {
  const seen = new Set<string>();
  const candidates: SemanticRuleCandidate[] = [];

  rules.forEach((rule) => {
    if (rule.interactiveOnly && !interactive) return;
    const label = semanticLabelsOf(rule.condition)[0];
    if (label === undefined || seen.has(label)) return;
    seen.add(label);
    candidates.push({
      label,
      ...(rule.appendix === undefined ? {} : { appendix: rule.appendix }),
    });
  });

  return candidates;
}

export function needsSemanticStatusJudgment(
  rules: readonly SemanticRuleSource[],
  interactive: boolean,
): boolean {
  return semanticRuleCandidatesOf(rules, interactive).length > 1;
}

export function hasFindingsReference(condition: WorkflowRuleCondition): boolean {
  switch (condition.kind) {
    case 'when': return hasUnquotedFindingsReference(condition.expression);
    case 'and': return hasFindingsReference(condition.left) || hasFindingsReference(condition.right);
    default: return false;
  }
}

function isReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9_.]/.test(char);
}

/** Detects an unquoted findings state reference at an identifier boundary. */
export function hasUnquotedFindingsReference(expression: string): boolean {
  let inString = false;

  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === '"') {
      if (!isEscapedQuote(expression, index)) {
        inString = !inString;
      }
      continue;
    }
    if (!inString && expression.startsWith('findings.', index) && isReferenceBoundary(expression[index - 1])) {
      return true;
    }
  }

  return false;
}

/** Detects an unquoted, complete state identifier reference. */
export function hasUnquotedIdentifierReference(expression: string, identifier: string): boolean {
  let inString = false;

  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === '"') {
      if (!isEscapedQuote(expression, index)) {
        inString = !inString;
      }
      continue;
    }
    if (
      !inString
      && expression.startsWith(identifier, index)
      && isReferenceBoundary(expression[index - 1])
      && (expression[index + identifier.length] === '.' || isReferenceBoundary(expression[index + identifier.length]))
    ) {
      return true;
    }
  }

  return false;
}

export function terminalLabelOf(condition: WorkflowRuleCondition): string | undefined {
  return condition.kind === 'semantic' ? condition.label : undefined;
}
