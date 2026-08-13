import type { AutoRoutingConfig } from '../../models/config-types.js';
import type { AgentWorkflowStep, LoopMonitorRule, WorkflowConfig, WorkflowRule, WorkflowStep } from '../../models/types.js';
import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  isNormalAgentWorkflowStep,
} from '../../models/types.js';
import {
  SESSION_AGENT_STEP_REQUIRED_MESSAGE,
  SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE,
} from '../../models/workflow-session-constraints.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES, FINDING_CONFLICT_ADJUDICATION_STEP } from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import {
  applyProviderModelOverride,
  resolveLoopMonitorJudgeProviderModel,
  resolveStepProviderModel,
} from '../provider-resolution.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';
import {
  LOOP_JUDGE_ROUTING_KEY,
  loopJudgeProviderFields,
  loopJudgeStepName,
} from '../loop-judge-step.js';
import { getWorkflowStepKind, isDelegatedWorkflowStep, isWorkflowCallStep } from '../step-kind.js';
import {
  findSemanticAppendixConflicts,
  hasAggregateCondition,
  hasFindingsReference,
} from '../../models/workflow-rule-condition.js';
import { buildFindingInterpretationStep, buildFindingManagerStep } from '../findings/manager-step.js';
import {
  buildFindingConflictAdjudicationStep,
  buildFindingTerminalAdjudicationStep,
  FINDING_TERMINAL_ADJUDICATION_STEP,
  workflowWiresFindingConflictAdjudication,
} from '../findings/adjudication-step.js';
import { findFindingContractFormat, hasFindingContractFormat } from '../findings/finding-contract-format.js';
import {
  assertFindingIntakeNormalizerProvider,
  buildFindingIntakeNormalizerSteps,
} from '../findings/intake-normalize-policy.js';
import {
  resolveAutoRoutingCandidateProviderInfo,
  resolveDeterministicAutoRoutingProviderInfo,
  toAutoRoutingStepMetadata,
  validateAutoRoutingResolvedProviderModel,
} from '../auto-routing/resolver.js';
import { hasAutoRoutingPoolAssignment, resolveExecutableRoutingCandidates } from '../auto-routing/selector.js';
import { findDuplicateWorkflowStepName } from '../../../shared/workflowStepNameValidator.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';
import { findWorkflowStepLocation } from '../workflow-step-location.js';
import { getProviderValidationErrorSource, withProviderValidationErrorSource } from '../provider-validation-error.js';
import { validateDynamicParallelContracts } from '../dynamic-parallel/validator.js';

type ResolvedProviderInfo = ReturnType<typeof resolveStepProviderModel>;
export type FindingContractSyntheticProviderValidationOptions = Pick<
  WorkflowEngineOptions,
  | 'provider'
  | 'providerSource'
  | 'model'
  | 'modelSource'
  | 'autoRouting'
  | 'providerRouting'
  | 'providerRoutingTagConflictPolicy'
  | 'personaProviders'
  | 'internalAgentSeats'
  | 'providerEscalation'
> & {
  inheritedFindingContract?: Pick<
    NonNullable<WorkflowEngineOptions['inheritedFindingContract']>,
    'contract' | 'managerAuthority'
  >;
};
const withWorkflowStepErrorPath = withWorkflowConfigErrorPath;

function providerValidationField(error: unknown, fallback: 'provider' | 'model'): 'provider' | 'model' {
  return getProviderValidationErrorSource(error)?.field ?? fallback;
}

function withConfigStepErrorPath(
  config: WorkflowConfig,
  step: WorkflowStep,
  fallbackPath: readonly PropertyKey[],
  fieldPath: readonly PropertyKey[],
  error: unknown,
): Error {
  return withWorkflowConfigErrorPath(error, [...(findWorkflowStepLocation(config, step) ?? fallbackPath), ...fieldPath]);
}

interface ValidationProviderInfo {
  providerInfo: ResolvedProviderInfo;
  autoRouted: boolean;
}

function expandAutoRoutingProviderInfos(
  step: WorkflowStep,
  currentProviderInfo: ResolvedProviderInfo,
  autoRouting: AutoRoutingConfig | undefined,
): ValidationProviderInfo[] {
  if (
    autoRouting === undefined
    || currentProviderInfo.provider !== undefined
    || getWorkflowStepKind(step) !== 'agent'
    || !hasAutoRoutingPoolAssignment(autoRouting, {
      name: step.name,
      tags: step.tags,
      personaKey: step.providerRoutingPersonaKey,
    })
  ) {
    return [{ providerInfo: currentProviderInfo, autoRouted: false }];
  }

  const resolvedCandidates = resolveExecutableRoutingCandidates(autoRouting, {
    name: step.name,
    tags: step.tags,
    personaKey: step.providerRoutingPersonaKey,
  });
  return resolvedCandidates.candidates.map((candidate) => ({
    providerInfo: resolveAutoRoutingCandidateProviderInfo(
      candidate,
      resolvedCandidates.resolutionSource,
      autoRouting,
      currentProviderInfo,
    ),
    autoRouted: true,
  }));
}

