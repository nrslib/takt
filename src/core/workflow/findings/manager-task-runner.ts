import { createHash } from 'node:crypto';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig } from '../../models/types.js';
import { normalizeFindingText } from '../../models/finding-claim-identity.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  renderFencedJsonBlock,
} from '../instruction/fenced-block.js';
import type {
  CapturedManagerConflictHead,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import {
  buildManagerInputLedger,
  managerRawFindingView,
  runPreparedManagerAttempt,
} from './manager-agent.js';
import { buildFindingManagerControlTaskStep } from './manager-step.js';
import {
  MAIN_MANAGER_INPUT_MAX_BYTES,
  MAIN_MANAGER_RAW_TASK_MAX_ITEMS,
  parseMainManagerControlTaskOutput,
  parseMainManagerRawTaskOutput,
  type MainManagerControlIntent,
  type MainManagerTaskScopeContext,
  type MainManagerControlTask,
  type MainManagerControlTaskOutput,
  type MainManagerRawTask,
  type MainManagerRawTaskDecision,
} from './manager-task-contracts.js';
import {
  collectTaskScopeReportExcerpts,
  computeWorkflowTaskDigest,
  isByteExactWorkflowTaskQuote,
} from './task-scope-adjudication.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import {
  findingFileQuoteLocations,
  rawFindingFileQuoteLocations,
} from './evidence-location.js';
import { hasDisputeClaimFor } from './manager-output-validation.js';
import {
  adaptProviderRawDecisions,
  PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION,
} from './manager-raw-decision-adapter.js';
import { computeConflictEvidenceHash } from './adjudication-evidence.js';
import type {
  FindingEvidenceRecord,
  FindingLedger,
  FindingManagerDecisions,
  FindingProvisionalKind,
  FindingManagerTaskAudit,
  RawFinding,
} from './types.js';

const CONTEXT_CANDIDATE_LIMITS = [16, 8, 4, 0] as const;
const COMPACT_CONFLICT_COLLECTION_LIMIT = 16;
const CONTROL_PRIOR_TEXT_LIMIT = 4_000;

export interface MainManagerRawFailure {
  kind: FindingProvisionalKind;
  reason: string;
}

export interface MainManagerTaskExecution {
  decisions: FindingManagerDecisions;
  conflictTargetHeads: Map<string, CapturedManagerConflictHead>;
  rawFailures: Map<string, MainManagerRawFailure>;
  invalidAttemptMessages: string[];
  taskAudits: FindingManagerTaskAudit[];
}

interface RawTaskQueueItem {
  task: MainManagerRawTask;
  rawFindings: RawFinding[];
}

type AdaptedMainManagerRawTaskDecision =
  MainManagerRawTaskDecision & FindingManagerDecisions['rawDecisions'][number];

interface RawTaskContext {
  ledger: FindingLedger;
  coverage: {
    candidateFindingCount: number;
    candidateFindingIdsDigest: string;
    selectedFindingIds: string[];
    selectedConflictCount: number;
    selectedConflictIdsDigest: string;
    locusCandidateCount: number;
    locusCandidateIdsDigest: string;
  };
}

interface ControlTaskQueueItem {
  task: MainManagerControlTask;
}

function taskLedgerProjection(ledger: FindingLedger): unknown {
  const projection = buildManagerInputLedger(ledger, new Set()) as {
    workflowName: string;
    findings: unknown[];
    conflicts: unknown[];
  };
  return {
    workflowName: projection.workflowName,
    findings: projection.findings,
    conflicts: projection.conflicts,
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareBinaryStrings);
}

function taskId(domain: string, value: unknown): string {
  return digest({ domain, value });
}

function emptyDecisions(): FindingManagerDecisions {
  return {
    rawDecisions: [],
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  };
}

function extractSymbols(text: string | null | undefined): Set<string> {
  const symbols = new Set<string>();
  if (text == null) {
    return symbols;
  }
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const symbol = match[1]?.trim();
    if (symbol !== undefined && symbol.length > 0) {
      symbols.add(symbol);
    }
  }
  for (const match of text.matchAll(
    /\b(?:[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*)\b/g,
  )) {
    symbols.add(match[0]);
  }
  return symbols;
}

function componentsForRawFindings(rawFindings: readonly RawFinding[]): Array<{
  componentId: string;
  raws: RawFinding[];
}> {
  const sorted = [...rawFindings].sort((left, right) => (
    compareBinaryStrings(left.rawFindingId, right.rawFindingId)
  ));
  const parent = sorted.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };
  const ownerByBinding = new Map<string, number>();
  sorted.forEach((raw, index) => {
    const bindings = [raw.targetFindingId === null
      ? `relation-semantic:${raw.relation}:${raw.semanticClaimIdentityHash}`
      : `target-relation-semantic:${raw.targetFindingId}:${raw.relation}:${raw.semanticClaimIdentityHash}`];
    for (const binding of bindings) {
      const owner = ownerByBinding.get(binding);
      if (owner === undefined) {
        ownerByBinding.set(binding, index);
      } else {
        union(owner, index);
      }
    }
  });
  const rawsByRoot = new Map<number, RawFinding[]>();
  sorted.forEach((raw, index) => {
    const root = find(index);
    rawsByRoot.set(root, [...(rawsByRoot.get(root) ?? []), raw]);
  });
  return [...rawsByRoot.values()]
    .map((raws) => {
      const rawFindingIds = raws.map((raw) => raw.rawFindingId).sort(compareBinaryStrings);
      const bindings = sortedUnique(raws.map((raw) => (
        raw.targetFindingId === null
          ? `relation-semantic:${raw.relation}:${raw.semanticClaimIdentityHash}`
          : `target-relation-semantic:${raw.targetFindingId}:${raw.relation}:${raw.semanticClaimIdentityHash}`
      )));
      return {
        componentId: taskId('finding-manager-raw-component-v1', {
          rawFindingIds,
          bindings,
        }),
        raws,
      };
    })
    .sort((left, right) => (
      compareBinaryStrings(left.raws[0]!.rawFindingId, right.raws[0]!.rawFindingId)
    ));
}

