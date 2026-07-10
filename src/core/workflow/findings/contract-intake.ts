/**
 * Finding Contract の raw findings 取り込みを、ParallelRunner（複数レビュアーの
 * 集約）と StepExecutor（単独ステップ）の両方から呼べる形に切り出したもの。
 *
 * 以前は ParallelRunner だけが findings-manager を起動していたため、単独
 * ステップが `*-finding-contract` 形式のレポートを出しても台帳へ取り込まれず、
 * 指摘が黙って捨てられていた（WorkflowValidator は台帳があれば単独ステップの
 * この形式を許すが、取り込み経路自体が無かった）。
 */

import type { AgentWorkflowStep, FindingContractConfig, WorkflowStep } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { isNonAiReturnValueRule } from '../evaluation/rule-utils.js';
import {
  RawFindingsStructuredOutput,
  runFindingManagerForStep,
  type FindingManagerRunResult,
  type FindingManagerSubStepResult,
} from './manager-runner.js';
import type { FindingLedgerStore } from './store.js';

export interface FindingContractIntakeInput {
  contract: FindingContractConfig;
  ledgerStore: FindingLedgerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  parentStep: WorkflowStep;
  stepIteration: number;
  subResults: FindingManagerSubStepResult[];
  workflowName: string;
  runId: string;
  /** raw finding id 衝突対策の呼び出し名前空間。トップレベルでは空文字列。 */
  callNamespace: string;
  timestamp: string;
  ledgerCopyPath?: string;
  priorStepResponseText?: string;
  refreshFindingsState: () => void;
  emitEvent: (event: string, ...args: unknown[]) => void;
}

/**
 * findings-manager を実行し、成功時は台帳更新イベントを発火する。台帳への
 * 取り込みという副作用込みの手続きをここへ集約し、ParallelRunner と
 * StepExecutor の両方が同じ手順で呼べるようにする。
 */
export async function ingestFindingContractResults(
  input: FindingContractIntakeInput,
): Promise<FindingManagerRunResult> {
  const result = await runFindingManagerForStep({
    contract: input.contract,
    ledgerStore: input.ledgerStore,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
    parentStep: input.parentStep,
    stepIteration: input.stepIteration,
    subResults: input.subResults,
    workflowName: input.workflowName,
    runId: input.runId,
    callNamespace: input.callNamespace,
    timestamp: input.timestamp,
    ledgerCopyPath: input.ledgerCopyPath,
    priorStepResponseText: input.priorStepResponseText,
  });
  if (result.status === 'updated') {
    input.refreshFindingsState();
    input.emitEvent('findings:ledger', result.ledger);
  }
  return result;
}

/**
 * invalid_manager_output のとき、迂回先ルールを選ぶ。need_replan → needs_fix →
 * 非AI の next: fix の優先順で、ステップの rules から該当するものを探す。
 * ParallelRunner（parallel parent）・StepExecutor（単独ステップ）のどちらの
 * `step.rules` にも同じ考え方で使える（parallel 固有の情報は見ない）。
 */
export function selectInvalidManagerOutputRuleIndex(step: WorkflowStep): number {
  const rules = step.rules;
  if (!rules) {
    throw new Error(`Invalid finding_contract step "${step.name}": missing invalid manager output rule`);
  }

  const needReplanIndex = rules.findIndex((rule) => isNonAiReturnValueRule(rule, 'need_replan'));
  if (needReplanIndex >= 0) {
    return needReplanIndex;
  }

  const needsFixIndex = rules.findIndex((rule) => isNonAiReturnValueRule(rule, 'needs_fix'));
  if (needsFixIndex >= 0) {
    return needsFixIndex;
  }

  const fixIndex = rules.findIndex((rule) => !rule.isAiCondition && rule.next === 'fix');
  if (fixIndex >= 0) {
    return fixIndex;
  }

  throw new Error(`Invalid finding_contract step "${step.name}": missing invalid manager output rule`);
}

/**
 * finding_contract のステップに raw findings 構造化出力を強制する。ステップが
 * 既に structuredOutput を持つ場合は併用できないため設定エラーとして拒否する
 * （findings-manager の raw findings 契約と、ステップ独自の構造化出力契約は
 * 同時に満たせない）。
 */
export function withFindingContractStructuredOutput(
  step: AgentWorkflowStep,
  ledgerCopyPath: string | undefined,
): AgentWorkflowStep {
  if (!ledgerCopyPath) {
    return step;
  }
  if (step.structuredOutput) {
    throw new Error(`Step "${step.name}" cannot combine finding_contract raw findings with structured_output`);
  }
  return {
    ...step,
    structuredOutput: RawFindingsStructuredOutput,
  };
}