function validateResolvedProviderInfo(
  providerInfo: ResolvedProviderInfo,
  modelFieldName: string,
  autoRouted: boolean,
): void {
  try {
    validateProviderModelRequirements(providerInfo.provider, providerInfo.model, { modelFieldName });
    if (autoRouted && providerInfo.provider !== undefined) {
      validateAutoRoutingResolvedProviderModel(providerInfo.provider, providerInfo.model);
    }
  } catch (error) {
    throw withProviderValidationErrorSource(error, providerInfo);
  }
}

function isFindingsRule(rule: WorkflowRule | LoopMonitorRule): boolean {
  return hasFindingsReference(rule.condition);
}

function validateFindingsRuleContract(
  findingContractConfigured: boolean,
  rule: WorkflowRule | LoopMonitorRule,
  source: string,
): void {
  if (!findingContractConfigured && isFindingsRule(rule)) {
    throw new Error(`${source}: findings.* conditions require finding_contract`);
  }
}

function validateAggregateRulePlacement(
  rules: readonly (WorkflowRule | LoopMonitorRule)[],
  aggregateAllowed: boolean,
  source: string,
  rulesPath: readonly PropertyKey[],
): void {
  if (aggregateAllowed) {
    return;
  }
  const ruleIndex = rules.findIndex((rule) => hasAggregateCondition(rule.condition));
  if (ruleIndex >= 0) {
    throw withWorkflowConfigErrorPath(
      new Error(`${source}: aggregate conditions are only allowed on parallel parent steps with sub-steps`),
      [...rulesPath, ruleIndex],
    );
  }
}

function validateSemanticAppendices(
  rules: readonly WorkflowRule[],
  source: string,
  rulesPath: readonly PropertyKey[],
): void {
  const conflicts = findSemanticAppendixConflicts(rules.map((rule, ruleIndex) => ({
    ruleIndex,
    condition: rule.condition,
    appendix: rule.appendix,
  })));
  const conflict = conflicts[0];
  if (conflict !== undefined) {
    throw withWorkflowConfigErrorPath(
      new Error(`${source}: Rules sharing semantic label "${conflict.label}" must use the same appendix`),
      [...rulesPath, conflict.ruleIndex],
    );
  }
}

/**
 * `next: finding-conflict-adjudication` targets the engine-synthesized
 * adjudication step (see constants.ts / adjudication-step.ts). Like findings.* conditions,
 * it only makes sense when a finding ledger exists to adjudicate against.
 * Applies to step rules, loop monitor judge rules (contract invariant), AND parallel
 * sub-step rules. A sub-step's `next` never routes at runtime (ParallelRunner
 * aggregates; only the parent step's rules transition), but sub-step wiring
 * still counts for step injection (workflowWiresFindingConflictAdjudication),
 * so a contract-less sub-step wiring is dead config referencing machinery that
 * is not enabled — reject it at the same boundary the workflow doctor checks.
 */
function validateFindingConflictAdjudicationRuleContract(
  findingContractConfigured: boolean,
  rule: { next?: string },
  source: string,
): void {
  if (!findingContractConfigured && rule.next === FINDING_CONFLICT_ADJUDICATION_STEP) {
    throw new Error(`${source}: next: ${FINDING_CONFLICT_ADJUDICATION_STEP} requires finding_contract`);
  }
}

/**
 * The synthetic step name is reserved (contract invariant): a user-authored step
 * squatting on it would collide with the engine's injection and silently
 * shadow the adjudication semantics. The engine's own injected step carries
 * engineSynthesized (not settable from YAML — the raw schema has no such
 * field) and is exempt. Provider/model preflight for the synthetic step needs
 * no dedicated validator anymore: the injected step is a real config.steps
 * entry and goes through validateAgentStepProviderModel like any other step.
 */
function validateFindingConflictAdjudicationReservedName(config: WorkflowConfig): void {
  const collectSteps = (steps: readonly WorkflowStep[], path: readonly PropertyKey[]): Array<{ step: WorkflowStep; path: readonly PropertyKey[] }> =>
    steps.flatMap((step, index) => {
      const stepPath = [...path, index];
      const nested = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
      return [{ step, path: stepPath }, ...collectSteps(nested, [...stepPath, 'parallel'])];
    });
  for (const { step, path } of collectSteps(config.steps, ['steps'])) {
    if (step.name === FINDING_CONFLICT_ADJUDICATION_STEP && step.engineSynthesized !== true) {
      throw withConfigStepErrorPath(
        config,
        step,
        path,
        ['name'],
        new Error(`Configuration error: step name "${FINDING_CONFLICT_ADJUDICATION_STEP}" is reserved for the engine-synthesized conflict adjudication step`),
      );
    }
  }
}

