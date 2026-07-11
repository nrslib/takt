/**
 * Finding Contract の raw findings 取り込みを、ParallelRunner（複数レビュアーの
 * 集約）と StepExecutor（単独ステップ）の両方から呼べる形に切り出したもの。
 *
 * 以前は ParallelRunner だけが findings-manager を起動していたため、単独
 * ステップが `*-finding-contract` 形式のレポートを出しても台帳へ取り込まれず、
 * 指摘が黙って捨てられていた（WorkflowValidator は台帳があれば単独ステップの
 * この形式を許すが、取り込み経路自体が無かった）。
 */

import type { AgentWorkflowStep, FindingContractConfig, WorkflowConfig, WorkflowStep } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { isDelegatedWorkflowStep } from '../step-kind.js';
import {
  RawFindingsStructuredOutput,
  runFindingManagerForStep,
  type FindingManagerRunResult,
  type FindingManagerSubStepResult,
} from './manager-runner.js';
import type { FindingLedgerStore } from './store.js';

/**
 * ある単独ステップが Finding Contract の取り込み対象かどうかを判定する。
 * 対象になるのは、台帳（自前 or workflow_call 親からの継承）が有効で、かつ
 * このステップの output_contracts.report[].formatRef が `*-finding-contract`
 * 命名規約に従っている場合だけ。
 *
 * 以前は ParallelRunner だけが findings-manager を起動していたため、この
 * 形式を使う単独ステップは取り込み経路が無く、指摘が黙って捨てられていた
 * （WorkflowValidator は台帳があれば単独ステップでのこの形式を許すが、
 * 実行時に反映する経路自体が欠けていた）。
 *
 * StepExecutor（実行時に findings-manager を起動するかどうか）と
 * workflowPreview（preview に findings-manager を出すかどうか）の両方が
 * この述語を共有することで、実行時とプレビューの判定を一致させる。
 *
 * 「通常の agent ステップ」限定。system / workflow_call に加え、parallel /
 * arpeggio / team_leader を持つステップも対象外（isDelegatedWorkflowStep）。
 * これらは実行時に WorkflowEngineStepCoordinator が専用 Runner へ分岐し、
 * StepExecutor.runNormalStep（manager 起動経路）を通らない。スキーマ上は
 * team_leader / arpeggio も output_contracts に *-finding-contract を書けるが、
 * 実行時に manager が起動しない以上、preview に出すと嘘になる。
 */
export function resolveFindingContractIntakeStep(
  step: WorkflowStep,
  findingContract: FindingContractConfig | undefined,
): AgentWorkflowStep | undefined {
  if (!findingContract) {
    return undefined;
  }
  if (isDelegatedWorkflowStep(step)) {
    return undefined;
  }
  const hasFindingContractFormat = (step.outputContracts ?? []).some(
    (entry) => entry.formatRef?.endsWith('-finding-contract') === true,
  );
  return hasFindingContractFormat ? (step as AgentWorkflowStep) : undefined;
}

export interface FindingContractIntakeInput {
  contract: FindingContractConfig;
  /** manager の provider/model 未指定時の fallback（manager-runner.ts 参照）。 */
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  ledgerStore: FindingLedgerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  /** raw admission validation（manager-runner.ts の cwd 引数を参照）に使う実行 cwd。 */
  cwd: string;
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
 * findings-manager を実行し、台帳更新イベントを発火する。台帳への
 * 取り込みという副作用込みの手続きをここへ集約し、ParallelRunner と
 * StepExecutor の両方が同じ手順で呼べるようにする。v2 梯子設計では
 * 取り込みは常に 'updated' で完了する（manager の壊れた応答・予算超過は
 * provisional として台帳へ着地し、run-level の invalid_manager_output は無い）。
 */
export async function ingestFindingContractResults(
  input: FindingContractIntakeInput,
): Promise<FindingManagerRunResult> {
  const result = await runFindingManagerForStep({
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
    ledgerStore: input.ledgerStore,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
    cwd: input.cwd,
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
  input.refreshFindingsState();
  input.emitEvent('findings:ledger', result.ledger);
  return result;
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