function createRawTask(
  previousLedger: FindingLedger,
  raws: RawFinding[],
  componentIdByRawFindingId: ReadonlyMap<string, string>,
  splitPath: number[],
): RawTaskQueueItem {
  const sorted = [...raws].sort((left, right) => (
    compareBinaryStrings(left.rawFindingId, right.rawFindingId)
  ));
  const capturedTargetHeads = new Map(sorted.map((raw) => [
    raw.rawFindingId,
    raw.targetFindingId === null
      ? null
      : captureFindingLifecycleHead(previousLedger, 'finding', raw.targetFindingId) ?? null,
  ]));
  const rawInputs = sorted.map((raw) => ({
    rawFindingId: raw.rawFindingId,
    componentId: componentIdByRawFindingId.get(raw.rawFindingId)!,
    targetFindingId: raw.targetFindingId,
    targetPrecondition: raw.targetPrecondition ?? null,
  }));
  const id = taskId('finding-manager-raw-task-v1', {
    splitPath,
    rawFindings: rawInputs,
    capturedTargetHeads: [...capturedTargetHeads.entries()],
  });
  return {
    rawFindings: sorted,
    task: {
      taskId: id,
      ownedRawFindingIds: sorted.map((raw) => raw.rawFindingId),
      componentIdByRawFindingId: new Map(
        sorted.map((raw) => [
          raw.rawFindingId,
          componentIdByRawFindingId.get(raw.rawFindingId)!,
        ]),
      ),
      capturedTargetHeads,
      rawFindings: rawInputs,
    },
  };
}

export function createMainManagerRawTaskManifest(input: {
  previousLedger: FindingLedger;
  residualRawFindings: readonly RawFinding[];
}): RawTaskQueueItem[] {
  const units = componentsForRawFindings(input.residualRawFindings).flatMap((component) => {
    const chunks: Array<{
      raws: RawFinding[];
      componentIdByRawFindingId: Map<string, string>;
    }> = [];
    for (
      let offset = 0;
      offset < component.raws.length;
      offset += MAIN_MANAGER_RAW_TASK_MAX_ITEMS
    ) {
      const raws = component.raws.slice(
        offset,
        offset + MAIN_MANAGER_RAW_TASK_MAX_ITEMS,
      );
      chunks.push({
        raws,
        componentIdByRawFindingId: new Map(
          raws.map((raw) => [raw.rawFindingId, component.componentId]),
        ),
      });
    }
    return chunks;
  });
  const packed: typeof units = [];
  for (const unit of units) {
    const current = packed.at(-1);
    const currentComponentIds = new Set(
      current?.componentIdByRawFindingId.values() ?? [],
    );
    const unitComponentIds = new Set(unit.componentIdByRawFindingId.values());
    if (
      current !== undefined
      && current.raws.length + unit.raws.length <= MAIN_MANAGER_RAW_TASK_MAX_ITEMS
      && [...unitComponentIds].every((componentId) => (
        !currentComponentIds.has(componentId)
      ))
    ) {
      current.raws.push(...unit.raws);
      for (const [rawFindingId, componentId] of unit.componentIdByRawFindingId) {
        current.componentIdByRawFindingId.set(rawFindingId, componentId);
      }
    } else {
      packed.push({
        raws: [...unit.raws],
        componentIdByRawFindingId: new Map(unit.componentIdByRawFindingId),
      });
    }
  }
  return packed.map((unit, index) => createRawTask(
    input.previousLedger,
    unit.raws,
    unit.componentIdByRawFindingId,
    [index],
  ));
}

function findingCandidateIdsForRawTask(
  previousLedger: FindingLedger,
  raws: readonly RawFinding[],
): {
  requiredIds: string[];
  candidateIds: string[];
  locusCandidateIds: string[];
} {
  const requiredIds = sortedUnique(
    raws.flatMap((raw) => raw.targetFindingId === null ? [] : [raw.targetFindingId]),
  );
  const rawPaths = new Set(raws.flatMap((raw) => (
    rawFindingFileQuoteLocations(raw).map((location) => location.path)
  )));
  const rawTitles = new Set(raws.flatMap((raw) => (
    raw.title === null ? [] : [normalizeFindingText(raw.title).toLowerCase()]
  )));
  const rawSymbols = new Set(raws.flatMap((raw) => [
    ...extractSymbols(raw.title),
    ...extractSymbols(raw.description),
  ]));
  const rawSemanticHashes = new Set(raws.map((raw) => raw.semanticClaimIdentityHash));
  const candidateIds = new Set(requiredIds);
  const locusCandidateIds = new Set<string>();
  for (const finding of previousLedger.findings) {
    if (finding.status !== 'open') {
      continue;
    }
    const semanticMatch = finding.semanticClaimIdentityHash !== null
      && rawSemanticHashes.has(finding.semanticClaimIdentityHash);
    const pathMatch = findingFileQuoteLocations(previousLedger, finding)
      .some((location) => rawPaths.has(location.path));
    const titleMatch = finding.title !== null
      && rawTitles.has(normalizeFindingText(finding.title).toLowerCase());
    const findingSymbols = new Set([
      ...extractSymbols(finding.title),
      ...extractSymbols(finding.description),
    ]);
    const symbolMatch = [...rawSymbols].some((symbol) => findingSymbols.has(symbol));
    if (semanticMatch || pathMatch || titleMatch || symbolMatch) {
      candidateIds.add(finding.id);
    }
    if (pathMatch || titleMatch || symbolMatch) {
      locusCandidateIds.add(finding.id);
    }
  }
  return {
    requiredIds,
    candidateIds: sortedUnique(candidateIds),
    locusCandidateIds: sortedUnique(locusCandidateIds),
  };
}

function compactConflictForPrompt(
  conflict: FindingLedger['conflicts'][number],
  selectedFindingIds: ReadonlySet<string>,
): FindingLedger['conflicts'][number] {
  const orderedFindingIds = sortedUnique([
    ...conflict.findingIds.filter((id) => selectedFindingIds.has(id)),
    ...conflict.findingIds,
  ]).slice(0, COMPACT_CONFLICT_COLLECTION_LIMIT);
  return {
    ...conflict,
    findingIds: orderedFindingIds,
    rawFindingIds: sortedUnique(conflict.rawFindingIds)
      .slice(0, COMPACT_CONFLICT_COLLECTION_LIMIT),
  };
}