function validateFindingContractStructuredOutput(config: WorkflowConfig, findingContractEnabled: boolean): void {
  if (!findingContractEnabled) {
    return;
  }
  for (const [stepIndex, step] of config.steps.entries()) {
    if (step.structuredOutput && hasFindingContractFormat(step)) {
      throw withConfigStepErrorPath(
        config,
        step,
        ['steps', stepIndex],
        ['structured_output'],
        new Error(`Invalid step "${step.name}": cannot combine finding_contract raw findings with structured_output`),
      );
    }
    const subSteps = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
    for (const [subStepIndex, subStep] of subSteps.entries()) {
      if (subStep.structuredOutput) {
        throw withConfigStepErrorPath(
          config,
          subStep,
          ['steps', stepIndex, 'parallel', subStepIndex],
          ['structured_output'],
          new Error(`Invalid parallel sub-step "${subStep.name}" in step "${step.name}": cannot combine finding_contract raw findings with structured_output`),
        );
      }
    }
  }
}

/**
 * Finding Contract の manager / interpreter / adjudicator は実行時に合成される
 * ステップで、config.steps の通常走査（validateAgentStepProviderModel）だけでは
 * 網羅できない。各 runner と共通の builder で合成し、同じ
 * resolveStepProviderModel で provider/model 要件を実行前に検証する。
 *
 * 対象の finding_contract は自前（config.findingContract）だけでなく
 * workflow_call 親からの継承（options.inheritedFindingContract）も含む
 * （WorkflowEngine が実際に使う有効な契約と同じ判定基準。findingContractEnabled
 * と同じ式）。継承分をここで見ないと、子の workflow provider/model では
 * synthetic role が成立しない構成が validate を素通りし、起動時に初めて落ちる。
 *
 * WorkflowCallExecutor が子 engine を組み立てる際、この関数を子の config と
 * 継承契約入り options に対して明示的に呼び、子の実行前に fail-fast する
 * （createEngine は単体テストではモックされるため、子 WorkflowEngine の
 * コンストラクタが暗黙に行う検証には頼れない）。
 */
export function validateFindingContractSyntheticProviderModels(
  config: WorkflowConfig,
  options: FindingContractSyntheticProviderValidationOptions,
): void {
  const findingContract = options.inheritedFindingContract?.contract ?? config.findingContract;
  if (!findingContract) {
    return;
  }
  const stepInput = {
    contract: findingContract,
    workflowProvider: config.provider,
    workflowModel: config.model,
    ...(options.internalAgentSeats === undefined
      ? {}
      : { internalAgentSeats: options.internalAgentSeats }),
  };
  // synthetic roles は実行ループの AI ルーターを
  // 通らず、実行時は OptionsBuilder.resolveStepProviderModel が rules →
  // strategy デフォルトへ決定的に補完する。validator も同じ解決で検証しないと、
  // 実行時には到達しない候補の組み合わせを検証して有効な構成を拒否する
  // （またはその逆の）食い違いが生まれる。両ステップは provider/model 設定を
  // 共有するが名前が異なるため、auto_routing.rules.steps で別々に routing
  // され得る — 片方だけの検証では他方の実行時エラーを素通しする。全候補を
  // 検証する expandAutoRoutingProviderInfos は AI ルーターがどの候補も選び得る
  // 通常ステップ専用。
  const adjudicationSteps = [
    buildFindingTerminalAdjudicationStep(stepInput),
    ...(workflowWiresFindingConflictAdjudication(config.steps, config.loopMonitors)
      ? [buildFindingConflictAdjudicationStep(stepInput)]
      : []),
  ];
  const syntheticSteps = [
    buildFindingManagerStep(stepInput),
    buildFindingInterpretationStep(stepInput),
    ...adjudicationSteps,
  ];
  for (const step of syntheticSteps) {
    const providerInfo = resolveStepProviderModel({
      step,
      provider: options.provider,
      providerSource: options.providerSource,
      model: options.model,
      modelSource: options.modelSource,
      autoRouting: options.autoRouting,
      providerRouting: options.providerRouting,
      tagConflictPolicy: options.providerRoutingTagConflictPolicy,
      personaProviders: options.personaProviders,
    });
    const deterministicInfo = options.autoRouting !== undefined
      ? resolveDeterministicAutoRoutingProviderInfo({
          autoRouting: options.autoRouting,
          step: toAutoRoutingStepMetadata(step),
          currentProviderInfo: providerInfo,
        })
      : undefined;
    const configurationPath = step.name === FINDING_TERMINAL_ADJUDICATION_STEP
      || step.name === FINDING_CONFLICT_ADJUDICATION_STEP
      ? 'Configuration error: terminal-adjudicator model'
      : 'Configuration error: findings-manager model';
    validateResolvedProviderInfo(
      deterministicInfo ?? providerInfo,
      configurationPath,
      deterministicInfo !== undefined,
    );
  }
  validateFindingIntakeNormalizerProviders(config, options);
}

/**
 * Finding Contract レビュアーは1本道で、markdown レポートを正規化係が JSON 化する。
 * 正規化係は隔離 structured 実行でしか成立しないため、その解決先が対応していない
 * 構成は「レビュー1周ぶんの provider 呼び出しを捨ててから落ちる」ことになる。
 * 実行前に同じ判定（assertFindingIntakeNormalizerProvider）をかけて fail-fast する。
 *
 * 検証するのは解決チェーンの**先頭候補**だけ。やり直し候補は実行時に「先頭と
 * provider/model が異なり、かつ対応しているもの」だけを選ぶので、ロード時に
 * 存在を要求すると有効な構成を拒否してしまう。
 *
 * provider がロード時に確定しない場合は判定しない。ここで見えるのは engine option
 * と workflow の値だけで、実行時解決はさらに下位のレイヤ（project / global /
 * provider 既定）を持つ。未確定を設定エラー扱いにすると、実行時には解決できる
 * 構成をロード時に拒否することになる。未解決そのものは実行時に fail-loud する。
 */
