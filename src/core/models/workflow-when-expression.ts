import {
  findClosingParen,
  isEscapedQuote,
  splitTopLevelClausesOrThrow,
} from './workflow-condition-expression.js';
import {
  describeFindingsNestedPath,
  describeFindingsReferencePath,
  type FindingsReferenceDescriptor,
  type FindingsReferenceValueKind,
} from './workflow-findings-reference.js';
import { parseWorkflowStateReference } from './workflow-state-reference.js';

export type WhenComparisonOperator = '>=' | '<=' | '!=' | '==' | '>' | '<';

export type WhenOperandExpression =
  | { kind: 'literal'; raw: string; value: boolean | number | string | null }
  | { kind: 'state'; reference: string }
  | { kind: 'item'; reference: string };

export type WhenClauseExpression =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'operand'; operand: Extract<WhenOperandExpression, { kind: 'state' }> }
  | {
    kind: 'comparison';
    operator: WhenComparisonOperator;
    left: WhenOperandExpression;
    right: WhenOperandExpression;
  }
  | {
    kind: 'exists';
    listExpression: Extract<WhenOperandExpression, { kind: 'state' }>;
    predicate: Array<{ left: WhenOperandExpression; right: WhenOperandExpression }>;
  };

export interface WhenConditionExpression {
  alternatives: WhenClauseExpression[][];
}

const COMPARISON_OPERATORS = ['>=', '<=', '!=', '==', '>', '<'] as const;
const STATE_REFERENCE_PREFIXES = ['context.', 'structured.', 'effect.', 'findings.'] as const;

function isOrderingOperator(operator: WhenComparisonOperator): boolean {
  return operator === '>' || operator === '<' || operator === '>=' || operator === '<=';
}

function isNonNumericLiteral(operand: WhenOperandExpression): boolean {
  return operand.kind === 'literal' && typeof operand.value !== 'number';
}

type OperandParseContext =
  | { kind: 'workflow' }
  | { kind: 'exists'; itemDescriptor?: FindingsReferenceDescriptor };

function describeOperand(
  operand: WhenOperandExpression,
  context: OperandParseContext,
): FindingsReferenceDescriptor | undefined {
  if (operand.kind === 'literal') return undefined;
  if (operand.kind === 'item') {
    if (context.kind !== 'exists' || context.itemDescriptor === undefined) return undefined;
    return describeFindingsNestedPath(
      context.itemDescriptor,
      operand.reference.slice('item.'.length).split('.'),
    );
  }

  const reference = parseWorkflowStateReference(operand.reference);
  return reference.root === 'findings'
    ? describeFindingsReferencePath(reference.path)
    : undefined;
}

function isStaticallyNonNumericOperand(
  operand: WhenOperandExpression,
  context: OperandParseContext,
): boolean {
  if (isNonNumericLiteral(operand)) return true;
  const descriptor = describeOperand(operand, context);
  return descriptor !== undefined && descriptor.kind !== 'number';
}

function assertOperandRole(
  operand: Extract<WhenOperandExpression, { kind: 'state' }>,
  subject: string,
  findingsKind: FindingsReferenceValueKind,
): void {
  const reference = parseWorkflowStateReference(operand.reference);
  if (reference.root === 'findings') {
    const descriptor = describeFindingsReferencePath(reference.path);
    if (descriptor?.kind !== findingsKind) {
      throw new Error(
        `${subject} requires a ${findingsKind} findings reference: "${operand.reference}"`,
      );
    }
    return;
  }
  if (reference.path.length === 0) {
    throw new Error(`${subject} requires a path-bearing workflow state reference: "${operand.reference}"`);
  }
}

function assertBalancedExpression(expression: string): void {
  let inString = false;
  let depth = 0;

  for (let index = 0; index < expression.length; index++) {
    const current = expression[index];
    if (current === '"' && !isEscapedQuote(expression, index)) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (current === '(') {
      depth++;
      continue;
    }
    if (current === ')') {
      depth--;
      if (depth < 0) throw new Error(`Invalid when expression "${expression}"`);
    }
  }

  if (inString || depth !== 0) {
    throw new Error(`Invalid when expression "${expression}"`);
  }
}

function findComparisonOperator(
  expression: string,
): { operator: WhenComparisonOperator; index: number } | undefined {
  let inString = false;
  let depth = 0;

  for (let index = 0; index < expression.length; index++) {
    const current = expression[index];
    if (current === '"' && !isEscapedQuote(expression, index)) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (current === '(') {
      depth++;
      continue;
    }
    if (current === ')') {
      depth--;
      continue;
    }
    if (depth !== 0) continue;

    for (const operator of COMPARISON_OPERATORS) {
      if (expression.slice(index, index + operator.length) === operator) {
        return { operator, index };
      }
    }
  }

  return undefined;
}

function parseQuotedLiteral(value: string, operand: string): WhenOperandExpression {
  let decoded = '';
  for (let index = 1; index < value.length - 1; index++) {
    const current = value[index];
    if (current === '"') {
      throw new Error(`Invalid when operand "${operand}"`);
    }
    if (current !== '\\') {
      decoded += current;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped !== '"' && escaped !== '\\') {
      throw new Error(`Invalid escape sequence in when operand "${operand}"`);
    }
    decoded += escaped;
    index++;
  }
  return { kind: 'literal', raw: value, value: decoded };
}