function rawTaskContext(
  previousLedger: FindingLedger,
  raws: readonly RawFinding[],
  candidateLimit: number,
): RawTaskContext {
  const candidates = findingCandidateIdsForRawTask(previousLedger, raws);
  const required = new Set(candidates.requiredIds);
  const optional = candidates.candidateIds.filter((id) => !required.has(id));
  const selectedFindingIds = sortedUnique([
    ...required,
    ...optional.slice(0, candidateLimit),
  ]);
  const selectedSet = new Set(selectedFindingIds);
  const matchingConflicts = previousLedger.conflicts
    .filter((conflict) => (
      conflict.status === 'active'
      && conflict.findingIds.some((id) => selectedSet.has(id))
    ))
    .sort((left, right) => compareBinaryStrings(left.id, right.id))
    .slice(0, COMPACT_CONFLICT_COLLECTION_LIMIT);
  const contextLedger: FindingLedger = {
    ...previousLedger,
    findings: previousLedger.findings.filter((finding) => selectedSet.has(finding.id)),
    conflicts: matchingConflicts.map((conflict) => (
      compactConflictForPrompt(conflict, selectedSet)
    )),
  };
  return {
    ledger: contextLedger,
    coverage: {
      candidateFindingCount: candidates.candidateIds.length,
      candidateFindingIdsDigest: digest(candidates.candidateIds),
      selectedFindingIds,
      selectedConflictCount: matchingConflicts.length,
      selectedConflictIdsDigest: digest(matchingConflicts.map((conflict) => conflict.id)),
      locusCandidateCount: candidates.locusCandidateIds.length,
      locusCandidateIdsDigest: digest(candidates.locusCandidateIds),
    },
  };
}

function rawTaskManifestView(task: MainManagerRawTask): unknown {
  return {
    taskId: task.taskId,
    ownedRawFindingIds: task.ownedRawFindingIds,
    rawFindings: task.rawFindings,
    capturedTargetHeads: task.ownedRawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      targetHead: task.capturedTargetHeads.get(rawFindingId) ?? null,
    })),
  };
}

function buildRawTaskInstruction(input: {
  contract: FindingContractConfig;
  task: MainManagerRawTask;
  rawFindings: readonly RawFinding[];
  context: RawTaskContext;
  mechanicallyClassifiedCount: number;
  evidenceRecordsByRawFindingId: ReadonlyMap<string, readonly FindingEvidenceRecord[]>;
}): string {
  return [
    input.contract.manager.instruction,
    '',
    'This is one engine-owned raw adjudication task. Decide only the exact owned raw finding ids in the manifest.',
    'Return the manifest taskId and exactly one decision for every owned raw finding id. Do not add, omit, or duplicate ids.',
    'Copy each engine-issued componentId exactly.',
    PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION,
    'Use findingId="" when the decision has no finding target (for example "new").',
    'Do not emit dispute, conflict-control, invalidate, duplicate, or dismiss actions in this task.',
    ...(input.mechanicallyClassifiedCount === 0
      ? []
      : [`${input.mechanicallyClassifiedCount} other raw findings were classified mechanically and are outside this task.`]),
    '',
    '## Task manifest',
    renderFencedJsonBlock(rawTaskManifestView(input.task)),
    '',
    '## Context coverage',
    renderFencedJsonBlock(input.context.coverage),
    '',
    '## Relevant ledger projection',
    renderFencedJsonBlock(taskLedgerProjection(input.context.ledger)),
    '',
    '## Owned raw findings',
    renderFencedJsonBlock(input.rawFindings.map((rawFinding) => (
      managerRawFindingView(
        rawFinding,
        input.evidenceRecordsByRawFindingId.get(rawFinding.rawFindingId) ?? [],
      )
    ))),
  ].join('\n');
}

function responseStructuredOutput(response: AgentResponse, label: string): unknown {
  if (response.status !== 'done') {
    throw new Error(
      `${label} failed with status "${response.status}": ${response.error ?? response.content}`,
    );
  }
  if (
    typeof response.structuredOutput !== 'object'
    || response.structuredOutput === null
    || Array.isArray(response.structuredOutput)
  ) {
    throw new Error(`${label} output must be an object`);
  }
  return response.structuredOutput;
}

function validateRawTaskOutput(
  task: MainManagerRawTask,
  rawFindings: readonly RawFinding[],
  output: ReturnType<typeof parseMainManagerRawTaskOutput>,
): AdaptedMainManagerRawTaskDecision[] {
  if (output.taskId !== task.taskId) {
    throw new Error(`Raw task "${task.taskId}" returned mismatched taskId "${output.taskId}"`);
  }
  const expected = new Set(task.ownedRawFindingIds);
  const seen = new Set<string>();
  for (const decision of output.decisions) {
    if (!expected.has(decision.rawFindingId)) {
      throw new Error(`Raw task "${task.taskId}" returned out-of-scope raw id "${decision.rawFindingId}"`);
    }
    if (seen.has(decision.rawFindingId)) {
      throw new Error(`Raw task "${task.taskId}" duplicated raw id "${decision.rawFindingId}"`);
    }
    seen.add(decision.rawFindingId);
    const expectedComponentId = task.componentIdByRawFindingId.get(decision.rawFindingId);
    if (decision.componentId !== expectedComponentId) {
      throw new Error(`Raw task "${task.taskId}" returned a mismatched componentId for "${decision.rawFindingId}"`);
    }
  }
  const missing = task.ownedRawFindingIds.filter((rawFindingId) => !seen.has(rawFindingId));
  if (missing.length > 0) {
    throw new Error(`Raw task "${task.taskId}" omitted owned raw ids: ${missing.join(', ')}`);
  }
  return adaptProviderRawDecisions(output.decisions, rawFindings);
}

