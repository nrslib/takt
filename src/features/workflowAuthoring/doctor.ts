import { error, success, warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { COMPLETE_STEP, ABORT_STEP } from '../../core/workflow/constants.js';
// 実行時（escape.ts の {report:X} リゾルバ）と同じ parser を共用し、
// 静的解析と実行時の構文解釈を揃える。
import { extractReportReferences } from '../../core/workflow/instruction/report-reference.js';
import { isReservedReportFileName } from '../../core/models/reserved-report-names.js';
import { validateWorkflowConfig } from '../../core/workflow/engine/WorkflowValidator.js';
import {
  formatWorkflowRuleCondition,
  hasFindingsReference,
  hasUnquotedIdentifierReference,
  type WorkflowRuleCondition,
} from '../../core/models/workflow-rule-condition.js';
import { evaluateWhenExpression } from '../../core/workflow/evaluation/when-evaluator.js';
import { splitTopLevelClausesOrThrow } from '../../core/models/workflow-condition-expression.js';
import { resolveWorkflowConfigValues } from '../../infra/config/index.js';
import { inspectWorkflowFile, resolveWorkflowDoctorTargets } from '../../infra/config/loaders/workflowDoctor.js';
import { isMissingWorkflowCallArgError } from '../../infra/config/loaders/workflowCallableArgResolver.js';
import { loadWorkflowFileWithResolutionOptions } from '../../infra/config/loaders/workflowResolvedLoader.js';
import type { WorkflowConfig, WorkflowRule, WorkflowState, WorkflowStep } from '../../core/models/types.js';
import type { WorkflowDoctorReport, WorkflowDoctorTarget } from '../../infra/config/loaders/workflowDoctor.js';

function reportHasErrors(report: WorkflowDoctorReport): boolean {
  return report.diagnostics.some((diagnostic) => diagnostic.level === 'error');
}

function loadWorkflowForRuntimeValidation(
  target: WorkflowDoctorTarget,
  projectDir: string,
) {
  const lookupCwd = target.lookupCwd ?? projectDir;
  try {
    return loadWorkflowFileWithResolutionOptions(target.filePath, {
      projectCwd: projectDir,
      lookupCwd,
      source: target.source,
    });
  } catch (error) {
    if (!isMissingWorkflowCallArgError(error)) {
      throw error;
    }
    return loadWorkflowFileWithResolutionOptions(target.filePath, {
      projectCwd: projectDir,
      lookupCwd,
      source: target.source,
      loadMode: 'discovery',
    });
  }
}

function validateWorkflowRuntimeContract(
  report: WorkflowDoctorReport,
  target: WorkflowDoctorTarget,
  projectDir: string,
): void {
  if (reportHasErrors(report)) {
    return;
  }

  try {
    const workflow = loadWorkflowForRuntimeValidation(target, projectDir);
    const config = resolveWorkflowConfigValues(
      projectDir,
      ['provider', 'model', 'personaProviders', 'providerRouting', 'autoRouting'],
    );
    validateWorkflowConfig(workflow, {
      projectCwd: projectDir,
      provider: workflow.provider ?? config.provider,
      model: workflow.model ?? config.model,
      personaProviders: config.personaProviders,
      providerRouting: config.providerRouting,
      autoRouting: workflow.autoRouting ?? config.autoRouting,
      workflowCallResolver: () => null,
    });
    warnOnMissingProvisionalRouting(report, workflow);
    warnOnUnsafeFindingBudgetRouting(report, workflow);
    warnOnMissingReviewerAnomalyRouting(report, workflow);
    warnOnUnproducibleReportReferences(report, workflow);
  } catch (validationError) {
    report.diagnostics.push({
      level: 'error',
      message: getErrorMessage(validationError),
    });
  }
}

function warnOnUnsafeFindingBudgetRouting(
  report: WorkflowDoctorReport,
  workflow: ReturnType<typeof loadWorkflowForRuntimeValidation>,
): void {
  if (workflow.findingContract === undefined) {
    return;
  }

  for (const step of workflow.steps) {
    for (const rule of step.rules ?? []) {
      if (!isFindingBudgetCondition(rule)) {
        continue;
      }
      if (rule.next === ABORT_STEP) {
        report.diagnostics.push({
          level: 'warning',
          message: `step "${step.name}" routes a finding fixpoint or exhausted budget directly to ABORT. `
            + 'Route it to a requirements-preserving replan first, and let replan or a bounded loop monitor ABORT only when no feasible approach can satisfy the requirements.',
        });
        continue;
      }
      if (rule.next !== undefined && !hasBoundedReplanMonitor(workflow, step.name, rule.next)) {
        report.diagnostics.push({
          level: 'warning',
          message: `step "${step.name}" routes a finding fixpoint or exhausted budget to "${rule.next}" without a bounded replan monitor. `
            + 'Add a loop monitor that observes the replan cycle and can ABORT only when no feasible requirements-compliant approach remains.',
        });
      }
    }
  }
}

function isFindingBudgetCondition(rule: WorkflowRule): boolean {
  const condition = getRuleGuardCondition(rule);
  if (condition === undefined) {
    return false;
  }
  return [
    'findings.provisional.fixpoint',
    'findings.rounds.budgetExhausted',
    'findings.reviewerAnomalies.budgetExhausted',
  ].some((identifier) => hasUnquotedIdentifierReference(condition, identifier));
}

function hasBoundedReplanMonitor(workflow: WorkflowConfig, sourceStep: string, replanStep: string): boolean {
  const target = workflow.steps.find((step) => step.name === replanStep);
  if (target?.tags?.includes('plan') !== true) {
    return false;
  }
  return (workflow.loopMonitors ?? []).some((monitor) => (
    monitor.threshold > 0
    && monitor.cycle[0] === replanStep
    && monitor.cycle[monitor.cycle.length - 1] === sourceStep
    && monitor.judge.rules.some((rule) => rule.next === ABORT_STEP)
  ));
}

/**
 * v2 梯子設計への移行警告: run-level の invalid_manager_output（旧: 迂回ルールの
 * 自動選択）は廃止され、manager の壊れた応答・意味不明な raw は gate-blocking な
 * provisional finding として台帳に着地する。finding_contract を使う workflow が
 * findings.provisional.count を一切参照していない場合、provisional 残存時に
 * COMPLETE がエンジン最終不変条件で abort する（旧 rules 構成のままだと
 * needs_fix 等の自動迂回は発火しない）ため、移行を促す警告を出す。
 */
function warnOnMissingProvisionalRouting(
  report: WorkflowDoctorReport,
  workflow: ReturnType<typeof loadWorkflowForRuntimeValidation>,
): void {
  if (workflow.findingContract === undefined) {
    return;
  }
  const referencesProvisional = workflow.steps.some((step) => (
    (step.rules ?? []).some((rule) => {
      const condition = getRuleGuardCondition(rule);
      return condition !== undefined
        && hasUnquotedIdentifierReference(condition, 'findings.provisional');
    })
  ));
  if (referencesProvisional) {
    return;
  }
  report.diagnostics.push({
    level: 'warning',
    message: 'finding_contract workflow has no rule routing on findings.provisional.count. '
      + 'In the v2 raw-finding ladder, invalid manager output no longer auto-selects a needs_fix/need_replan detour rule; '
      + 'undeterminable observations land as gate-blocking provisional findings instead, and a transition to COMPLETE '
      + 'while any provisional finding is open aborts the workflow. '
      + 'Add a rule such as `when(findings.provisional.count > 0 && findings.conflicts.count == 0) -> <replan step>` before your COMPLETE rule.',
  });
}

/**
 * review-integrity の配線漏れ警告: reviewer anomaly は product finding ではないため、
 * open/conflicts だけを COMPLETE 条件にした workflow では、再レビューまたは予算切れ時の
 * 有限停止へ送らなければ、検証不能な観測を残したまま完了できてしまう。完了ゲートを持つ
 * Finding Contract workflow に限定して、各 COMPLETE gate より先に実際に選ばれる
 * anomaly 経路を検査する。
 */
function warnOnMissingReviewerAnomalyRouting(
  report: WorkflowDoctorReport,
  workflow: ReturnType<typeof loadWorkflowForRuntimeValidation>,
): void {
  if (workflow.findingContract === undefined) {
    return;
  }
  const hasUnsafeCompletionGate = workflow.steps.some((step) => (
    (step.rules ?? []).some((rule, completeRuleIndex) => (
      rule.next === COMPLETE_STEP
      && isReviewerOrFindingsCompletionGate(step, rule)
      && !hasEffectiveReviewerAnomalyRouting(workflow, step, completeRuleIndex)
    ))
  ));
  if (!hasUnsafeCompletionGate) {
    return;
  }
  report.diagnostics.push({
    level: 'warning',
    message: 'finding_contract workflow has a COMPLETE gate without an effective reviewer-anomaly route. '
      + 'Reviewer anomalies are not product findings, so an empty product gate can otherwise COMPLETE without a mechanically verified review. '
      + 'Route findings.reviewerAnomalies.count to a review-tagged re-review step, with a preceding '
      + 'findings.reviewerAnomalies.budgetExhausted route to a bounded requirements-preserving replan. A '
      + 'findings.reviewerAnomalies.count route to COMPLETE or an arbitrary fix step is not safe.',
  });
}

function isReviewerOrFindingsCompletionGate(step: WorkflowStep, rule: WorkflowRule): boolean {
  return hasReviewTag(step)
    || hasFindingsReference(rule.condition);
}

function hasReviewTag(step: WorkflowStep): boolean {
  return step.tags?.includes('review') === true
    || step.parallel?.some((child) => child.tags?.includes('review') === true) === true;
}

function hasEffectiveReviewerAnomalyRouting(
  workflow: WorkflowConfig,
  step: WorkflowStep,
  completeRuleIndex: number,
): boolean {
  const rules = step.rules ?? [];
  const completeRule = rules[completeRuleIndex];
  if (completeRule === undefined) {
    return false;
  }
  validateReviewerAnomalyExpressions(rules);
  if (!isCompletionReachable(step, completeRuleIndex)) {
    return true;
  }

  const terminalRoute = rules[completeRuleIndex - 2];
  const reReviewRoute = rules[completeRuleIndex - 1];
  return terminalRoute !== undefined
    && reReviewRoute !== undefined
    && isSafeReviewerAnomalyBudgetRoute(workflow, step.name, terminalRoute)
    && isReReviewRoute(workflow, reReviewRoute)
    && hasExpectedReviewerAnomalyGuard(terminalRoute, completeRule, true)
    && hasExpectedReviewerAnomalyGuard(reReviewRoute, completeRule, false)
    && aggregateRouteCoversCompletion(step, terminalRoute, completeRule)
    && aggregateRouteCoversCompletion(step, reReviewRoute, completeRule);
}

function validateReviewerAnomalyExpressions(rules: readonly WorkflowRule[]): void {
  for (const rule of rules) {
    const condition = getRuleGuardCondition(rule);
    if (condition === undefined || !hasUnquotedIdentifierReference(condition, 'findings.reviewerAnomalies')) {
      continue;
    }
    for (const count of [0, 1]) {
      for (const budgetExhausted of [false, true]) {
        evaluateWhenExpression(condition, createReviewerAnomalyValidationState(count, budgetExhausted));
      }
    }
  }
}

function createReviewerAnomalyValidationState(count: number, budgetExhausted: boolean): WorkflowState {
  return {
    findings: {
      open: { count: 0 },
      provisional: { count: 0, fixpoint: false },
      rounds: { budgetExhausted: false },
      reviewerAnomalies: { count, budgetExhausted },
      conflicts: { count: 0, unadjudicated: { count: 0 } },
    },
  } as WorkflowState;
}

function hasExpectedReviewerAnomalyGuard(
  rule: WorkflowRule,
  completeRule: WorkflowRule,
  requiresBudgetExhaustion: boolean,
): boolean {
  const condition = getRuleGuardCondition(rule);
  if (condition === undefined) {
    return false;
  }
  const expected = splitTopLevelClausesOrThrow(
    getRuleGuardCondition(completeRule) ?? 'true',
    '&&',
    'COMPLETE condition',
  );
  expected.push('findings.reviewerAnomalies.count > 0');
  if (requiresBudgetExhaustion) {
    expected.push('findings.reviewerAnomalies.budgetExhausted == true');
  }
  const actual = splitTopLevelClausesOrThrow(condition, '&&', 'reviewer anomaly condition');
  return actual.length === expected.length && actual.every((clause) => expected.includes(clause));
}

function getRuleGuardCondition(rule: WorkflowRule): string | undefined {
  return whenExpressionOf(rule.condition);
}

function whenExpressionOf(condition: WorkflowRuleCondition): string | undefined {
  if (condition.kind === 'when') return condition.expression;
  return condition.kind === 'and' && condition.right.kind === 'when'
    ? condition.right.expression
    : undefined;
}

function aggregateOf(condition: WorkflowRuleCondition): Extract<WorkflowRuleCondition, { kind: 'aggregate' }> | undefined {
  if (condition.kind === 'aggregate') return condition;
  return condition.kind === 'and' && condition.left.kind === 'aggregate'
    ? condition.left
    : undefined;
}

function aggregateRouteCoversCompletion(
  step: WorkflowStep,
  route: WorkflowRule,
  completeRule: WorkflowRule,
): boolean {
  const routeAggregate = aggregateOf(route.condition);
  const completeAggregate = aggregateOf(completeRule.condition);
  if (routeAggregate === undefined || completeAggregate === undefined || step.parallel === undefined) {
    return false;
  }
  const completionOutputs = getPossibleCompletionOutputs(step.parallel, completeRule);
  if (completionOutputs === undefined) {
    return false;
  }
  if (routeAggregate.aggregate === 'any') {
    const routeTargets = getAggregateTargets(route);
    return completeAggregate.aggregate === 'all'
      ? completionOutputs.some((output) => routeTargets.has(output))
      : completionOutputs.every((output) => routeTargets.has(output));
  }
  if (routeAggregate.aggregate === 'all' && completeAggregate.aggregate === 'all') {
    const routeOutputs = getPossibleCompletionOutputs(step.parallel, route);
    return routeOutputs !== undefined
      && routeOutputs.length === completionOutputs.length
      && routeOutputs.every((output, index) => output === completionOutputs[index]);
  }
  return false;
}

function getPossibleCompletionOutputs(
  parallel: readonly WorkflowStep[],
  completeRule: WorkflowRule,
): string[] | undefined {
  if (parallel.length === 0) {
    return undefined;
  }
  const aggregate = aggregateOf(completeRule.condition);
  const targets = getAggregateTargets(completeRule);
  if (aggregate === undefined || targets.size === 0) {
    return undefined;
  }
  if (aggregate.aggregate === 'any') {
    const possible = parallel.flatMap((child) => (
      formattedRuleConditions(child).filter((condition) => targets.has(condition))
    ));
    return possible.length === 0 ? undefined : possible;
  }
  const aggregateTargets = aggregate.targetConditions.map(formatWorkflowRuleCondition);
  const allTargets = aggregateTargets.length === 1
    ? parallel.map(() => aggregateTargets[0]!)
    : aggregateTargets;
  if (allTargets.length !== parallel.length) {
    return undefined;
  }
  return parallel.every((child, index) => (
    formattedRuleConditions(child).includes(allTargets[index]!)
  ))
    ? allTargets
    : undefined;
}

function formattedRuleConditions(step: WorkflowStep): string[] {
  return (step.rules ?? []).map((rule) => formatWorkflowRuleCondition(rule.condition));
}

function getAggregateTargets(rule: WorkflowRule): Set<string> {
  const aggregate = aggregateOf(rule.condition);
  if (aggregate === undefined) {
    return new Set();
  }
  return new Set(aggregate.targetConditions.map(formatWorkflowRuleCondition));
}

function isSafeReviewerAnomalyBudgetRoute(
  workflow: WorkflowConfig,
  sourceStep: string,
  rule: WorkflowRule,
): boolean {
  if (rule.returnValue === 'need_replan') {
    return true;
  }
  return rule.next !== undefined && hasBoundedReplanMonitor(workflow, sourceStep, rule.next);
}

function isReReviewRoute(workflow: WorkflowConfig, rule: WorkflowRule): boolean {
  return rule.next !== undefined
    && workflow.steps.some((step) => step.name === rule.next && hasReviewTag(step));
}

function isCompletionReachable(step: WorkflowStep, completeRuleIndex: number): boolean {
  const completeRule = step.rules?.[completeRuleIndex];
  if (completeRule !== undefined && aggregateOf(completeRule.condition) !== undefined) {
    return getPossibleCompletionOutputs(step.parallel ?? [], completeRule) !== undefined
      && !(step.rules ?? []).slice(0, completeRuleIndex).some((rule) => (
        isEarlierAggregateTerminalRoute(step, rule, completeRule)
      ));
  }
  return !(step.rules ?? []).slice(0, completeRuleIndex).some((rule) => (
    rule.next !== undefined
    && rule.next !== COMPLETE_STEP
    && isKnownAlwaysMatchingImmediateCondition(rule)
  ));
}

function isEarlierAggregateTerminalRoute(
  step: WorkflowStep,
  rule: WorkflowRule,
  completeRule: WorkflowRule,
): boolean {
  if (rule.next === undefined || rule.next === COMPLETE_STEP || aggregateOf(rule.condition) === undefined) {
    return false;
  }
  const terminalGuard = getRuleGuardCondition(rule);
  const completionGuard = getRuleGuardCondition(completeRule);
  return (terminalGuard === undefined || terminalGuard === completionGuard)
    && aggregateRouteCoversCompletion(step, rule, completeRule);
}

function isKnownAlwaysMatchingImmediateCondition(rule: WorkflowRule): boolean {
  if (rule.condition.kind !== 'when') {
    return false;
  }
  const condition = rule.condition.expression;
  return condition === 'true'
    || condition === 'findings.open.count >= 0';
}

function collectContractReportNames(step: WorkflowStep, into: Set<string>): void {
  for (const contract of step.outputContracts ?? []) {
    into.add(contract.name);
  }
  for (const subStep of step.parallel ?? []) {
    collectContractReportNames(subStep, into);
  }
}

/** Forward routing edges: step name -> step names it can transition to. */
function buildRoutingEdges(workflow: WorkflowConfig, stepNames: Set<string>): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (to === COMPLETE_STEP || to === ABORT_STEP || !stepNames.has(to)) {
      return;
    }
    const targets = edges.get(from) ?? new Set<string>();
    targets.add(to);
    edges.set(from, targets);
  };
  for (const step of workflow.steps) {
    for (const rule of step.rules ?? []) {
      if (rule.next !== undefined) {
        addEdge(step.name, rule.next);
      }
    }
  }
  for (const monitor of workflow.loopMonitors ?? []) {
    // judge は cycle が threshold 回完走した後にしか発火しない。cycle の
    // 途中ステップからエッジを張ると「cycle 後半の producer を通らない偽の
    // 早期経路」が生まれ dominator 判定が偽陽性になる（boundary requirement）。
    // cycle 最後のステップからのみ張る — 最後のステップの AVAIL には
    // cycle 前半の成果物が通常の rules エッジ経由で伝播している。
    const lastCycleStep = monitor.cycle[monitor.cycle.length - 1];
    if (lastCycleStep === undefined) {
      continue;
    }
    for (const rule of monitor.judge.rules) {
      addEdge(lastCycleStep, rule.next);
    }
  }
  return edges;
}

