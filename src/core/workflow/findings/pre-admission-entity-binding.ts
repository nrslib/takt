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
  buildManagerInputLedger,
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

function taskIdForCandidates(candidates: readonly BindingCandidate[]): string {
  return entityBindingDigest(
    'finding-semantic-entity-binding-task-v2',
    candidates.map(({ item }) => ({
      rawFindingId: item.wire.rawFindingId,
      semanticClaimIdentityHash: item.wire.semanticClaimIdentityHash,
      targetIdentityHash: item.wire.targetIdentityHash,
    })),
  );
}

function ledgerProjectionForComponents(
  ledger: FindingLedger,
  components: readonly EntityBindingComponent[],
): {
  projection: unknown;
  allowedFindingIds: ReadonlySet<string>;
} {
  const findingById = new Map(components.flatMap((component) => (
    component.findings.map((finding) => [finding.id, finding] as const)
  )));
  const findings = [...findingById.values()]
    .sort((left, right) => compareBinaryStrings(left.id, right.id));
  return {
    projection: buildManagerInputLedger({
      ...ledger,
      findings,
      conflicts: [],
    }, new Set()),
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
  previousLedger: FindingLedger;
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
  const taskId = taskIdForCandidates(candidates);
  const ledgerContext = ledgerProjectionForComponents(
    input.previousLedger,
    input.components,
  );
  const instruction = taskInstruction({
    contract: input.contract,
    taskId,
    candidates,
    ledgerProjection: ledgerContext.projection,
  });
  const bindingStep = buildFindingEntityBindingTaskStep(input.managerStep);
  const phase1Instruction = input.runInput.stepExecutor.buildPhase1Instruction(
    instruction,
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
  status: 'failed' | 'input_overflow';
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
      status: input.status,
      inputBytes: input.status === 'input_overflow' ? null : input.task.inputBytes,
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
      status: 'failed',
    });
  }
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
  const exactTaskId = taskIdForCandidates(input.candidates);
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
  const selected: EntityBindingComponent[] = [];
  const overflow: EntityBindingComponent[] = [];
  for (const component of components) {
    const tentative = [...selected, component];
    const rawCount = tentative.reduce(
      (count, item) => count + item.candidates.length,
      0,
    );
    if (rawCount > ENTITY_BINDING_TASK_MAX_ITEMS) {
      overflow.push(component);
      continue;
    }
    const prepared = prepareBindingTask({
      contract: input.contract,
      previousLedger: input.previousLedger,
      components: tentative,
      managerStep: input.managerStep,
      runInput: input.runInput,
    });
    if (prepared.inputBytes > MAIN_MANAGER_INPUT_MAX_BYTES) {
      overflow.push(component);
    } else {
      selected.push(component);
    }
  }

  const taskAudits: FindingManagerTaskAudit[] = [];
  for (const component of overflow) {
    const task = prepareBindingTask({
      contract: input.contract,
      previousLedger: input.previousLedger,
      components: [component],
      managerStep: input.managerStep,
      runInput: input.runInput,
    });
    const fallback = fallbackExecution({
      task,
      roundMarker: input.roundMarker,
      reason: `Complete target component exceeds the ${ENTITY_BINDING_TASK_MAX_ITEMS}-raw or ${MAIN_MANAGER_INPUT_MAX_BYTES}-byte entity-binding budget`,
      status: 'input_overflow',
    });
    for (const [rawFindingId, binding] of fallback.bindings) {
      bindings.set(rawFindingId, binding);
    }
    taskAudits.push(fallback.audit);
  }
  if (selected.length > 0) {
    const task = prepareBindingTask({
      contract: input.contract,
      previousLedger: input.previousLedger,
      components: selected,
      managerStep: input.managerStep,
      runInput: input.runInput,
    });
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
    },
    taskAudits,
  };
}
