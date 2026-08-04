import type { AgentResponse, AgentWorkflowStep, FindingContractConfig } from '../../models/types.js';
import type { FindingLedger, FindingManagerTaskAudit } from './types.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import type { PreAdmissionEntityBinding } from './pre-admission-entity-binding-types.js';
import {
  ENTITY_BINDING_TASK_MAX_ITEMS,
  MAIN_MANAGER_INPUT_MAX_BYTES,
  parseFindingEntityBindingTaskOutput,
} from './manager-task-contracts.js';
import { buildFindingEntityBindingTaskStep } from './manager-step.js';
import {
  runPreparedManagerAttempt,
} from './manager-agent.js';
import { renderFencedJsonBlock } from '../instruction/fenced-block.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  collectEntityBindingCandidates,
  collectEntityBindingComponents,
  entityBindingDigest,
  entityCreationRequestKey,
  uniqueExactSemanticFinding,
  type BindingCandidate,
  type EntityBindingComponent,
} from './pre-admission-entity-binding-identity.js';
import {
  planFallbackEntityBindings,
  planManagerEntityBindings,
  validateEntityBindingDecisions,
} from './pre-admission-entity-binding-plan.js';
import { buildCanonicalEntityHeadProjection } from './pre-admission-entity-binding-projection.js';
import {
  createReviewerAnomalySpec,
  type ReviewerAnomalySpec,
} from './reviewer-anomalies.js';
import { composeFindingManagerInstruction } from './manager-instruction-composer.js';

export interface PreAdmissionEntityBindingResult {
  intake: ReviewerIntakeResult;
  taskAudits: FindingManagerTaskAudit[];
}

interface PreparedBindingTask {
  taskId: string;
  components: EntityBindingComponent[];
  candidates: BindingCandidate[];
  allowedFindingIds: ReadonlySet<string>;
  phase1Instruction: string;
  inputBytes: number;
}

interface PreparedBindingTaskOverflow {
  task: PreparedBindingTask;
  reason: string;
}

function taskIdForCandidates(
  candidates: readonly BindingCandidate[],
  entityHeadProjectionDigest: string,
): string {
  return entityBindingDigest(
    'finding-semantic-entity-binding-task-v3',
    {
      candidates: candidates.map(({ item }) => ({
        rawFindingId: item.wire.rawFindingId,
        semanticClaimIdentityHash: item.wire.semanticClaimIdentityHash,
        targetIdentityHash: item.wire.targetIdentityHash,
      })),
      entityHeadProjectionDigest,
    },
  );
}

function ledgerProjectionForComponents(
  components: readonly EntityBindingComponent[],
): {
  projection: unknown;
  projectionDigest: string;
  allowedFindingIds: ReadonlySet<string>;
} {
  const findingById = new Map(components.flatMap((component) => (
    component.findings.map((finding) => [finding.id, finding] as const)
  )));
  const findings = [...findingById.values()]
    .sort((left, right) => compareBinaryStrings(left.id, right.id));
  const projection = buildCanonicalEntityHeadProjection(findings);
  return {
    projection,
    projectionDigest: entityBindingDigest(
      'finding-canonical-entity-head-projection-v1',
      projection,
    ),
    allowedFindingIds: new Set(findings.map((finding) => finding.id)),
  };
}

