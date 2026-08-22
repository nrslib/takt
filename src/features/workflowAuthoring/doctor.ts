import { error, success, warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { COMPLETE_STEP, ABORT_STEP } from '../../core/workflow/constants.js';
// 実行時（escape.ts の {report:X} リゾルバ）と同じ parser を共用し、
// 静的解析と実行時の構文解釈を揃える。
import { extractReportReferences } from '../../core/workflow/instruction/report-reference.js';
import {
  classifyReportRelativePath,
  reportPathRejectionMessage,
} from '../../core/models/reserved-report-names.js';
import { validateWorkflowConfig } from '../../core/workflow/engine/WorkflowValidator.js';
import {
  resolveWorkflowSelector,
  type SelectorProviderOverrides,
} from '../../infra/config/index.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../../infra/config/runtime-provider/provider-environment.js';
import { inspectWorkflowFile, resolveWorkflowDoctorTargets } from '../../infra/config/loaders/workflowDoctor.js';
import { isMissingWorkflowCallArgError } from '../../infra/config/loaders/workflowCallableArgResolver.js';
import { loadWorkflowFileWithResolutionOptions } from '../../infra/config/loaders/workflowResolvedLoader.js';
import type { CompanionReviewMode } from '../../core/models/companion-types.js';
import type { WorkflowConfig, WorkflowStep } from '../../core/models/types.js';
import { getAllParallelSubSteps } from '../../core/models/types.js';
import type { WorkflowDoctorReport, WorkflowDoctorTarget } from '../../infra/config/loaders/workflowDoctor.js';
import { translateWorkflowConfigError } from '../../shared/workflowConfigMetadata.js';
import { validateWorkflowCallContracts } from '../../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowCompanions } from '../../infra/config/workflowCompanionResolution.js';

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
  selectorOverrides: SelectorProviderOverrides | undefined,
): CompanionReviewMode | undefined {
  if (reportHasErrors(report)) {
    return undefined;
  }

  let workflow: ReturnType<typeof loadWorkflowForRuntimeValidation> | undefined;
  try {
    workflow = loadWorkflowForRuntimeValidation(target, projectDir);
    const runtimeEnvironment = resolveAuxiliaryRuntimeEnvironment(projectDir, workflow);
    const env = runtimeEnvironment.providerEnvironment;
    resolveWorkflowSelector(workflow, {
      projectCwd: projectDir,
      lookupCwd: target.lookupCwd ?? projectDir,
      overrides: selectorOverrides,
      companionEnabled: runtimeEnvironment.companionEnabled,
      providerEnvironment: env,
      providerConfigMode: runtimeEnvironment.providerConfigMode,
    });
    // Validate provider/model/personaProviders/providerRouting/autoRouting through the same
    // compiled bundle as execution and preview, so a runtime-v1 environment validates the
    // runtime.yaml `profiles.default` resolution (and a mixed configuration fails fast here too).
    if (runtimeEnvironment.companionEnabled) {
      resolveWorkflowCompanions(workflow, env, {
        projectCwd: projectDir,
        lookupCwd: target.lookupCwd ?? projectDir,
      });
    }
    validateWorkflowCallContracts(workflow, projectDir, target.lookupCwd ?? projectDir);
    validateWorkflowConfig(workflow, {
      projectCwd: projectDir,
      provider: env.provider,
      model: env.model,
      personaProviders: env.personaProviders,
      providerRouting: env.providerRouting,
      autoRouting: env.autoRouting,
      providerRoutingTagConflictPolicy: env.tagConflictPolicy,
      ...(env.internalAgents === undefined ? {} : { internalAgentSeats: env.internalAgents }),
      workflowCallResolver: () => null,
    });
    warnOnUnproducibleReportReferences(report, workflow);
    return runtimeEnvironment.companionReviewMode;
  } catch (validationError) {
    const translatedError = workflow === undefined
      ? validationError
      : translateWorkflowConfigError(workflow, validationError);
    report.diagnostics.push({
      level: 'error',
      message: getErrorMessage(translatedError),
    });
    return undefined;
  }
}

function collectContractReportNames(step: WorkflowStep, into: Set<string>): void {
  for (const contract of step.outputContracts ?? []) {
    into.add(contract.name);
  }
  for (const subStep of step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)) {
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
        + 'At runtime, a missing {report:} reference is replaced with an explicit missing-report sentence. '
        + 'Point the reference at a report produced by an earlier step, or move/rename the output contract.',
    });
  };

  for (const step of workflow.steps) {
    const references = new Set(extractReportReferences(step.instruction));
    for (const subStep of step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)) {
      for (const reference of extractReportReferences(subStep.instruction)) {
        references.add(reference);
      }
    }
    for (const reference of references) {
      const classification = classifyReportRelativePath(reference);
      if (classification.kind !== 'public') {
        report.diagnostics.push({
          level: 'error',
          message: `step "${step.name}" references an invalid report: ${reportPathRejectionMessage(reference)}.`,
        });
        continue;
      }
      const reportName = classification.normalizedPath;
      if (!allProducedReports.has(reportName) && !allProducedReports.has(WILDCARD_REPORT)) {
        warnReference(reportName, `step "${step.name}"`, 'no step\'s output_contracts produce that report.');
        continue;
      }
      if (!isGuaranteedAt(reportName, step.name)) {
        warnReference(
          reportName,
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
      const classification = classifyReportRelativePath(reference);
      if (classification.kind !== 'public') {
        report.diagnostics.push({
          level: 'error',
          message: `${location} references an invalid report: ${reportPathRejectionMessage(reference)}.`,
        });
        continue;
      }
      const reportName = classification.normalizedPath;
      if (!allProducedReports.has(reportName) && !allProducedReports.has(WILDCARD_REPORT)) {
        warnReference(reportName, location, 'no step\'s output_contracts produce that report.');
        continue;
      }
      // The judge fires only after every cycle step has run, so a report
      // produced by a cycle step itself is guaranteed as well.
      const producible = cycleSteps.some((cycleStep) => (
        isGuaranteedAt(reportName, cycleStep)
        || (producedByStep.get(cycleStep) ?? new Set()).has(reportName)
      ));
      if (!producible) {
        warnReference(
          reportName,
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
  selectorOverrides?: SelectorProviderOverrides,
): Promise<void> {
  const resolvedTargets = resolveWorkflowDoctorTargets(targets, projectDir);
  if (resolvedTargets.length === 0) {
    throw new Error('No workflow files found to validate');
  }

  let hasErrors = false;
  for (const target of resolvedTargets) {
    const { filePath, lookupCwd, source } = target;
    const report = inspectWorkflowFile(filePath, projectDir, { lookupCwd, source });
    const companionReviewMode = validateWorkflowRuntimeContract(report, target, projectDir, selectorOverrides);
    if (companionReviewMode !== undefined && report.diagnostics.length === 0) {
      success(
        `Workflow OK: ${sanitizeTerminalText(filePath)} `
        + `(Companion review mode: ${companionReviewMode})`,
      );
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
