import type { WorkflowRule } from '../../../core/models/index.js';
import { splitTopLevelClausesOrThrow } from '../../../core/models/workflow-condition-expression.js';
import {
  parseAggregateConditionArgs,
  parseAggregateConditionExpression,
  parseAiConditionExpression,
} from '../../../core/models/workflow-condition-expression.js';
import { isDeterministicCondition, unwrapWhenCondition } from '../../../core/workflow/evaluation/rule-utils.js';


/**
 * Split a plain compound condition "<tag text> && <findings guard>" into its
 * tag-matching text and deterministic guard. The when-evaluator cannot parse
 * bare status text as an operand, so compounds must be decomposed here.
 * Returns undefined when the condition is not in that shape.
 */
export function splitTagFindingsCondition(condition: string): { tagText: string; guard: string } | undefined {
  // 文字列リテラル・括弧内の && では分割しない（exists(...) 等を壊さない）。
  // splitTopLevel は空 clause を除去するため、壊れた設定（"a && && b" 等）の
  // fail-fast 用に空 clause を保持する分割をここで行う。
  // "a && && b" のような壊れた条件は、どの解釈でも設定ミス。散文タグに
  // 流して黙殺せず fail-fast する（集約ガード・評価器と同じ契約）。
  const clauses = splitTopLevelClausesOrThrow(condition, '&&', 'rule condition');
  if (clauses.length < 2) {
    return undefined;
  }
  const [tagText, ...guardClauses] = clauses;
  if (tagText === undefined) {
    return undefined;
  }
  // 左辺が決定的条件（findings./structured./context. 等）なら分解しない:
  // 複合全体を when-evaluator がそのまま評価できる。
  if (isDeterministicCondition(tagText)) {
    return undefined;
  }
  // ガード側は「全節が when() 決定的条件」のときだけ分解する。1節でも散文が
  // 混ざる場合（例: 日本語タグ文が && を含む）は分解せず、従来どおり
  // 条件全体をタグ文として扱う。
  if (!guardClauses.every((clause) => isDeterministicCondition(clause))) {
    return undefined;
  }
  // ガードは when() の内側に unwrap して保存する（評価側は素の式だけを扱う）
  return { tagText, guard: guardClauses.map(unwrapWhenCondition).join(' && ') };
}

export function normalizeRule(rule: {
  condition?: string;
  when?: string;
  next?: string;
  return?: string;
  appendix?: string;
  requires_user_input?: boolean;
  interactive_only?: boolean;
}): WorkflowRule {
  // `when:` キーは決定的条件の宣言形: when(<式>) に包んで扱う。
  // 裸の式を condition: に書いた場合は通常のタグ条件（散文）として扱う。
  const condition = rule.condition ?? (rule.when !== undefined ? `when(${rule.when})` : undefined);
  if (!condition) {
    throw new Error('Workflow rule requires condition or when');
  }
  const next = rule.next ?? '';
  const aiExpression = parseAiConditionExpression(condition);
  if (aiExpression) {
    return {
      condition,
      next,
      returnValue: rule.return,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      isAiCondition: true,
      aiConditionText: aiExpression.text,
    };
  }

  const aggregateExpression = parseAggregateConditionExpression(condition);
  if (aggregateExpression) {
    const conditions = parseAggregateConditionArgs(aggregateExpression.argsText);
    return {
      condition,
      next,
      returnValue: rule.return,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      isAggregateCondition: true,
      aggregateType: aggregateExpression.type,
      aggregateConditionText: conditions.length === 1 ? conditions[0]! : conditions,
      ...(aggregateExpression.guardCondition !== undefined
        ? { aggregateGuardCondition: aggregateExpression.guardCondition }
        : {}),
    };
  }

  const compound = splitTagFindingsCondition(condition);
  if (compound) {
    return {
      condition: compound.tagText,
      next,
      returnValue: rule.return,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      guardCondition: compound.guard,
    };
  }

  return {
    condition,
    next,
    returnValue: rule.return,
    appendix: rule.appendix,
    requiresUserInput: rule.requires_user_input,
    interactiveOnly: rule.interactive_only,
  };
}