/**
 * Forward data-flow: for every step reachable from the initial step, the set of
 * report names guaranteed to exist when the step starts — the intersection over
 * all incoming paths of the reports produced strictly before arrival.
 * `WILDCARD_REPORT` stands for "any report" (workflow_call children write
 * unknown report names into the same run directory).
 */
const WILDCARD_REPORT = '*';

/**
 * `*`（workflow_call = 任意レポートの producer）は全集合として扱う: 交差では
 * 通常要素として比較せず、もう一方の集合に吸収される（{"*"} ∩ {"X"} = {"X"}）。
 * boundary requirement: `*` を通常要素として交差すると、workflow_call 経路と実 producer
 * 経路の合流で交差が空になり偽陽性が出る。
 */
function intersectGuaranteedReports(a: Set<string>, b: Set<string>): Set<string> {
  if (a.has(WILDCARD_REPORT)) {
    return new Set(b);
  }
  if (b.has(WILDCARD_REPORT)) {
    return new Set(a);
  }
  return new Set([...a].filter((name) => b.has(name)));
}

function reportSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const name of a) {
    if (!b.has(name)) {
      return false;
    }
  }
  return true;
}

function computeGuaranteedReportsByStep(
  initialStep: string,
  edges: Map<string, Set<string>>,
  producedByStep: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const available = new Map<string, Set<string>>([[initialStep, new Set<string>()]]);
  const queue = [initialStep];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const availableHere = available.get(current) ?? new Set<string>();
    const availableAfter = new Set([...availableHere, ...(producedByStep.get(current) ?? [])]);
    for (const next of edges.get(current) ?? []) {
      const known = available.get(next);
      if (known === undefined) {
        available.set(next, new Set(availableAfter));
        queue.push(next);
        continue;
      }
      const merged = intersectGuaranteedReports(known, availableAfter);
      // `*` の吸収で要素数が変わらず中身だけ変わるケースがあるため、
      // 変化検知はサイズではなく集合の等価性で行う。
      if (!reportSetsEqual(merged, known)) {
        available.set(next, merged);
        queue.push(next);
      }
    }
  }
  return available;
}