function splitRawTask(
  previousLedger: FindingLedger,
  item: RawTaskQueueItem,
): [RawTaskQueueItem, RawTaskQueueItem] {
  const rawsByComponent = new Map<string, RawFinding[]>();
  for (const raw of item.rawFindings) {
    const componentId = item.task.componentIdByRawFindingId.get(raw.rawFindingId)!;
    rawsByComponent.set(
      componentId,
      [...(rawsByComponent.get(componentId) ?? []), raw],
    );
  }
  const componentGroups = [...rawsByComponent.values()];
  let leftRaws: RawFinding[];
  let rightRaws: RawFinding[];
  if (componentGroups.length === 1) {
    const splitAt = Math.ceil(item.rawFindings.length / 2);
    leftRaws = item.rawFindings.slice(0, splitAt);
    rightRaws = item.rawFindings.slice(splitAt);
  } else {
    const targetSize = Math.ceil(item.rawFindings.length / 2);
    leftRaws = [];
    rightRaws = [];
    for (const group of componentGroups) {
      if (leftRaws.length === 0 || leftRaws.length + group.length <= targetSize) {
        leftRaws.push(...group);
      } else {
        rightRaws.push(...group);
      }
    }
    if (rightRaws.length === 0) {
      const lastComponentId = item.task.componentIdByRawFindingId.get(
        leftRaws.at(-1)!.rawFindingId,
      )!;
      const moved = leftRaws.filter((raw) => (
        item.task.componentIdByRawFindingId.get(raw.rawFindingId) === lastComponentId
      ));
      leftRaws = leftRaws.filter((raw) => (
        item.task.componentIdByRawFindingId.get(raw.rawFindingId) !== lastComponentId
      ));
      rightRaws.push(...moved);
    }
  }
  const basePath = [Number.parseInt(item.task.taskId.slice(0, 8), 16)];
  const bindingsFor = (raws: readonly RawFinding[]): Map<string, string> => (
    new Map(raws.map((raw) => [
      raw.rawFindingId,
      item.task.componentIdByRawFindingId.get(raw.rawFindingId)!,
    ]))
  );
  return [
    createRawTask(previousLedger, leftRaws, bindingsFor(leftRaws), [...basePath, 0]),
    createRawTask(previousLedger, rightRaws, bindingsFor(rightRaws), [...basePath, 1]),
  ];
}

function normalizeRawDecision(
  decision: AdaptedMainManagerRawTaskDecision,
): FindingManagerDecisions['rawDecisions'][number] {
  return {
    rawFindingId: decision.rawFindingId,
    decision: decision.decision,
    anchorRelevance: decision.anchorRelevance,
    ...(decision.findingId === undefined || decision.findingId.length === 0
      ? {}
      : { findingId: decision.findingId }),
    evidence: decision.evidence,
  };
}

function componentCompatibilityKey(
  decision: AdaptedMainManagerRawTaskDecision,
): string {
  return canonicalJson({
    decision: decision.decision,
    findingId: decision.findingId,
    anchorRelevance: decision.anchorRelevance,
  });
}