function validateFindingIntakeNormalizerProviders(
  config: WorkflowConfig,
  options: FindingContractSyntheticProviderValidationOptions,
): void {
  // 実行時（OptionsBuilder.resolveStepProviderModel）と同じ入力で解決する。
  // `escalation` を落とすと、レビュアーの provider が runtime-v1 defaults 層から
  // 解決される構成でロード時の escalate 先が常に undefined になり、先頭候補が
  // 実行時と別物になる（この preflight の目的そのものが崩れる）。
  const resolve = (step: WorkflowStep): ResolvedProviderInfo => resolveStepProviderModel({
    step,
    provider: options.provider,
    providerSource: options.providerSource,
    model: options.model,
    modelSource: options.modelSource,
    autoRouting: options.autoRouting,
    providerRouting: options.providerRouting,
    tagConflictPolicy: options.providerRoutingTagConflictPolicy,
    personaProviders: options.personaProviders,
    escalation: options.providerEscalation,
  });
  for (const reviewerStep of collectFindingContractReviewerSteps(config)) {
    const headCandidate = buildFindingIntakeNormalizerSteps({
      reviewerStepName: reviewerStep.name,
      seat: options.internalAgentSeats?.intakeNormalizer,
      escalation: resolve(reviewerStep).escalation,
      workflowProvider: config.provider,
      workflowModel: config.model,
    })[0];
    if (headCandidate === undefined) {
      continue;
    }
    const headProvider = resolve(headCandidate).provider;
    if (headProvider === undefined) {
      continue;
    }
    assertFindingIntakeNormalizerProvider(headProvider, reviewerStep.name);
  }
}

/**
 * 実行時に正規化係を起動するレビュアー step（通常 agent step と parallel sub-step）。
 * 判定は StepExecutor / ParallelRunner の取り込み判定と同じ述語を共有する。
 */
function collectFindingContractReviewerSteps(config: WorkflowConfig): WorkflowStep[] {
  const reviewers: WorkflowStep[] = [];
  for (const step of config.steps) {
    if (!isDelegatedWorkflowStep(step) && !isWorkflowCallStep(step) && hasFindingContractFormat(step)) {
      reviewers.push(step);
    }
    const subSteps = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
    for (const subStep of subSteps) {
      if (!isWorkflowCallStep(subStep) && hasFindingContractFormat(subStep)) {
        reviewers.push(subStep);
      }
    }
  }
  return reviewers;
}

/**
 * output_contracts.report[].format が "*-finding-contract" 命名規約の facet を
 * 参照しているのに、そのワークフローで Finding Contract が有効でない
 * （自前の finding_contract も、workflow_call 親からの継承もない）場合を
 * 実行前に落とす。この形式のレビュー指摘は raw findings として台帳に
 * 取り込まれる前提で書かれており、台帳が無いと取り込み経路自体が存在せず、
 * 指摘が黙って捨てられて fix に届かない（final-gate が単独ステップのまま
 * この形式で出力していたケースで reviewers ↔ fix が56周・9時間回った実測がある）。
 */
function collectFindingContractFormatViolations(
  config: WorkflowConfig,
): Array<{ step: WorkflowStep; fallbackPath: readonly PropertyKey[]; stepName: string; format: string; formatIndex: number }> {
  const violations: Array<{ step: WorkflowStep; fallbackPath: readonly PropertyKey[]; stepName: string; format: string; formatIndex: number }> = [];
  const collectFromStep = (step: WorkflowStep, label: string, fallbackPath: readonly PropertyKey[]): void => {
    const findingContractFormat = findFindingContractFormat(step);
    if (findingContractFormat) {
      violations.push({
        step,
        fallbackPath,
        stepName: label,
        format: findingContractFormat.format,
        formatIndex: findingContractFormat.index,
      });
    }
    const subSteps = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
    for (const [subStepIndex, subStep] of subSteps.entries()) {
      collectFromStep(subStep, `${label}.${subStep.name}`, [...fallbackPath, 'parallel', subStepIndex]);
    }
  };
  for (const [stepIndex, step] of config.steps.entries()) {
    collectFromStep(step, step.name, ['steps', stepIndex]);
  }
  return violations;
}

function validateFindingContractOutputFormatRequiresContract(
  config: WorkflowConfig,
  findingContractEnabled: boolean,
): void {
  if (findingContractEnabled) {
    return;
  }
  const violations = collectFindingContractFormatViolations(config);
  if (violations.length === 0) {
    return;
  }
  const detail = violations.map((v) => `step "${v.stepName}" uses format "${v.format}"`).join(', ');
  const violation = violations[0]!;
  throw withConfigStepErrorPath(
    config,
    violation.step,
    violation.fallbackPath,
    ['output_contracts', 'report', violation.formatIndex, 'format'],
    new Error(
      `Configuration error: workflow "${config.name}" has no finding_contract (own or inherited via workflow_call), `
      + `but ${detail} which requires a Finding Contract ledger to ingest its raw findings`,
    ),
  );
}