function taskInstruction(input: {
  contract: FindingContractConfig;
  taskId: string;
  candidates: readonly BindingCandidate[];
  ledgerProjection: unknown;
}): string {
  return [
    input.contract.manager.instruction,
    '',
    'For this task, the entity-binding contract below replaces the normal raw-adjudication decision vocabulary.',
    'Classify semantic entity association only. Do not investigate code and do not decide evidence validity or lifecycle transitions.',
    'For each owned raw finding choose exactly one decision:',
    '- bind_existing: the observation describes the same semantic defect or uncertainty episode as one supplied ledger finding.',
    '- new_entity: the observation describes a distinct semantic defect. Use one owned rawFindingId as groupRawFindingId for every same-entity observation in this task.',
    '- ambiguous: the relationship cannot be determined. Group observations from the same uncertainty episode with one owned groupRawFindingId.',
    'Every new_entity or ambiguous group must stay within one connected target-locus component.',
    'For bind_existing set findingId and groupRawFindingId="". For new_entity or ambiguous set findingId="" and select an owned groupRawFindingId.',
    'A bind_existing decision only authorizes an audit observation. It cannot change status, lifecycle, evidence, title, target, or any product field.',
    '',
    '## Task manifest',
    renderFencedJsonBlock({
      taskId: input.taskId,
      ownedRawFindingIds: input.candidates.map(({ item }) => item.wire.rawFindingId),
    }),
    '',
    '## Complete ledger entities for the supplied connected components',
    renderFencedJsonBlock(input.ledgerProjection),
    '',
    '## Raw observations',
    renderFencedJsonBlock(input.candidates.map(({ item }) => ({
      rawFindingId: item.wire.rawFindingId,
      reviewer: item.wire.reviewer,
      target: item.wire.target,
      familyTag: item.wire.familyTag,
      severity: item.wire.severity,
      title: item.wire.title,
      description: item.wire.description,
      suggestion: item.wire.suggestion,
      observationExcerpt: item.canonical.coherence === 'ambiguous'
        ? item.canonical.safeEvidenceExcerpt
        : [item.canonical.title, item.canonical.description]
          .filter((value): value is string => value !== undefined)
          .join('\n'),
    }))),
  ].join('\n');
}

function prepareBindingTask(input: {
  contract: FindingContractConfig;
  components: readonly EntityBindingComponent[];
  managerStep: AgentWorkflowStep;
  runInput: Pick<RunFindingManagerForStepInput, 'stepExecutor'>;
}): PreparedBindingTask {
  const candidates = input.components
    .flatMap((component) => component.candidates)
    .sort((left, right) => compareBinaryStrings(
      left.item.wire.rawFindingId,
      right.item.wire.rawFindingId,
    ));
  const ledgerContext = ledgerProjectionForComponents(
    input.components,
  );
  const taskId = taskIdForCandidates(candidates, ledgerContext.projectionDigest);
  const baseInstruction = taskInstruction({
    contract: input.contract,
    taskId,
    candidates,
    ledgerProjection: ledgerContext.projection,
  });
  const bindingStep = buildFindingEntityBindingTaskStep(input.managerStep);
  const phase1Instruction = input.runInput.stepExecutor.buildPhase1Instruction(
    composeFindingManagerInstruction({
      baseInstruction,
      policyContents: bindingStep.policyContents,
      knowledgeContents: bindingStep.knowledgeContents,
    }),
    bindingStep,
  );
  return {
    taskId,
    components: [...input.components],
    candidates,
    allowedFindingIds: ledgerContext.allowedFindingIds,
    phase1Instruction,
    inputBytes: Buffer.byteLength(phase1Instruction, 'utf8'),
  };
}

function structuredOutput(response: AgentResponse, taskId: string): unknown {
  if (response.status !== 'done') {
    throw new Error(
      `Entity binding task "${taskId}" failed with status "${response.status}": ${response.error ?? response.content}`,
    );
  }
  if (
    typeof response.structuredOutput !== 'object'
    || response.structuredOutput === null
    || Array.isArray(response.structuredOutput)
  ) {
    throw new Error(`Entity binding task "${taskId}" output must be an object`);
  }
  return response.structuredOutput;
}

function fallbackExecution(input: {
  task: PreparedBindingTask;
  roundMarker: string;
  reason: string;
}): {
  bindings: Map<string, PreAdmissionEntityBinding>;
  audit: FindingManagerTaskAudit;
} {
  return {
    bindings: planFallbackEntityBindings({
      taskId: input.task.taskId,
      roundMarker: input.roundMarker,
      components: input.task.components,
      reason: input.reason,
    }),
    audit: {
      taskId: input.task.taskId,
      taskKind: 'entity_binding',
      ownedIds: input.task.candidates.map(({ item }) => item.wire.rawFindingId),
      status: 'failed',
      inputBytes: input.task.inputBytes,
      reason: input.reason,
    },
  };
}