async function executeRawTasks(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  residualRawFindings: readonly RawFinding[];
  mechanicallyClassifiedCount: number;
  evidenceRecordsByRawFindingId: ReadonlyMap<string, readonly FindingEvidenceRecord[]>;
  managerStep: AgentWorkflowStep;
  runInput: Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;
}): Promise<{
  decisions: FindingManagerDecisions['rawDecisions'];
  failures: Map<string, MainManagerRawFailure>;
  invalidAttemptMessages: string[];
  audits: FindingManagerTaskAudit[];
}> {
  const initialManifest = createMainManagerRawTaskManifest({
    previousLedger: input.previousLedger,
    residualRawFindings: input.residualRawFindings,
  });
  const componentInitialTaskCount = new Map<string, number>();
  for (const item of initialManifest) {
    for (const componentId of new Set(item.task.componentIdByRawFindingId.values())) {
      componentInitialTaskCount.set(
        componentId,
        (componentInitialTaskCount.get(componentId) ?? 0) + 1,
      );
    }
  }
  const queue = [...initialManifest];
  const accepted: AdaptedMainManagerRawTaskDecision[] = [];
  const failures = new Map<string, MainManagerRawFailure>();
  const invalidAttemptMessages: string[] = [];
  const audits: FindingManagerTaskAudit[] = [];

  while (queue.length > 0) {
    const item = queue.shift()!;
    let prepared:
      | { phase1Instruction: string; inputBytes: number }
      | undefined;
    for (const candidateLimit of CONTEXT_CANDIDATE_LIMITS) {
      const context = rawTaskContext(
        input.previousLedger,
        item.rawFindings,
        candidateLimit,
      );
      const instruction = buildRawTaskInstruction({
        contract: input.contract,
        task: item.task,
        rawFindings: item.rawFindings,
        context,
        mechanicallyClassifiedCount: input.mechanicallyClassifiedCount,
        evidenceRecordsByRawFindingId: input.evidenceRecordsByRawFindingId,
      });
      const phase1Instruction = input.runInput.stepExecutor.buildPhase1Instruction(
        instruction,
        input.managerStep,
      );
      const inputBytes = Buffer.byteLength(phase1Instruction, 'utf8');
      if (inputBytes <= MAIN_MANAGER_INPUT_MAX_BYTES) {
        prepared = { phase1Instruction, inputBytes };
        break;
      }
    }
    if (prepared === undefined) {
      if (item.rawFindings.length > 1) {
        const [left, right] = splitRawTask(input.previousLedger, item);
        queue.unshift(right);
        queue.unshift(left);
        const leftComponents = new Set(left.task.componentIdByRawFindingId.values());
        const rightComponents = new Set(right.task.componentIdByRawFindingId.values());
        for (const componentId of leftComponents) {
          if (rightComponents.has(componentId)) {
            componentInitialTaskCount.set(
              componentId,
              (componentInitialTaskCount.get(componentId) ?? 1) + 1,
            );
          }
        }
        continue;
      }
      const rawFindingId = item.task.ownedRawFindingIds[0]!;
      const reason = `Fully rendered manager input exceeds ${MAIN_MANAGER_INPUT_MAX_BYTES} UTF-8 bytes even for one raw finding`;
      failures.set(rawFindingId, { kind: 'manager-input-overflow', reason });
      audits.push({
        taskId: item.task.taskId,
        taskKind: 'raw',
        ownedIds: [rawFindingId],
        status: 'input_overflow',
        inputBytes: null,
        reason,
      });
      continue;
    }
    try {
      const response = await runPreparedManagerAttempt({
        managerStep: input.managerStep,
        phase1Instruction: prepared.phase1Instruction,
        optionsBuilder: input.runInput.optionsBuilder,
        stepExecutor: input.runInput.stepExecutor,
      });
      const output = parseMainManagerRawTaskOutput(
        responseStructuredOutput(response, `Raw task "${item.task.taskId}"`),
      );
      accepted.push(...validateRawTaskOutput(
        item.task,
        item.rawFindings,
        output,
      ));
      audits.push({
        taskId: item.task.taskId,
        taskKind: 'raw',
        ownedIds: item.task.ownedRawFindingIds,
        status: 'succeeded',
        inputBytes: prepared.inputBytes,
        output,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const rawFindingId of item.task.ownedRawFindingIds) {
        failures.set(rawFindingId, {
          kind: 'raw-adjudication-unresolved',
          reason,
        });
      }
      invalidAttemptMessages.push(reason);
      audits.push({
        taskId: item.task.taskId,
        taskKind: 'raw',
        ownedIds: item.task.ownedRawFindingIds,
        status: 'failed',
        inputBytes: prepared.inputBytes,
        reason,
      });
    }
  }

  const decisionsByComponent = new Map<
    string,
    AdaptedMainManagerRawTaskDecision[]
  >();
  for (const decision of accepted) {
    decisionsByComponent.set(
      decision.componentId,
      [...(decisionsByComponent.get(decision.componentId) ?? []), decision],
    );
  }
  const rejectedComponents = new Set<string>();
  for (const [componentId, decisions] of decisionsByComponent) {
    if ((componentInitialTaskCount.get(componentId) ?? 1) <= 1) {
      continue;
    }
    const compatibility = new Set(decisions.map(componentCompatibilityKey));
    if (compatibility.size <= 1) {
      continue;
    }
    rejectedComponents.add(componentId);
    const reason = `Raw component "${componentId}" produced incompatible cross-task outcomes`;
    invalidAttemptMessages.push(reason);
    for (const raw of input.residualRawFindings) {
      if (
        initialManifest.some((item) => (
          item.task.componentIdByRawFindingId.get(raw.rawFindingId) === componentId
        ))
      ) {
        failures.set(raw.rawFindingId, {
          kind: 'raw-adjudication-unresolved',
          reason,
        });
      }
    }
  }
  return {
    decisions: accepted
      .filter((decision) => !rejectedComponents.has(decision.componentId))
      .map(normalizeRawDecision),
    failures,
    invalidAttemptMessages,
    audits,
  };
}

function boundedPriorTextForFinding(
  priorStepResponseText: string | undefined,
  findingId: string,
): string {
  if (priorStepResponseText === undefined) {
    return '(no prior step response)';
  }
  const index = priorStepResponseText.indexOf(findingId);
  const start = Math.max(0, index < 0 ? 0 : index - Math.floor(CONTROL_PRIOR_TEXT_LIMIT / 2));
  return priorStepResponseText.slice(start, start + CONTROL_PRIOR_TEXT_LIMIT);
}

function controlTask(
  previousLedger: FindingLedger,
  reviewScopeSnapshotId: string,
  kind: MainManagerControlTask['kind'],
  ownedEntityIds: string[],
  candidateIntents: MainManagerControlIntent[],
  taskScopeContext?: MainManagerTaskScopeContext,
): ControlTaskQueueItem {
  const sortedIds = sortedUnique(ownedEntityIds);
  const sortedIntents = [...candidateIntents].sort((left, right) => (
    compareBinaryStrings(left.intentId, right.intentId)
  ));
  const targetHeads = new Map(sortedIds.map((entityId) => [
    entityId,
    captureFindingLifecycleHead(
      previousLedger,
      kind === 'conflict' ? 'conflict' : 'finding',
      entityId,
    ) ?? null,
  ]));
  const conflictEvidenceSetHashes = new Map(
    kind === 'conflict'
      ? sortedIds.flatMap((entityId) => {
          const conflict = previousLedger.conflicts.find(
            (candidate) => candidate.id === entityId,
          );
          return conflict === undefined
            ? []
            : [[
                entityId,
                computeConflictEvidenceHash(
                  conflict,
                  previousLedger,
                  reviewScopeSnapshotId,
                ),
              ] as const];
        })
      : [],
  );
  const id = taskId('finding-manager-control-task-v1', {
    kind,
    ownedEntityIds: sortedIds,
    targetHeads: [...targetHeads.entries()],
    conflictEvidenceSetHashes: [...conflictEvidenceSetHashes.entries()],
    candidateIntents: sortedIntents,
    ...(taskScopeContext === undefined
      ? {}
      : {
          taskScopeBinding: {
            managerAuthority: taskScopeContext.managerAuthority,
            workflowTaskDigest: taskScopeContext.workflowTaskDigest,
            reportExcerptBindings: taskScopeContext.reportExcerpts.map((excerpt) => ({
              publicationId: excerpt.publicationId,
              reportDigest: excerpt.reportDigest,
              excerptDigest: excerpt.excerptDigest,
            })),
          },
        }),
  });
  return {
    task: {
      taskId: id,
      kind,
      ownedEntityIds: sortedIds,
      targetHeads,
      conflictEvidenceSetHashes,
      candidateIntents: sortedIntents,
      ...(taskScopeContext === undefined ? {} : { taskScopeContext }),
    },
  };
}

function controlIntent(
  kind: MainManagerControlIntent['kind'],
  entityId: string,
  note: string,
): MainManagerControlIntent {
  return {
    intentId: taskId('finding-manager-control-intent-v1', {
      kind,
      entityId,
      note,
    }),
    kind,
    entityId,
    note,
  };
}

export function createMainManagerControlTaskManifest(input: {
  previousLedger: FindingLedger;
  reviewScopeSnapshotId: string;
  priorStepResponseText: string | undefined;
  invalidLocationCandidates: ReadonlyMap<string, string>;
  dismissCandidates: ReadonlyMap<string, string>;
  managerAuthority: RunFindingManagerForStepInput['managerAuthority'];
  workflowTask: string;
  subResults: RunFindingManagerForStepInput['subResults'];
}): ControlTaskQueueItem[] {
  const tasks: ControlTaskQueueItem[] = [];
  const findingIntents = new Map<string, MainManagerControlIntent[]>();
  const addFindingIntent = (
    kind: Extract<MainManagerControlIntent['kind'], 'dispute' | 'invalidate' | 'dismiss'>,
    findingId: string,
    note: string,
  ): void => {
    findingIntents.set(
      findingId,
      [...(findingIntents.get(findingId) ?? []), controlIntent(kind, findingId, note)],
    );
  };
  for (const finding of [...input.previousLedger.findings].sort((left, right) => (
    compareBinaryStrings(left.id, right.id)
  ))) {
    if (hasDisputeClaimFor(input.priorStepResponseText, finding.id)) {
      addFindingIntent(
        'dispute',
        finding.id,
        `Coder dispute excerpt:\n${boundedPriorTextForFinding(input.priorStepResponseText, finding.id)}`,
      );
    }
  }
  for (const [findingId, reason] of [...input.invalidLocationCandidates.entries()]
    .sort(([left], [right]) => compareBinaryStrings(left, right))) {
    addFindingIntent('invalidate', findingId, `Engine invalid-location candidate: ${reason}`);
  }
  for (const [findingId, reason] of [...input.dismissCandidates.entries()]
    .sort(([left], [right]) => compareBinaryStrings(left, right))) {
    addFindingIntent('dismiss', findingId, `Engine dismissal candidate: ${reason}`);
  }
  for (const [findingId, candidateIntents] of [...findingIntents]
    .sort(([left], [right]) => compareBinaryStrings(left, right))) {
    const finding = input.previousLedger.findings.find(
      (candidate) => candidate.id === findingId,
    );
    if (finding === undefined) {
      throw new Error(`Control task target finding "${findingId}" is missing`);
    }
    const taskScopeContext: MainManagerTaskScopeContext | undefined = (
      input.managerAuthority === 'terminal_adjudication'
      && candidateIntents.some((intent) => intent.kind === 'dismiss')
    )
      ? {
          managerAuthority: input.managerAuthority,
          workflowTaskDigest: computeWorkflowTaskDigest(input.workflowTask),
          workflowTask: input.workflowTask,
          reportExcerpts: collectTaskScopeReportExcerpts({
            finding,
            ledgerRawFindings: input.previousLedger.rawFindings,
            publications: input.subResults.map((result) => result.publication),
          }),
        }
      : undefined;
    tasks.push(controlTask(
      input.previousLedger,
      input.reviewScopeSnapshotId,
      'finding_control',
      [findingId],
      candidateIntents,
      taskScopeContext,
    ));
  }
  for (const conflict of [...input.previousLedger.conflicts]
    .filter((candidate) => candidate.status === 'active')
    .sort((left, right) => compareBinaryStrings(left.id, right.id))) {
    tasks.push(controlTask(
      input.previousLedger,
      input.reviewScopeSnapshotId,
      'conflict',
      [conflict.id],
      [
      controlIntent(
        'conflict',
        conflict.id,
        `Active conflict candidate: ${conflict.description}`,
      ),
      ],
    ));
  }
  return tasks.sort((left, right) => compareBinaryStrings(
    `${left.task.kind}:${left.task.ownedEntityIds.join(',')}`,
    `${right.task.kind}:${right.task.ownedEntityIds.join(',')}`,
  ));
}

function controlContextLedger(
  previousLedger: FindingLedger,
  task: MainManagerControlTask,
): FindingLedger {
  const selectedFindingIds = new Set(
    task.kind === 'conflict'
      ? previousLedger.conflicts
        .filter((conflict) => task.ownedEntityIds.includes(conflict.id))
        .flatMap((conflict) => conflict.findingIds)
      : task.ownedEntityIds,
  );
  const selectedConflicts = previousLedger.conflicts
    .filter((conflict) => (
      task.ownedEntityIds.includes(conflict.id)
      || conflict.findingIds.some((id) => selectedFindingIds.has(id))
    ))
    .sort((left, right) => compareBinaryStrings(left.id, right.id))
    .slice(0, COMPACT_CONFLICT_COLLECTION_LIMIT)
    .map((conflict) => compactConflictForPrompt(conflict, selectedFindingIds));
  return {
    ...previousLedger,
    findings: previousLedger.findings.filter((finding) => selectedFindingIds.has(finding.id)),
    conflicts: selectedConflicts,
  };
}

function buildControlTaskInstruction(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  task: MainManagerControlTask;
}): string {
  const hasDismissIntent = input.task.candidateIntents.some(
    (intent) => intent.kind === 'dismiss',
  );
  const dismissalAuthorityInstruction = !hasDismissIntent
    ? []
    : input.task.taskScopeContext !== undefined
      ? ['For dismiss intents, outside_task_scope is authorized only when taskQuote is a non-empty byte-exact quote from the Original workflow task. outside_contract_jurisdiction and unverifiable_claim retain their existing meanings. You may additionally use false_positive, overreach, or no_issue_after_verification after directly checking the current code. Non-task-scope dismissals require concrete current-code evidence; silence or non-repetition is never sufficient.']
      : ['For dismiss intents, only outside_contract_jurisdiction or unverifiable_claim are allowed. outside_task_scope, false_positive, overreach, and no_issue_after_verification are not authorized in this task.'];
  const taskScopeContext = input.task.taskScopeContext;
  return [
    input.contract.manager.instruction,
    '',
    '## Control task output override',
    'The Finding Manager instruction above may describe a legacy rawDecisions/dismissDecisions envelope. That envelope is disabled for this control task.',
    'Return exactly one object whose only top-level fields are taskId, evaluations, and selectedIntentId. Do not return rawDecisions, dismissDecisions, or any other legacy envelope field.',
    'Each evaluations entry must contain exactly intentId and result. Exact-cover every candidate intent.',
    'An outside_task_scope result has exactly this shape: {"kind":"dismiss","findingId":"<intent entityId>","basis":"outside_task_scope","reason":"<separate reason>","taskQuote":"<non-empty byte-exact workflow task substring>"}. It has no evidence field.',
    '',
    'This is one engine-owned control task. Return the exact taskId and exact-cover evaluations for every candidate intent.',
    'Set selectedIntentId to null when every evaluation is no_action. Otherwise select exactly one intent, return its matching action, and return no_action for every other intent.',
    'Never reference an entity outside the intent entityId. The engine will reject stale target heads at commit.',
    ...dismissalAuthorityInstruction,
    '',
    '## Task manifest',
    renderFencedJsonBlock({
      taskId: input.task.taskId,
      kind: input.task.kind,
      ownedEntityIds: input.task.ownedEntityIds,
      candidateIntents: input.task.candidateIntents,
      targetHeads: input.task.ownedEntityIds.map((entityId) => ({
        entityId,
        targetHead: input.task.targetHeads.get(entityId) ?? null,
        evidenceSetHash: input.task.conflictEvidenceSetHashes.get(entityId) ?? null,
      })),
      ...(taskScopeContext === undefined
        ? {}
        : {
            managerAuthority: taskScopeContext.managerAuthority,
            workflowTaskDigest: taskScopeContext.workflowTaskDigest,
            reportExcerptBindings: taskScopeContext.reportExcerpts.map((excerpt) => ({
              publicationId: excerpt.publicationId,
              reportDigest: excerpt.reportDigest,
              excerptDigest: excerpt.excerptDigest,
            })),
          }),
    }),
    ...(taskScopeContext === undefined
      ? []
      : [
          '',
          '## Original workflow task',
          taskScopeContext.workflowTask,
          '',
          '## Relevant current review report excerpts',
          renderFencedJsonBlock(taskScopeContext.reportExcerpts),
        ]),
    '',
    '## Relevant ledger projection',
    renderFencedJsonBlock(taskLedgerProjection(
      controlContextLedger(input.previousLedger, input.task),
    )),
  ].join('\n');
}