function validateFindingContractReviewerReports(
  config: WorkflowConfig,
  findingContractEnabled: boolean,
): void {
  if (!findingContractEnabled) {
    return;
  }
  const visit = (
    step: WorkflowStep,
    fallbackPath: readonly PropertyKey[],
    parallelReviewer: boolean,
  ): void => {
    const reviewer = parallelReviewer || hasFindingContractFormat(step);
    if (reviewer && getWorkflowStepKind(step) === 'agent') {
      const reports = step.outputContracts ?? [];
      if (reports.length !== 1 || !hasFindingContractFormat(step)) {
        throw withConfigStepErrorPath(
          config,
          step,
          fallbackPath,
          ['output_contracts', 'report'],
          new Error(
            `Configuration error: Finding Contract reviewer "${step.name}" requires exactly one Finding Contract report`,
          ),
        );
      }
    }
    const siblingReportOwnerByName = new Map<string, WorkflowStep>();
    const parallelEntries = step.parallel === undefined
      ? []
      : isDynamicParallelSubSteps(step.parallel)
        ? [
            ...step.parallel.fixed.map((subStep, index) => ({ subStep, path: ['fixed', index] as const })),
            ...step.parallel.pool.map((subStep, index) => ({ subStep, path: ['pool', index] as const })),
          ]
        : step.parallel.map((subStep, index) => ({ subStep, path: [index] as const }));
    for (const { subStep, path } of parallelEntries) {
      const subStepPath = [...fallbackPath, 'parallel', ...path];
      visit(subStep, subStepPath, true);
      if (getWorkflowStepKind(subStep) !== 'agent') {
        continue;
      }
      const reportName = subStep.outputContracts![0]!.name;
      const existingOwner = siblingReportOwnerByName.get(reportName);
      if (existingOwner !== undefined) {
        throw withConfigStepErrorPath(
          config,
          subStep,
          subStepPath,
          ['output_contracts', 'report', 0, 'name'],
          new Error(
            `Configuration error: Finding Contract reviewers "${existingOwner.name}" and "${subStep.name}" under parallel step "${step.name}" use duplicate report name "${reportName}"`,
          ),
        );
      }
      siblingReportOwnerByName.set(reportName, subStep);
    }
  };
  for (const [index, step] of config.steps.entries()) {
    visit(step, ['steps', index], false);
  }
}

/**
 * Finding Contract reviewers resume from persisted markdown publications and
 * therefore do not execute an implementer session on that path. A companion
 * cannot establish or re-verify its same-session completion state there, so
 * the two responsibilities must not be combined on one reviewer step.
 */
function validateFindingContractCompanionCompatibility(
  config: WorkflowConfig,
  findingContractEnabled: boolean,
): void {
  if (!findingContractEnabled) return;

  const visit = (
    step: WorkflowStep,
    fallbackPath: readonly PropertyKey[],
  ): void => {
    if (
      isNormalAgentWorkflowStep(step)
      && step.companion !== undefined
      && hasFindingContractFormat(step)
    ) {
      throw withConfigStepErrorPath(
        config,
        step,
        fallbackPath,
        ['companion'],
        new Error(
          `Configuration error: Finding Contract reviewer "${step.name}" cannot declare companion; `
          + 'publication resume and same-session Companion completion are incompatible',
        ),
      );
    }

    const parallelEntries = step.parallel === undefined
      ? []
      : isDynamicParallelSubSteps(step.parallel)
        ? [
            ...step.parallel.fixed.map((subStep, index) => ({ subStep, path: ['fixed', index] as const })),
            ...step.parallel.pool.map((subStep, index) => ({ subStep, path: ['pool', index] as const })),
          ]
        : step.parallel.map((subStep, index) => ({ subStep, path: [index] as const }));
    for (const { subStep, path } of parallelEntries) {
      visit(subStep, [...fallbackPath, 'parallel', ...path]);
    }
  };

  for (const [index, step] of config.steps.entries()) {
    visit(step, ['steps', index]);
  }
}

function delegatedExecutionFieldPath(step: WorkflowStep): readonly PropertyKey[] {
  if (step.teamLeader !== undefined) {
    return ['team_leader'];
  }
  if (step.arpeggio !== undefined) {
    return ['arpeggio'];
  }
  throw new Error(`Invalid delegated step "${step.name}": missing delegated execution configuration`);
}

function validateFindingContractDelegatedIntake(config: WorkflowConfig, findingContractEnabled: boolean): void {
  if (!findingContractEnabled) {
    return;
  }
  for (const [stepIndex, step] of config.steps.entries()) {
    if (
      !isDelegatedWorkflowStep(step)
      || (step.parallel !== undefined && getAllParallelSubSteps(step.parallel).length > 0)
    ) {
      continue;
    }
    const findingContractFormat = findFindingContractFormat(step);
    if (findingContractFormat) {
      throw withConfigStepErrorPath(
        config,
        step,
        ['steps', stepIndex],
        delegatedExecutionFieldPath(step),
        new Error(
          `Invalid delegated step "${step.name}": format "${findingContractFormat.format}" cannot be used because finding_contract intake is unavailable`,
        ),
      );
    }
  }
}