/**
 * v3-r4 の裁定ステップ死因（arbitrate が後段 reviewers の
 * ai-antipattern-review.md を参照して詰み → ルール不一致 abort）の再発防止。
 * インストラクション内の {report:X} は存在チェックなしの単純パス置換なので、
 * X がそのステップより前に実行され得るステップの output_contracts に無い場合、
 * エージェントは実在しないレポートを探して行き詰まる。ここで警告する。
 *
 * workflow_call ステップは子ワークフローのレポートを同じ run ディレクトリに
 * 書くため、その成果物名はここからは見えない。偽陽性を避けるため
 * workflow_call ステップは任意のレポート名の producer として扱う。同様に、
 * callable サブワークフロー自身は親 run が先に書いたレポート（例: draft.yaml の
 * implement が参照する plan.md）を前提にできるため、チェック対象外とする。
 */
function warnOnUnproducibleReportReferences(
  report: WorkflowDoctorReport,
  workflow: WorkflowConfig,
): void {
  if (workflow.subworkflow?.callable === true) {
    return;
  }
  const stepNames = new Set(workflow.steps.map((step) => step.name));
  const producedByStep = new Map<string, Set<string>>();
  const allProducedReports = new Set<string>();
  for (const step of workflow.steps) {
    const contractNames = new Set<string>();
    collectContractReportNames(step, contractNames);
    if (step.kind === 'workflow_call') {
      contractNames.add(WILDCARD_REPORT);
    }
    producedByStep.set(step.name, contractNames);
    for (const name of contractNames) {
      allProducedReports.add(name);
    }
  }
  const edges = buildRoutingEdges(workflow, stepNames);
  const guaranteedByStep = computeGuaranteedReportsByStep(workflow.initialStep, edges, producedByStep);

  const isGuaranteedAt = (reportName: string, stepName: string): boolean => {
    const guaranteed = guaranteedByStep.get(stepName);
    // Steps unreachable from the initial step have no path evidence; stay silent.
    if (guaranteed === undefined) {
      return true;
    }
    return guaranteed.has(reportName) || guaranteed.has(WILDCARD_REPORT);
  };

  const warnReference = (reportName: string, location: string, detail: string): void => {
    report.diagnostics.push({
      level: 'warning',
      message: `${location} references {report:${reportName}} but ${detail} `
        + '{report:} is substituted without an existence check, so the agent will look for a file that does not exist yet. '
        + 'Point the reference at a report produced by an earlier step, or move/rename the output contract.',
    });
  };

  for (const step of workflow.steps) {
    const references = new Set(extractReportReferences(step.instruction));
    for (const subStep of step.parallel ?? []) {
      for (const reference of extractReportReferences(subStep.instruction)) {
        references.add(reference);
      }
    }
    for (const reference of references) {
      if (isReservedReportFileName(reference)) {
        report.diagnostics.push({
          level: 'error',
          message: `step "${step.name}" references {report:${reference}}, which is a reserved internal file `
            + '(resume-artifacts.json holds the resume snapshot manifest) and cannot be used as a report.',
        });
        continue;
      }
      if (!allProducedReports.has(reference) && !allProducedReports.has(WILDCARD_REPORT)) {
        warnReference(reference, `step "${step.name}"`, 'no step\'s output_contracts produce that report.');
        continue;
      }
      if (!isGuaranteedAt(reference, step.name)) {
        warnReference(
          reference,
          `step "${step.name}"`,
          'the workflow can reach that step before any step producing the report has run.',
        );
      }
    }
  }

  for (const monitor of workflow.loopMonitors ?? []) {
    const cycleSteps = monitor.cycle.filter((name) => stepNames.has(name));
    if (cycleSteps.length === 0) {
      continue;
    }
    for (const reference of extractReportReferences(monitor.judge.instruction)) {
      const location = `loop monitor judge for cycle [${monitor.cycle.join(' -> ')}]`;
      if (isReservedReportFileName(reference)) {
        report.diagnostics.push({
          level: 'error',
          message: `${location} references {report:${reference}}, which is a reserved internal file `
            + '(resume-artifacts.json holds the resume snapshot manifest) and cannot be used as a report.',
        });
        continue;
      }
      if (!allProducedReports.has(reference) && !allProducedReports.has(WILDCARD_REPORT)) {
        warnReference(reference, location, 'no step\'s output_contracts produce that report.');
        continue;
      }
      // The judge fires only after every cycle step has run, so a report
      // produced by a cycle step itself is guaranteed as well.
      const producible = cycleSteps.some((cycleStep) => (
        isGuaranteedAt(reference, cycleStep)
        || (producedByStep.get(cycleStep) ?? new Set()).has(reference)
      ));
      if (!producible) {
        warnReference(
          reference,
          location,
          'the workflow can reach that cycle before any step producing the report has run.',
        );
      }
    }
  }
}

export async function doctorWorkflowCommand(
  targets: string[],
  projectDir: string,
): Promise<void> {
  const resolvedTargets = resolveWorkflowDoctorTargets(targets, projectDir);
  if (resolvedTargets.length === 0) {
    throw new Error('No workflow files found to validate');
  }

  let hasErrors = false;
  for (const target of resolvedTargets) {
    const { filePath, lookupCwd, source } = target;
    const report = inspectWorkflowFile(filePath, projectDir, { lookupCwd, source });
    validateWorkflowRuntimeContract(report, target, projectDir);
    if (report.diagnostics.length === 0) {
      success(`Workflow OK: ${sanitizeTerminalText(filePath)}`);
      continue;
    }

    for (const diagnostic of report.diagnostics) {
      const message = sanitizeTerminalText(diagnostic.message);
      if (diagnostic.level === 'error') {
        hasErrors = true;
        error(`${sanitizeTerminalText(filePath)}: ${message}`);
      } else {
        warn(`${sanitizeTerminalText(filePath)}: ${message}`);
      }
    }
  }

  if (hasErrors) {
    throw new Error('Workflow validation failed');
  }
}