function validateControlTaskOutput(
  task: MainManagerControlTask,
  output: MainManagerControlTaskOutput,
): MainManagerControlTaskOutput['evaluations'] {
  if (output.taskId !== task.taskId) {
    throw new Error(`Control task "${task.taskId}" returned mismatched taskId "${output.taskId}"`);
  }
  const intentsById = new Map(task.candidateIntents.map((intent) => [intent.intentId, intent]));
  const returnedIntentIds = output.evaluations.map((evaluation) => evaluation.intentId);
  if (
    output.evaluations.length !== task.candidateIntents.length
    || new Set(returnedIntentIds).size !== returnedIntentIds.length
    || returnedIntentIds.some((intentId) => !intentsById.has(intentId))
  ) {
    throw new Error(`Control task "${task.taskId}" did not exact-cover candidateIntents`);
  }
  const accepted = output.evaluations.filter((evaluation) => (
    evaluation.result.kind !== 'no_action'
  ));
  if (
    accepted.length > 1
    || (accepted.length === 0 && output.selectedIntentId !== null)
    || (accepted.length === 1 && output.selectedIntentId !== accepted[0]!.intentId)
  ) {
    throw new Error(`Control task "${task.taskId}" returned an inconsistent selectedIntentId`);
  }
  for (const evaluation of output.evaluations) {
    const intent = intentsById.get(evaluation.intentId)!;
    const result = evaluation.result;
    if (result.kind === 'no_action') {
      continue;
    }
    const kindMatches = (
      (intent.kind === 'dispute' && (result.kind === 'waive' || result.kind === 'note'))
      || (intent.kind === 'conflict' && (result.kind === 'resolve' || result.kind === 'keep'))
      || intent.kind === result.kind
    );
    if (!kindMatches) {
      throw new Error(
        `Control intent "${intent.intentId}" returned action "${result.kind}" for kind "${intent.kind}"`,
      );
    }
    if ('findingId' in result && result.findingId !== intent.entityId) {
      throw new Error(
        `Control intent "${intent.intentId}" returned out-of-scope finding "${result.findingId}"`,
      );
    }
    if ('conflictId' in result && result.conflictId !== intent.entityId) {
      throw new Error(
        `Control intent "${intent.intentId}" returned out-of-scope conflict "${result.conflictId}"`,
      );
    }
    if (
      result.kind === 'dismiss'
      && result.basis === 'outside_task_scope'
      && (
        task.taskScopeContext === undefined
        || !isByteExactWorkflowTaskQuote(
          task.taskScopeContext.workflowTask,
          result.taskQuote,
        )
      )
    ) {
      throw new Error(
        `Control intent "${intent.intentId}" returned an unauthorized or mismatched outside_task_scope taskQuote`,
      );
    }
  }
  return output.evaluations;
}