async function executeBindingTask(input: {
  previousLedger: FindingLedger;
  task: PreparedBindingTask;
  roundMarker: string;
  managerStep: AgentWorkflowStep;
  runInput: Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;
}): Promise<{
  bindings: Map<string, PreAdmissionEntityBinding>;
  audit: FindingManagerTaskAudit;
}> {
  const bindingStep = buildFindingEntityBindingTaskStep(input.managerStep);
  try {
    const response = await runPreparedManagerAttempt({
      managerStep: bindingStep,
      phase1Instruction: input.task.phase1Instruction,
      optionsBuilder: input.runInput.optionsBuilder,
      stepExecutor: input.runInput.stepExecutor,
    });
    const output = parseFindingEntityBindingTaskOutput(
      structuredOutput(response, input.task.taskId),
    );
    const decisions = validateEntityBindingDecisions({
      taskId: input.task.taskId,
      output,
      candidates: input.task.candidates,
      ledger: input.previousLedger,
      components: input.task.components,
      allowedFindingIds: input.task.allowedFindingIds,
    });
    return {
      bindings: planManagerEntityBindings({
        taskId: input.task.taskId,
        roundMarker: input.roundMarker,
        decisions,
        candidates: input.task.candidates,
        components: input.task.components,
        ledger: input.previousLedger,
      }),
      audit: {
        taskId: input.task.taskId,
        taskKind: 'entity_binding',
        ownedIds: input.task.candidates.map(({ item }) => item.wire.rawFindingId),
        status: 'succeeded',
        inputBytes: input.task.inputBytes,
        output,
      },
    };
  } catch (error) {
    return fallbackExecution({
      task: input.task,
      roundMarker: input.roundMarker,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function bindingTaskOverflowReason(
  component: EntityBindingComponent,
  task: PreparedBindingTask,
): string | undefined {
  return component.candidates.length > ENTITY_BINDING_TASK_MAX_ITEMS
    || task.inputBytes > MAIN_MANAGER_INPUT_MAX_BYTES
    ? `Entity binding component "${component.componentKey}" exceeds the protocol budget `
      + `(${component.candidates.length}/${ENTITY_BINDING_TASK_MAX_ITEMS} raw findings, `
      + `${task.inputBytes}/${MAIN_MANAGER_INPUT_MAX_BYTES} UTF-8 bytes)`
    : undefined;
}

function prepareBindingTasks(input: {
  contract: FindingContractConfig;
  components: readonly EntityBindingComponent[];
  managerStep: AgentWorkflowStep;
  runInput: Pick<RunFindingManagerForStepInput, 'stepExecutor'>;
}): {
  tasks: PreparedBindingTask[];
  overflows: PreparedBindingTaskOverflow[];
} {
  const tasks: PreparedBindingTask[] = [];
  const overflows: PreparedBindingTaskOverflow[] = [];
  let current: PreparedBindingTask | undefined;
  for (const component of input.components) {
    const single = prepareBindingTask({ ...input, components: [component] });
    const overflowReason = bindingTaskOverflowReason(component, single);
    if (overflowReason !== undefined) {
      if (current !== undefined) {
        tasks.push(current);
        current = undefined;
      }
      overflows.push({ task: single, reason: overflowReason });
      continue;
    }
    if (current === undefined) {
      current = single;
      continue;
    }
    const combinedComponents = [...current.components, component];
    const combinedRawCount = current.candidates.length + component.candidates.length;
    const combined = combinedRawCount <= ENTITY_BINDING_TASK_MAX_ITEMS
      ? prepareBindingTask({ ...input, components: combinedComponents })
      : undefined;
    if (combined !== undefined && combined.inputBytes <= MAIN_MANAGER_INPUT_MAX_BYTES) {
      current = combined;
      continue;
    }
    tasks.push(current);
    current = single;
  }
  if (current !== undefined) {
    tasks.push(current);
  }
  return { tasks, overflows };
}

function exactBindings(input: {
  ledger: FindingLedger;
  candidates: readonly BindingCandidate[];
  roundMarker: string;
}): {
  bindings: Map<string, PreAdmissionEntityBinding>;
  unresolved: BindingCandidate[];
} {
  const components = collectEntityBindingComponents(input.ledger, input.candidates);
  const componentByRawId = new Map(components.flatMap((component) => (
    component.candidates.map((candidate) => [
      candidate.item.wire.rawFindingId,
      component,
    ] as const)
  )));
  const projectionDigest = ledgerProjectionForComponents(components).projectionDigest;
  const exactTaskId = taskIdForCandidates(input.candidates, projectionDigest);
  const bindings = new Map<string, PreAdmissionEntityBinding>();
  const unresolved: BindingCandidate[] = [];
  input.candidates.forEach((candidate, groupOrdinal) => {
    const finding = uniqueExactSemanticFinding([candidate], input.ledger);
    const component = componentByRawId.get(candidate.item.wire.rawFindingId);
    if (
      finding?.targetIdentityHash === null
      || finding?.targetIdentityHash === undefined
      || component === undefined
    ) {
      unresolved.push(candidate);
      return;
    }
    bindings.set(candidate.item.wire.rawFindingId, {
      kind: 'bind_existing',
      targetFindingId: finding.id,
      expectedTargetIdentityHash: finding.targetIdentityHash,
      fallbackCreationRequestKey: entityCreationRequestKey({
        roundMarker: input.roundMarker,
        taskId: exactTaskId,
        groupOrdinal,
      }),
      capturedLocusHeadDigest: component.locusHeadDigest,
      reason: 'Exact semantic claim identity matched one ledger entity',
    });
  });
  return { bindings, unresolved };
}

export async function bindPreAdmissionEntities(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  managerStep: AgentWorkflowStep;
  roundMarker: string;
  runInput: Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;
}): Promise<PreAdmissionEntityBindingResult> {
  const eligible = collectEntityBindingCandidates(input.intake)
    .sort((left, right) => compareBinaryStrings(
      left.item.wire.rawFindingId,
      right.item.wire.rawFindingId,
    ));
  const exact = exactBindings({
    ledger: input.previousLedger,
    candidates: eligible,
    roundMarker: input.roundMarker,
  });
  const bindings = new Map([...input.intake.entityBindings, ...exact.bindings]);
  const components = collectEntityBindingComponents(input.previousLedger, exact.unresolved);
  const prepared = prepareBindingTasks({
    contract: input.contract,
    components,
    managerStep: input.managerStep,
    runInput: input.runInput,
  });
  const taskAudits: FindingManagerTaskAudit[] = [];
  const overflowRawFindingIds = new Set(input.intake.overflowRawFindingIds);
  const intakeAnomalySpecs: ReviewerAnomalySpec[] = [...input.intake.intakeAnomalySpecs];
  for (const overflow of prepared.overflows) {
    for (const candidate of overflow.task.candidates) {
      overflowRawFindingIds.add(candidate.item.wire.rawFindingId);
      intakeAnomalySpecs.push(createReviewerAnomalySpec({
        wire: candidate.item.wire,
        canonical: candidate.item.canonical,
        anomalyKind: 'protocol-anomaly',
        reason: `${overflow.reason}; the saved raw observation was quarantined without product or provisional mutation`,
      }));
    }
    taskAudits.push({
      taskId: overflow.task.taskId,
      taskKind: 'entity_binding',
      ownedIds: overflow.task.candidates.map(({ item }) => item.wire.rawFindingId),
      status: 'input_overflow',
      inputBytes: overflow.task.inputBytes,
      reason: overflow.reason,
    });
  }
  for (const task of prepared.tasks) {
    const execution = await executeBindingTask({
      previousLedger: input.previousLedger,
      task,
      roundMarker: input.roundMarker,
      managerStep: input.managerStep,
      runInput: input.runInput,
    });
    for (const [rawFindingId, binding] of execution.bindings) {
      bindings.set(rawFindingId, binding);
    }
    taskAudits.push(execution.audit);
  }
  return {
    intake: {
      ...input.intake,
      entityBindings: bindings,
      overflowRawFindingIds,
      intakeAnomalySpecs,
    },
    taskAudits,
  };
}
