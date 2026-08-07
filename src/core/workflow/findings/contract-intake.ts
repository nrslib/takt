/**
 * Finding Contract の raw findings 取り込みを、ParallelRunner（複数レビュアーの
 * 集約）と StepExecutor（単独ステップ）の両方から呼べる形に切り出したもの。
 *
 * 以前は ParallelRunner だけが findings-manager を起動していたため、単独
 * ステップが `*-finding-contract` 形式のレポートを出しても台帳へ取り込まれず、
 * 指摘が黙って捨てられていた（WorkflowValidator は台帳があれば単独ステップの
 * この形式を許すが、取り込み経路自体が無かった）。
 */

import type {
  AgentWorkflowStep,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowStep,
} from '../../models/types.js';
import type { FindingManagerAuthority } from '../../models/finding-types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { isDelegatedWorkflowStep } from '../step-kind.js';
import { hasFindingContractFormat } from './finding-contract-format.js';
import {
  runFindingManagerForStep,
  type FindingManagerRunResult,
  type FindingManagerSubStepResult,
} from './manager-runner.js';
import type { FindingManagerStore } from './store.js';

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
  return hasFindingContractFormat(step) ? (step as AgentWorkflowStep) : undefined;
}

export interface FindingContractIntakeInput {
  contract: FindingContractConfig;
  /** manager の provider/model 未指定時の fallback（manager-runner.ts 参照）。 */
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  ledgerStore: FindingManagerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
  /** raw admission validation（manager-runner.ts の cwd 引数を参照）に使う実行 cwd。 */
  cwd: string;
  parentStep: WorkflowStep;
  stepIteration: number;
  iteration: number;
  subResults: FindingManagerSubStepResult[];
  workflowName: string;
  workflowTask: string;
  analyticsWorkflowName: string;
  /** raw finding id 衝突対策の呼び出し名前空間。トップレベルでは空文字列。 */
  callNamespace: string;
  timestamp: string;
  priorStepResponseText?: string;
  managerAuthority: FindingManagerAuthority;
  reviewPublicationDir?: string;
  /** stop budget / review-integrity のラウンド計上対象か（manager-contracts.ts 参照）。 */
  budgetAccounting?: 'round' | 'excluded';
  refreshFindingsState: () => void;
  emitEvent: (event: string, ...args: unknown[]) => void;
}

/**
 * findings-manager を実行し、台帳更新イベントを発火する。台帳への
 * 取り込みという副作用込みの手続きをここへ集約し、ParallelRunner と
 * StepExecutor の両方が同じ手順で呼べるようにする。適用済みroundの再実行は
 * 'unchanged' となり、台帳更新イベントを重ねて発火しない。
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
    workflowTask: input.workflowTask,
    runId: input.ledgerStore.runId,
    callNamespace: input.callNamespace,
    timestamp: input.timestamp,
    priorStepResponseText: input.priorStepResponseText,
    managerAuthority: input.managerAuthority,
    reviewPublicationDir: input.reviewPublicationDir,
    ...(input.budgetAccounting === undefined ? {} : { budgetAccounting: input.budgetAccounting }),
  });
  if (result.status === 'updated') {
    input.refreshFindingsState();
    input.emitEvent('findings:ledger', result.ledger, {
      iteration: input.iteration,
      workflowName: input.analyticsWorkflowName,
      scopeIdentity: input.ledgerStore.ledgerIdentity,
    });
  }
  return result;
}

/**
 * FC レビュアーは markdown レポートしか書かないため、ステップ側の
 * `structured_output` と競合する契約はもう存在しない。ただし独自の構造化出力を
 * 持つステップは正規化係が読む「1本のレポート」を持たないので、取り込み対象に
 * なった時点で設定エラーとして止める。
 */
export function assertFindingContractReviewerStep(step: AgentWorkflowStep): void {
  if (step.structuredOutput) {
    throw new Error(`Step "${step.name}" cannot combine finding_contract review reports with structured_output`);
  }
}