function appendControlResult(
  decisions: FindingManagerDecisions,
  result: MainManagerControlTaskOutput['evaluations'][number]['result'],
  task: MainManagerControlTask,
): void {
  switch (result.kind) {
    case 'no_action':
      return;
    case 'waive':
    case 'note':
      decisions.disputeDecisions.push({
        findingId: result.findingId,
        decision: result.kind,
        reason: result.reason,
        evidence: result.evidence,
      });
      return;
    case 'resolve':
    case 'keep':
      decisions.conflictDecisions.push({
        conflictId: result.conflictId,
        decision: result.kind,
        evidence: result.evidence,
      });
      return;
    case 'invalidate':
      decisions.invalidateDecisions.push({
        findingId: result.findingId,
        evidence: result.evidence,
      });
      return;
    case 'dismiss':
      if (result.basis === 'outside_task_scope') {
        if (task.taskScopeContext === undefined) {
          throw new Error(
            `Control task "${task.taskId}" lacks an outside_task_scope binding`,
          );
        }
        decisions.dismissDecisions.push({
          findingId: result.findingId,
          basis: result.basis,
          reason: result.reason,
          taskQuote: result.taskQuote,
          workflowTaskDigest: task.taskScopeContext.workflowTaskDigest,
          adjudicationTaskId: task.taskId,
        });
      } else {
        decisions.dismissDecisions.push({
          findingId: result.findingId,
          basis: result.basis,
          reason: result.reason,
          evidence: result.evidence,
        });
      }
  }
}