function parseItemOperand(
  value: string,
  operand: string,
  descriptor: FindingsReferenceDescriptor | undefined,
): WhenOperandExpression {
  const path = value.slice('item.'.length).split('.');
  if (path.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid exists() operand "${operand}"`);
  }
  if (descriptor !== undefined && describeFindingsNestedPath(descriptor, path) === undefined) {
    throw new Error(`Unsupported exists() operand "${value}"`);
  }
  return { kind: 'item', reference: value };
}

function parseOperand(
  operand: string,
  context: OperandParseContext,
): WhenOperandExpression {
  const value = operand.trim();
  if (value.length === 0) throw new Error(`Invalid when operand "${operand}"`);
  if (value === 'true') return { kind: 'literal', raw: value, value: true };
  if (value === 'false') return { kind: 'literal', raw: value, value: false };
  if (value === 'null') return { kind: 'literal', raw: value, value: null };
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return { kind: 'literal', raw: value, value: Number(value) };
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return parseQuotedLiteral(value, operand);
  }
  if (!/^[^\s(),<>=!&|"']+$/.test(value)) {
    throw new Error(`Invalid when operand "${operand}"`);
  }
  if (STATE_REFERENCE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    const reference = parseWorkflowStateReference(value);
    if (
      reference.root === 'findings'
      && describeFindingsReferencePath(reference.path) === undefined
    ) {
      throw new Error(`Unsupported findings reference "${value}"`);
    }
    return { kind: 'state', reference: value };
  }
  if (context.kind === 'exists' && value.startsWith('item.')) {
    return parseItemOperand(value, operand, context.itemDescriptor);
  }
  throw new Error(`Unsupported when operand "${value}"`);
}

function splitFunctionArgs(argsText: string): [string, string] {
  let inString = false;
  let depth = 0;

  for (let index = 0; index < argsText.length; index++) {
    const current = argsText[index];
    if (current === '"' && !isEscapedQuote(argsText, index)) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (current === '(') {
      depth++;
      continue;
    }
    if (current === ')') {
      depth--;
      continue;
    }
    if (current === ',' && depth === 0) {
      return [
        argsText.slice(0, index).trim(),
        argsText.slice(index + 1).trim(),
      ];
    }
  }

  throw new Error(`Invalid exists() expression "${argsText}"`);
}

function parseComparison(
  clause: string,
  context: OperandParseContext,
): Extract<WhenClauseExpression, { kind: 'comparison' }> {
  const operatorMatch = findComparisonOperator(clause);
  if (operatorMatch === undefined) throw new Error(`Invalid when clause "${clause}"`);
  const left = parseOperand(clause.slice(0, operatorMatch.index), context);
  const right = parseOperand(
    clause.slice(operatorMatch.index + operatorMatch.operator.length),
    context,
  );
  if (
    isOrderingOperator(operatorMatch.operator)
    && (
      isStaticallyNonNumericOperand(left, context)
      || isStaticallyNonNumericOperand(right, context)
    )
  ) {
    throw new Error(
      `Operator "${operatorMatch.operator}" requires numeric operands: "${clause}"`,
    );
  }
  return { kind: 'comparison', operator: operatorMatch.operator, left, right };
}

function parseExistsClause(clause: string): Extract<WhenClauseExpression, { kind: 'exists' }> {
  const closingParen = findClosingParen(clause, 'exists('.length - 1);
  if (closingParen !== clause.length - 1) {
    throw new Error(`Invalid exists() clause "${clause}"`);
  }
  const [listExpression, predicateExpression] = splitFunctionArgs(
    clause.slice('exists('.length, -1),
  );
  const parsedListExpression = parseOperand(listExpression, { kind: 'workflow' });
  if (parsedListExpression.kind !== 'state') {
    throw new Error(`exists() requires a workflow state reference: "${listExpression}"`);
  }
  assertOperandRole(parsedListExpression, 'exists()', 'array');
  const listDescriptor = describeOperand(parsedListExpression, { kind: 'workflow' });
  const itemDescriptor = listDescriptor?.kind === 'array'
    ? listDescriptor.item
    : undefined;
  const predicate = splitTopLevelClausesOrThrow(
    predicateExpression,
    '&&',
    'exists() predicate',
  ).map((predicateClause) => {
    const comparison = parseComparison(predicateClause, { kind: 'exists', itemDescriptor });
    if (comparison.operator !== '==') {
      throw new Error(`exists() only supports "==" and "&&": "${predicateExpression}"`);
    }
    return { left: comparison.left, right: comparison.right };
  });
  return {
    kind: 'exists',
    listExpression: parsedListExpression,
    predicate,
  };
}

function parseClause(clause: string): WhenClauseExpression {
  const normalized = clause.trim();
  if (normalized === 'true') return { kind: 'boolean', value: true };
  if (normalized === 'false') return { kind: 'boolean', value: false };
  if (normalized.startsWith('exists(')) return parseExistsClause(normalized);
  if (findComparisonOperator(normalized) !== undefined) {
    return parseComparison(normalized, { kind: 'workflow' });
  }
  const operand = parseOperand(normalized, { kind: 'workflow' });
  if (operand.kind !== 'state') {
    throw new Error(`Bare when clause must be boolean or a workflow state reference: "${normalized}"`);
  }
  assertOperandRole(operand, 'Bare when clause', 'boolean');
  return { kind: 'operand', operand };
}

export function parseWhenConditionExpression(expression: string): WhenConditionExpression {
  assertBalancedExpression(expression);
  const alternatives = splitTopLevelClausesOrThrow(
    expression,
    '||',
    'when expression',
  ).map((alternative) => splitTopLevelClausesOrThrow(
    alternative,
    '&&',
    'when expression',
  ).map(parseClause));
  return { alternatives };
}