function validateFindingContractTeamLeaderMode(config: WorkflowConfig, findingContractEnabled: boolean): void {
  const violation = config.steps.find((step) => step.teamLeader?.mode === 'finding_contract_fix');
  if (!violation || findingContractEnabled) {
    return;
  }
  const stepIndex = config.steps.indexOf(violation);
  throw withConfigStepErrorPath(
    config,
    violation,
    ['steps', stepIndex],
    ['team_leader', 'mode'],
    new Error(`Configuration error: team_leader.mode "finding_contract_fix" on step "${violation.name}" requires finding_contract`),
  );
}

function validateRequiredInheritedFindingContract(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
): void {
  if (
    config.subworkflow?.requiresFindingContract === true
    && options.inheritedFindingContract === undefined
  ) {
    throw new Error(
      `Configuration error: workflow "${config.name}" requires a finding_contract inherited from a workflow_call caller`,
    );
  }
}

function validateAgentStepProviderModel(
  step: WorkflowConfig['steps'][number],
  options: WorkflowEngineOptions,
  source: string,
  stepPath: readonly PropertyKey[],
): void {
  if (getWorkflowStepKind(step) !== 'agent') {
    return;
  }
  const agentStep = step as AgentWorkflowStep;
  const providerInfo = resolveStepProviderModel({
    step: agentStep,
    provider: options.provider,
    providerSource: options.providerSource,
    model: options.model,
    modelSource: options.modelSource,
    autoRouting: options.autoRouting,
    providerRouting: options.providerRouting,
    tagConflictPolicy: options.providerRoutingTagConflictPolicy,
    personaProviders: options.personaProviders,
  });
  let validationInfos: ValidationProviderInfo[];
  try {
    validationInfos = expandAutoRoutingProviderInfos(agentStep, providerInfo, options.autoRouting);
  } catch (error) {
    const field = providerValidationField(error, agentStep.model !== undefined ? 'model' : 'provider');
    throw withWorkflowConfigErrorPath(error, [
      ...stepPath,
      field,
    ]);
  }
  for (const validationInfo of validationInfos) {
    try {
      validateResolvedProviderInfo(
        validationInfo.providerInfo,
        `${source}.model`,
        validationInfo.autoRouted,
      );
    } catch (error) {
      const field = providerValidationField(error, agentStep.model !== undefined ? 'model' : 'provider');
      throw withWorkflowConfigErrorPath(error, [
        ...stepPath,
        field,
      ]);
    }
    validatePromotionProviderModels(
      agentStep,
      validationInfo.providerInfo,
      source,
      validationInfo.autoRouted,
      stepPath,
    );
  }
}

function validateSessionEntrypoint(step: WorkflowStep, source: string): void {
  const candidate = step as {
    session?: unknown;
    parallel?: unknown[];
    arpeggio?: unknown;
    teamLeader?: unknown;
  };

  if (candidate.session === undefined) {
    return;
  }

  if (getWorkflowStepKind(step) !== 'agent') {
    throw new Error(`${source}: ${SESSION_AGENT_STEP_REQUIRED_MESSAGE}`);
  }

  if (candidate.parallel !== undefined || candidate.arpeggio !== undefined || candidate.teamLeader !== undefined) {
    throw new Error(`${source}: ${SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE}`);
  }
}

function validatePromotionProviderModels(
  step: AgentWorkflowStep,
  baseProviderInfo: ResolvedProviderInfo,
  source: string,
  autoRouted: boolean,
  stepPath: readonly PropertyKey[],
): void {
  for (const [index, promotion] of (step.promotion ?? []).entries()) {
    const promotedProviderInfo = applyProviderModelOverride(baseProviderInfo, {
      provider: promotion.provider,
      providerSpecified: promotion.providerSpecified === true || promotion.provider !== undefined,
      model: promotion.model,
      modelSpecified: promotion.model !== undefined,
      source: 'promotion',
    });
    try {
      validateResolvedProviderInfo(
        promotedProviderInfo,
        `${source}.promotion[${index}].model`,
        autoRouted,
      );
    } catch (error) {
      const field = providerValidationField(error, promotion.model !== undefined ? 'model' : 'provider');
      throw withWorkflowConfigErrorPath(error, [
        ...stepPath,
        'promotion', index, field,
      ]);
    }
  }
}

function validateWorkflowStepNamesUnique(config: WorkflowConfig): void {
  const duplicate = findDuplicateWorkflowStepName(config.steps);
  if (!duplicate) {
    return;
  }
  if (duplicate.parentName) {
    throw withWorkflowConfigErrorPath(
      new Error(`Configuration error: parallel step "${duplicate.parentName}" contains duplicate sub-step name "${duplicate.name}"`),
      duplicate.path,
    );
  }
  throw withWorkflowConfigErrorPath(
    new Error(`Configuration error: workflow contains duplicate step name "${duplicate.name}"`),
    duplicate.path,
  );
}