async function executeControlTasks(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  reviewScopeSnapshotId: string;
  priorStepResponseText: string | undefined;
  invalidLocationCandidates: ReadonlyMap<string, string>;
  dismissCandidates: ReadonlyMap<string, string>;
  managerStep: AgentWorkflowStep;
  runInput: Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;
  managerAuthority: RunFindingManagerForStepInput['managerAuthority'];
  workflowTask: string;
  subResults: RunFindingManagerForStepInput['subResults'];
}): Promise<{
  decisions: FindingManagerDecisions;
  conflictTargetHeads: Map<string, CapturedManagerConflictHead>;
  invalidAttemptMessages: string[];
  audits: FindingManagerTaskAudit[];
}> {
  const decisions = emptyDecisions();
  const conflictTargetHeads = new Map<string, CapturedManagerConflictHead>();
  const invalidAttemptMessages: string[] = [];
  const audits: FindingManagerTaskAudit[] = [];
  const controlStep = buildFindingManagerControlTaskStep(input.managerStep);
  const tasks = createMainManagerControlTaskManifest(input);
  for (const item of tasks) {
    const instruction = buildControlTaskInstruction({
      contract: input.contract,
      previousLedger: input.previousLedger,
      task: item.task,
    });
    const phase1Instruction = input.runInput.stepExecutor.buildPhase1Instruction(
      instruction,
      controlStep,
    );
    const inputBytes = Buffer.byteLength(phase1Instruction, 'utf8');
    if (inputBytes > MAIN_MANAGER_INPUT_MAX_BYTES) {
      const reason = `Control task input exceeds ${MAIN_MANAGER_INPUT_MAX_BYTES} UTF-8 bytes`;
      invalidAttemptMessages.push(reason);
      audits.push({
        taskId: item.task.taskId,
        taskKind: item.task.kind,
        ownedIds: item.task.ownedEntityIds,
        status: 'input_overflow',
        inputBytes,
        reason,
      });
      continue;
    }
    try {
      const response = await runPreparedManagerAttempt({
        managerStep: controlStep,
        phase1Instruction,
        optionsBuilder: input.runInput.optionsBuilder,
        stepExecutor: input.runInput.stepExecutor,
      });
      const output = parseMainManagerControlTaskOutput(
        responseStructuredOutput(response, `Control task "${item.task.taskId}"`),
      );
      const evaluations = validateControlTaskOutput(item.task, output);
      for (const evaluation of evaluations) {
        appendControlResult(decisions, evaluation.result, item.task);
        if (
          evaluation.result.kind === 'resolve'
          || evaluation.result.kind === 'keep'
        ) {
          conflictTargetHeads.set(
            evaluation.result.conflictId,
            {
              lifecycleHead:
                item.task.targetHeads.get(evaluation.result.conflictId) ?? null,
              evidenceSetHash: item.task.conflictEvidenceSetHashes.get(
                evaluation.result.conflictId,
              )!,
              reviewScopeSnapshotId: input.reviewScopeSnapshotId,
            },
          );
        }
      }
      audits.push({
        taskId: item.task.taskId,
        taskKind: item.task.kind,
        ownedIds: item.task.ownedEntityIds,
        status: 'succeeded',
        inputBytes,
        output,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      invalidAttemptMessages.push(reason);
      audits.push({
        taskId: item.task.taskId,
        taskKind: item.task.kind,
        ownedIds: item.task.ownedEntityIds,
        status: 'failed',
        inputBytes,
        reason,
      });
    }
  }
  return { decisions, conflictTargetHeads, invalidAttemptMessages, audits };
}

function assertFixedPrefixFits(input: {
  contract: FindingContractConfig;
  managerStep: AgentWorkflowStep;
  stepExecutor: RunFindingManagerForStepInput['stepExecutor'];
}): void {
  const emptyTask = createRawTask({
    workflowName: '__manager-prefix-check__',
    nextId: 1,
    updatedAt: '1970-01-01T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  }, [], new Map(), []);
  const instruction = buildRawTaskInstruction({
    contract: input.contract,
    task: emptyTask.task,
    rawFindings: [],
    context: rawTaskContext(
      {
        workflowName: '__manager-prefix-check__',
        nextId: 1,
        updatedAt: '1970-01-01T00:00:00.000Z',
        findings: [],
        evidenceRecords: [],
        evidenceBindings: [],
        lifecycleReservations: [],
        lifecycleEvents: [],
        rawRecoveryAttempts: [],
        rawRecoveryResults: [],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      },
      [],
      0,
    ),
    mechanicallyClassifiedCount: 0,
    evidenceRecordsByRawFindingId: new Map(),
  });
  const phase1 = input.stepExecutor.buildPhase1Instruction(instruction, input.managerStep);
  const bytes = Buffer.byteLength(phase1, 'utf8');
  if (bytes > MAIN_MANAGER_INPUT_MAX_BYTES) {
    throw new Error(
      `Finding manager fixed instruction prefix exceeds ${MAIN_MANAGER_INPUT_MAX_BYTES} UTF-8 bytes (${bytes})`,
    );
  }
}

export async function runMainManagerTasks(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  reviewScopeSnapshotId: string;
  residualRawFindings: readonly RawFinding[];
  mechanicallyClassifiedCount: number;
  priorStepResponseText: string | undefined;
  invalidLocationCandidates: ReadonlyMap<string, string>;
  dismissCandidates: ReadonlyMap<string, string>;
  evidenceRecordsByRawFindingId: ReadonlyMap<string, readonly FindingEvidenceRecord[]>;
  managerStep: AgentWorkflowStep;
  runInput: Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;
  managerAuthority: RunFindingManagerForStepInput['managerAuthority'];
  workflowTask: string;
  subResults: RunFindingManagerForStepInput['subResults'];
}): Promise<MainManagerTaskExecution> {
  assertFixedPrefixFits({
    contract: input.contract,
    managerStep: input.managerStep,
    stepExecutor: input.runInput.stepExecutor,
  });
  const raw = await executeRawTasks(input);
  const control = await executeControlTasks(input);
  return {
    decisions: {
      rawDecisions: raw.decisions,
      disputeDecisions: control.decisions.disputeDecisions,
      conflictDecisions: control.decisions.conflictDecisions,
      invalidateDecisions: control.decisions.invalidateDecisions,
      duplicateDecisions: control.decisions.duplicateDecisions,
      dismissDecisions: control.decisions.dismissDecisions,
    },
    conflictTargetHeads: control.conflictTargetHeads,
    rawFailures: raw.failures,
    invalidAttemptMessages: [
      ...raw.invalidAttemptMessages,
      ...control.invalidAttemptMessages,
    ],
    taskAudits: [...raw.audits, ...control.audits],
  };
}