function findWorkflowCallStep(
  steps: readonly WorkflowStep[],
  parentPath: readonly PropertyKey[] = ['steps'],
): { step: WorkflowStep; path: readonly PropertyKey[] } | undefined {
  for (const [index, step] of steps.entries()) {
    const path = [...parentPath, index];
    if (isWorkflowCallStep(step)) {
      return { step, path };
    }
    const nested = findWorkflowCallStep(
      step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel),
      [...path, 'parallel'],
    );
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

export function validateWorkflowConfig(config: WorkflowConfig, options: WorkflowEngineOptions): void {
  const initialStep = config.steps.find((step) => step.name === config.initialStep);
  if (!initialStep) {
    throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(config.initialStep));
  }
  validateDynamicParallelContracts(config.steps, ['steps']);
  // 子ワークフローが自前の finding_contract を持たず、workflow_call の親から
  // 継承しているだけのケースも「Finding Contract 有効」として扱う。継承した
  // 契約は ParallelRunner の raw findings 自動付与・manager 起動をそのまま
  // 動かすため（WorkflowEngineSetup 経由で effective contract を渡す）、
  // ここでの検証もランタイムと同じ判定基準を使わないと validate 時は素通り
  // したのに実行時に落ちる、という食い違いが生まれる。
  const findingContractEnabled = config.findingContract !== undefined || options.inheritedFindingContract !== undefined;
  validateFindingContractStructuredOutput(config, findingContractEnabled);
  validateFindingContractSyntheticProviderModels(config, options);
  validateFindingConflictAdjudicationReservedName(config);
  validateWorkflowStepNamesUnique(config);
  validateRequiredInheritedFindingContract(config, options);
  validateFindingContractOutputFormatRequiresContract(config, findingContractEnabled);
  validateFindingContractReviewerReports(config, findingContractEnabled);
  validateFindingContractCompanionCompatibility(config, findingContractEnabled);
  validateFindingContractDelegatedIntake(config, findingContractEnabled);
  validateFindingContractTeamLeaderMode(config, findingContractEnabled);

  if (options.startStep) {
    const startStep = config.steps.find((step) => step.name === options.startStep);
    if (!startStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(options.startStep));
    }
  }

  const workflowCallStep = findWorkflowCallStep(config.steps);
  if (workflowCallStep !== undefined && !options.workflowCallResolver) {
    throw withConfigStepErrorPath(
      config,
      workflowCallStep.step,
      workflowCallStep.path,
      ['call'],
      new Error('Configuration error: workflowCallResolver is required when workflow contains workflow_call steps'),
    );
  }

  const stepNames = new Set(config.steps.map((step) => step.name));
  stepNames.add(COMPLETE_STEP);
  stepNames.add(ABORT_STEP);
  stepNames.add(FINDING_CONFLICT_ADJUDICATION_STEP);

  for (const [stepIndex, step] of config.steps.entries()) {
    try {
      const stepPath = findWorkflowStepLocation(config, step) ?? ['steps', stepIndex];
      try {
        validateSessionEntrypoint(step, `Configuration error: step "${step.name}"`);
      } catch (error) {
        throw withWorkflowStepErrorPath(error, [...stepPath, 'session']);
      }
      try {
        validateAgentStepProviderModel(step, options, `Configuration error: step "${step.name}"`, stepPath);
      } catch (error) {
        throw withWorkflowStepErrorPath(error, stepPath);
      }
      validateAggregateRulePlacement(
        step.rules ?? [],
        step.parallel !== undefined && getAllParallelSubSteps(step.parallel).length > 0,
        `Invalid rule in step "${step.name}"`,
        [...stepPath, 'rules'],
      );
      validateSemanticAppendices(step.rules ?? [], `Invalid rule in step "${step.name}"`, [...stepPath, 'rules']);
      for (const [ruleIndex, rule] of (step.rules ?? []).entries()) {
        if (rule.next && !stepNames.has(rule.next)) {
          throw withWorkflowStepErrorPath(
            new Error(`Invalid rule in step "${step.name}": target step "${rule.next}" does not exist`),
            [...stepPath, 'rules', ruleIndex],
          );
        }
        try {
          validateFindingsRuleContract(
            findingContractEnabled,
            rule,
            `Invalid rule in step "${step.name}"`,
          );
          validateFindingConflictAdjudicationRuleContract(
            findingContractEnabled,
            rule,
            `Invalid rule in step "${step.name}"`,
          );
        } catch (error) {
          throw withWorkflowStepErrorPath(error, [...stepPath, 'rules', ruleIndex]);
        }
      }
      const subSteps = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
      for (const [subStepIndex, subStep] of subSteps.entries()) {
        const subStepPath = findWorkflowStepLocation(config, subStep)
          ?? ['steps', stepIndex, 'parallel', subStepIndex];
          validateAggregateRulePlacement(
            subStep.rules ?? [],
            false,
            `Invalid rule in parallel sub-step "${subStep.name}" of step "${step.name}"`,
            [...subStepPath, 'rules'],
          );
          validateSemanticAppendices(
            subStep.rules ?? [],
            `Invalid rule in parallel sub-step "${subStep.name}" of step "${step.name}"`,
            [...subStepPath, 'rules'],
          );
          try {
            validateSessionEntrypoint(
              subStep,
              `Configuration error: parallel sub-step "${subStep.name}" of step "${step.name}"`,
            );
          } catch (error) {
            throw withWorkflowStepErrorPath(error, [...subStepPath, 'session']);
          }
          if (!isDynamicParallelSubSteps(step.parallel!)) {
            try {
              validateAgentStepProviderModel(
                subStep,
                options,
                `Configuration error: parallel sub-step "${subStep.name}" of step "${step.name}"`,
                subStepPath,
              );
            } catch (error) {
              throw withWorkflowStepErrorPath(error, subStepPath);
            }
          }
          for (const [ruleIndex, rule] of (subStep.rules ?? []).entries()) {
            try {
              validateFindingsRuleContract(
                findingContractEnabled,
                rule,
                `Invalid rule in parallel sub-step "${subStep.name}" of step "${step.name}"`,
              );
              validateFindingConflictAdjudicationRuleContract(
                findingContractEnabled,
                rule,
                `Invalid rule in parallel sub-step "${subStep.name}" of step "${step.name}"`,
              );
            } catch (error) {
              throw withWorkflowStepErrorPath(error, [...subStepPath, 'rules', ruleIndex]);
            }
          }
      }
    } catch (error) {
      throw withWorkflowStepErrorPath(error, ['steps', stepIndex]);
    }
  }

  for (const [monitorIndex, monitor] of (config.loopMonitors ?? []).entries()) {
    validateAggregateRulePlacement(
      monitor.judge.rules,
      false,
      'Invalid loop_monitor judge rule',
      ['loop_monitors', monitorIndex, 'judge', 'rules'],
    );
    for (const cycleName of monitor.cycle) {
      if (!stepNames.has(cycleName)) {
        throw new Error(`Invalid loop_monitor: cycle references unknown step "${cycleName}"`);
      }
    }
    for (const ignoredName of monitor.ignoreSteps ?? []) {
      if (!stepNames.has(ignoredName)) {
        throw new Error(`Invalid loop_monitor: ignore_steps references unknown step "${ignoredName}"`);
      }
      if (monitor.cycle.includes(ignoredName)) {
        throw new Error(`Invalid loop_monitor: step "${ignoredName}" cannot appear in both cycle and ignore_steps`);
      }
    }
    for (const rule of monitor.judge.rules) {
      if (!stepNames.has(rule.next)) {
        throw new Error(`Invalid loop_monitor judge rule: target step "${rule.next}" does not exist`);
      }
      validateFindingConflictAdjudicationRuleContract(
        findingContractEnabled,
        rule,
        'Invalid loop_monitor judge rule',
      );
      validateFindingsRuleContract(
        findingContractEnabled,
        rule,
        'Invalid loop_monitor judge rule',
      );
    }

    const triggeringStep = config.steps.find((step) => step.name === monitor.cycle[monitor.cycle.length - 1]);
    if (!triggeringStep) {
      continue;
    }
    const triggeringProviderInfo = resolveStepProviderModel({
      step: triggeringStep,
      provider: options.provider,
      providerSource: options.providerSource,
      model: options.model,
      modelSource: options.modelSource,
      autoRouting: options.autoRouting,
      providerRouting: options.providerRouting,
      tagConflictPolicy: options.providerRoutingTagConflictPolicy,
      personaProviders: options.personaProviders,
    });
    // 実行時（LoopMonitorJudgeRunner）と同じ優先順位で検証するため、judge ステップ自身の
    // 通常解決（provider_routing.* / persona_providers.loop-judge を含む）も同じ
    // resolveStepProviderModel で取ってから合成する。routing キーは実行時に生成される
    // judge ステップ（_loop_judge_<cycle> / providerRoutingPersonaKey: 'loop-judge'）と揃える。
    const judgeStepProviderInfo = resolveStepProviderModel({
      step: {
        name: loopJudgeStepName(monitor.cycle),
        ...loopJudgeProviderFields(monitor.judge, options.internalAgentSeats),
        personaDisplayName: LOOP_JUDGE_ROUTING_KEY,
        providerRoutingPersonaKey: LOOP_JUDGE_ROUTING_KEY,
      },
      provider: options.provider,
      providerSource: options.providerSource,
      model: options.model,
      modelSource: options.modelSource,
      providerRouting: options.providerRouting,
      tagConflictPolicy: options.providerRoutingTagConflictPolicy,
      personaProviders: options.personaProviders,
    });
    for (const validationInfo of expandAutoRoutingProviderInfos(
      triggeringStep,
      triggeringProviderInfo,
      options.autoRouting,
    )) {
      const judgeProviderInfo = resolveLoopMonitorJudgeProviderModel({
        judge: monitor.judge,
        judgeProviderInfo: judgeStepProviderInfo,
        triggeringProviderInfo: validationInfo.providerInfo,
      });
      validateResolvedProviderInfo(
        judgeProviderInfo,
        'Configuration error: loop_monitors.judge.model',
        validationInfo.autoRouted,
      );
    }
  }
}
