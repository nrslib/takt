const TERMINAL_EVENT_TYPES = new Set(['step_complete', 'workflow_call_complete']);
const EVENT_STATUS_MAP = new Map([
  ['done', 'completed'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['blocked', 'failed'],
  ['error', 'failed'],
  ['rate_limited', 'failed'],
  ['cancelled', 'aborted'],
  ['canceled', 'aborted'],
  ['aborted', 'aborted'],
]);
const MAX_GRAPH_OCCURRENCES = 10_000;
const BUILTIN_WORKFLOW_REF = /^builtin:sha256:([0-9a-f]{64})$/iu;

export function isBuiltinWorkflowRef(value) {
  return typeof value === 'string' && BUILTIN_WORKFLOW_REF.test(value);
}

export function shortBuiltinDigest(value) {
  const match = typeof value === 'string' ? value.match(BUILTIN_WORKFLOW_REF) : null;
  return match === null ? '' : match[1].slice(0, 8);
}

function stackWorkflowName(stack, fallback, value) {
  if (!Array.isArray(stack)) return fallback;
  const matching = [...stack].reverse().find((frame) => (
    (frame?.workflow === value || frame?.workflow_ref === value)
      && typeof frame?.workflow === 'string'
      && !isBuiltinWorkflowRef(frame.workflow)
  ));
  return matching?.workflow ?? fallback;
}

export function workflowDisplayName(value, locale = 'ja', stack) {
  if (!isBuiltinWorkflowRef(value)) return value ?? '';
  const humanName = stackWorkflowName(stack, undefined, value);
  if (humanName !== undefined && !isBuiltinWorkflowRef(humanName)) return humanName;
  const digest = shortBuiltinDigest(value);
  return locale === 'en'
    ? `Builtin workflow · ${digest}`
    : `組み込み workflow · ${digest}`;
}

function eventWorkflow(event, fallback) {
  if (typeof event.workflow === 'string') return event.workflow;
  const stack = Array.isArray(event.stack) ? event.stack : [];
  const current = stack.at(-1);
  return typeof current?.workflow === 'string' ? current.workflow : fallback;
}

function eventIteration(event) {
  return event.iteration;
}

function isWorkflowCall(event) {
  return event.type.startsWith('workflow_call_');
}

export function encodeIdPart(value) {
  const bytes = new TextEncoder().encode(String(value));
  return `x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function normalizedStack(stack) {
  if (!Array.isArray(stack)) return null;
  return stack.map((frame) => [
    frame.workflow,
    frame.workflow_ref,
    frame.step,
    frame.kind,
    frame.occurrence,
  ]);
}

function stackPathKey(stack) {
  const normalized = normalizedStack(stack);
  return normalized === null ? 'root' : JSON.stringify(normalized);
}

function parallelFrameIndex(stack) {
  return [...stack].findLastIndex((frame) => frame?.kind === 'parallel');
}

function validParallelMetadata(value) {
  if (value === null || typeof value !== 'object') return undefined;
  if (value.role !== 'parent'
    && value.role !== 'direct_participant'
    && value.role !== 'workflow_call_participant') return undefined;
  if (typeof value.participationId !== 'string' || value.participationId.length === 0) {
    return undefined;
  }
  if (value.parentParticipationId !== undefined
    && (typeof value.parentParticipationId !== 'string' || value.parentParticipationId.length === 0)) {
    return undefined;
  }
  return value;
}

function parallelMetadataIdentity(parallel) {
  const metadata = validParallelMetadata(parallel);
  if (metadata === undefined) return undefined;
  return [
    metadata.role,
    metadata.participationId,
    metadata.parentParticipationId ?? null,
  ];
}

function legacyParallelRole(event, nodeLabel) {
  if (!Array.isArray(event.stack) || event.stack.length === 0) return undefined;
  const frameIndex = parallelFrameIndex(event.stack);
  if (frameIndex < 0) return undefined;
  const frame = event.stack[frameIndex];
  const eventStep = event.step;
  if (frame === undefined || eventStep === undefined) return undefined;
  if (event.stack.length === frameIndex + 2) {
    return event.stack[frameIndex + 1]?.kind === 'workflow_call'
      ? 'workflow_call_participant'
      : event.stack[frameIndex + 1]?.kind === 'agent'
        || event.stack[frameIndex + 1]?.kind === 'system'
        ? 'direct_participant'
        : undefined;
  }
  if (event.stack.length !== frameIndex + 1) return undefined;
  if (eventStep !== frame.step || nodeLabel !== frame.step) return 'direct_participant';
  // Parallel parents have a step lifecycle, while direct agent participants
  // historically emitted only phase records. This is a fallback for legacy
  // logs; canonical `parallel.role` always takes precedence.
  if (event.type === 'step_start' || event.type === 'step_complete') return 'parent';
  // A phase-only same-name event can be either the parent or a direct agent
  // in legacy logs. Keep it explicitly ambiguous instead of guessing.
  if (event.type.startsWith('phase_')) return 'ambiguous';
  return undefined;
}

function workflowCallInvocationIdentity(stack, frameIndex) {
  const frame = stack[frameIndex];
  if (frame?.kind !== 'workflow_call') return undefined;
  if (typeof frame.workflow_ref !== 'string' || frame.workflow_ref.length === 0
    || typeof frame.step !== 'string' || frame.step.length === 0) return undefined;
  const calls = [];
  for (const entry of stack.slice(0, frameIndex)) {
    const instance = entry.kind === 'workflow_call'
      ? entry.call_instance ?? entry.occurrence
      : entry.occurrence;
    if (!Number.isSafeInteger(instance) || instance < 1
      || typeof entry.workflow_ref !== 'string' || entry.workflow_ref.length === 0
      || typeof entry.step !== 'string' || entry.step.length === 0) return undefined;
    calls.push({
      workflow: entry.workflow_ref,
      step: entry.step,
      kind: entry.kind,
      instance,
    });
  }
  return JSON.stringify({ workflow: frame.workflow_ref, step: frame.step, calls });
}

function siteDigestFromNamespace(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/--site-([0-9a-f]{64})$/iu);
  return match?.[1]?.toLowerCase();
}

function canonicalSiteToken(frame, stack, frameIndex, evidence) {
  const direct = [
    frame.workflowCallSiteDigest,
    frame.callSiteDigest,
    frame.siteDigest,
  ].find((candidate) => typeof candidate === 'string' && candidate.length > 0);
  if (direct !== undefined) return `site:${direct}`;
  const invocations = evidence?.resumePoint?.workflow_call_invocations;
  if (invocations === null || typeof invocations !== 'object' || Array.isArray(invocations)) {
    return undefined;
  }
  const identity = workflowCallInvocationIdentity(stack, frameIndex);
  if (identity === undefined) return undefined;
  const record = invocations[identity];
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const explicit = [record.workflowCallSiteDigest, record.callSiteDigest, record.siteDigest]
    .find((candidate) => typeof candidate === 'string' && candidate.length > 0);
  const digest = explicit ?? siteDigestFromNamespace(record.report_namespace_segment);
  return digest === undefined ? undefined : `site:${digest}`;
}

function parallelFamilyFrame(frame, isParallelFrame, stack, frameIndex, evidence) {
  if (isParallelFrame) {
    return [frame.workflow, frame.workflow_ref, frame.step, frame.kind];
  }
  if (frame.kind === 'workflow_call') {
    const siteToken = canonicalSiteToken(frame, stack, frameIndex, evidence);
    // Historical logs do not carry call-site evidence. Preserve their
    // dynamic-alias grouping, while a verified site token makes same-named
    // call sites distinct and lets aliases sharing that token remain grouped.
    return siteToken === undefined
      ? [frame.workflow, frame.workflow_ref, frame.kind]
      : [frame.workflow, frame.workflow_ref, frame.kind, siteToken];
  }
  return [frame.workflow, frame.workflow_ref, frame.step, frame.kind];
}

export function parallelGroupFamilyKey(stack, evidence) {
  if (!Array.isArray(stack) || stack.length === 0) return undefined;
  const frameIndex = parallelFrameIndex(stack);
  if (frameIndex < 0) return undefined;
  return JSON.stringify(stack.slice(0, frameIndex + 1).map((frame, index) => (
    parallelFamilyFrame(frame, index === frameIndex, stack, index, evidence)
  )));
}

function parallelInvocationPathKey(stack, frameIndex) {
  return JSON.stringify(stack.slice(0, frameIndex + 1).map((frame) => [
    frame.workflow,
    frame.workflow_ref,
    frame.kind,
    frame.occurrence,
  ]));
}

function parallelGroupDescriptorAt(stack, iteration, frameIndex, evidence) {
  const frame = stack[frameIndex];
  if (frame === undefined || !Number.isSafeInteger(iteration) || iteration < 0) {
    return { ambiguous: true };
  }
  const familyKey = JSON.stringify(stack.slice(0, frameIndex + 1).map((entry, index) => (
    parallelFamilyFrame(
      entry,
      index === frameIndex,
      stack,
      index,
      evidence,
    )
  )));
  if (familyKey === undefined) return { ambiguous: true };
  return {
    key: JSON.stringify({
      familyKey,
      iteration,
      invocationPath: parallelInvocationPathKey(stack, frameIndex),
    }),
    familyKey,
    label: frame.step,
    iteration,
    frameIndex,
  };
}

export function parallelGroupDescriptors(stack, iteration, evidence) {
  if (!Array.isArray(stack) || stack.length === 0) return [];
  return [...stack]
    .map((frame, index) => frame?.kind === 'parallel' ? index : -1)
    .filter((index) => index >= 0)
    .map((frameIndex) => parallelGroupDescriptorAt(stack, iteration, frameIndex, evidence))
    .filter((descriptor) => descriptor.ambiguous !== true);
}

function parallelGroupDescriptor(event, meta) {
  if (!Array.isArray(event.stack) || event.stack.length === 0) return null;
  const frameIndex = parallelFrameIndex(event.stack);
  if (frameIndex < 0) return null;
  const descriptors = parallelGroupDescriptors(event.stack, event.iteration, meta);
  return descriptors.find((descriptor) => descriptor.frameIndex === frameIndex)
    ?? { ambiguous: true };
}

function logicalFrameIdentity(frame) {
  return [frame.workflow, frame.workflow_ref, frame.step, frame.kind];
}

function parallelLogicalScopeKey(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return undefined;
  const frameIndexes = [...stack]
    .map((frame, index) => frame?.kind === 'parallel' ? index : -1)
    .filter((index) => index >= 0);
  if (frameIndexes.length === 0) return undefined;
  return JSON.stringify(frameIndexes.map((frameIndex) => ({
    boundary: stack.slice(0, frameIndex + 1).map(logicalFrameIdentity),
    direct: stack[frameIndex + 1] === undefined
      ? null
      : logicalFrameIdentity(stack[frameIndex + 1]),
  })));
}

function parallelGroupFields(event, previous = {}, meta) {
  if (previous.parallelGroupAmbiguous === true) {
    return {
      parallelGroupKey: undefined,
      parallelGroupFamilyKey: undefined,
      parallelGroupIteration: undefined,
      parallelGroupLabel: undefined,
      parallelGroupAmbiguous: true,
      parallelGroupDescriptors: [],
    };
  }
  const descriptor = parallelGroupDescriptor(event, meta);
  if (descriptor === null || descriptor.parent === true) return {};
  if (event.iteration === undefined && previous.parallelGroupKey !== undefined) return {};
  if (descriptor.ambiguous === true) {
    return {
      parallelGroupKey: undefined,
      parallelGroupFamilyKey: undefined,
      parallelGroupIteration: undefined,
      parallelGroupLabel: undefined,
      parallelGroupAmbiguous: true,
      parallelGroupDescriptors: [],
    };
  }
  if (previous.parallelGroupKey !== undefined && previous.parallelGroupKey !== descriptor.key) {
    return {
      parallelGroupKey: undefined,
      parallelGroupFamilyKey: undefined,
      parallelGroupIteration: undefined,
      parallelGroupLabel: undefined,
      parallelGroupAmbiguous: true,
      parallelGroupDescriptors: [],
    };
  }
  const descriptors = parallelGroupDescriptors(event.stack, event.iteration, meta);
  return {
    parallelGroupKey: descriptor.key,
    parallelGroupFamilyKey: descriptor.familyKey,
    parallelGroupIteration: descriptor.iteration,
    parallelGroupLabel: descriptor.label,
    parallelGroupDescriptors: descriptors,
  };
}

function statusFromEvent(event) {
  const mapped = typeof event.status === 'string' ? EVENT_STATUS_MAP.get(event.status) : undefined;
  if (mapped === 'completed' && !TERMINAL_EVENT_TYPES.has(event.type)) return 'running';
  if (mapped !== undefined) return mapped;
  if (event.status !== undefined) return 'running';
  return TERMINAL_EVENT_TYPES.has(event.type) ? 'completed' : 'running';
}

function logicalStepId(workflow, step, kind, childWorkflow, stack, parallel, legacyRole) {
  const target = kind === 'workflow' ? childWorkflow ?? step : step;
  const base = `step:${encodeIdPart(workflow)}:${kind}:${encodeIdPart(target)}`;
  const parallelScope = parallelLogicalScopeKey(stack);
  const withScope = parallelScope === undefined
    ? base
    : `${base}:parallel:${encodeIdPart(parallelScope)}`;
  const parallelIdentity = parallelMetadataIdentity(parallel);
  const withParticipation = parallelIdentity === undefined
    ? withScope
    : `${withScope}:participation:${encodeIdPart(JSON.stringify(parallelIdentity))}`;
  return parallelIdentity === undefined && legacyRole !== undefined
    ? `${withParticipation}:legacy-role:${legacyRole}`
    : withParticipation;
}

function eventDescriptor(event, meta) {
  if (event.step === undefined) return null;
  const workflow = eventWorkflow(event, meta.workflow);
  const kind = isWorkflowCall(event) ? 'workflow' : 'step';
  const childWorkflow = kind === 'workflow' ? event.childWorkflow : undefined;
  const legacyRole = event.parallel === undefined
    ? legacyParallelRole(event, event.step)
    : undefined;
  const logicalId = logicalStepId(
    workflow,
    event.step,
    kind,
    childWorkflow,
    event.stack,
    event.parallel,
    legacyRole,
  );
  const baseKey = `${logicalId}:scope:${stackPathKey(event.stack)}`;
  return {
    workflow,
    kind,
    childWorkflow,
    logicalId,
    baseKey,
    ...(typeof event.occurrenceId === 'string' && event.occurrenceId.length > 0
      ? { occurrenceId: event.occurrenceId }
      : {}),
  };
}

function mergeJudgeStages(previous, next) {
  const stages = Array.isArray(previous) ? [...previous] : [];
  for (const candidate of Array.isArray(next) ? next : []) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const duplicate = stages.some((stage) => (
      stage.stage === candidate.stage
      && stage.method === candidate.method
      && stage.status === candidate.status
      && stage.response === candidate.response
    ));
    if (!duplicate) stages.push(candidate);
  }
  return stages;
}

function judgeStageFromEvent(event) {
  if (event.type !== 'phase_judge_stage'
    || !Number.isSafeInteger(event.stage)
    || event.stage < 1
    || typeof event.method !== 'string'
    || typeof event.status !== 'string'
    || typeof event.response !== 'string') return undefined;
  return {
    stage: event.stage,
    method: event.method,
    status: event.status,
    response: event.response,
  };
}

function terminalStatusFromEvent(event) {
  if (TERMINAL_EVENT_TYPES.has(event.type)) return statusFromEvent(event);
  if (event.type !== 'phase_complete') return undefined;
  const mapped = typeof event.status === 'string' ? EVENT_STATUS_MAP.get(event.status) : undefined;
  if (mapped === 'failed' || mapped === 'aborted') return mapped;
  // A completed execute/report phase is progress, not a completed step. The
  // judge phase is the persisted terminal phase for parallel children.
  return event.phaseName === 'judge' && mapped === 'completed' ? 'completed' : undefined;
}

function occurrenceMetadata(event, previous = {}) {
  const metadata = {};
  for (const key of [
    'matchedRuleIndex',
    'matchedRuleMethod',
    'matchMethod',
    'returnValue',
    'provider',
    'providerSource',
    'model',
    'modelSource',
  ]) {
    if (event[key] !== undefined) metadata[key] = event[key];
    else if (previous[key] !== undefined) metadata[key] = previous[key];
  }
  const judgeStages = mergeJudgeStages(previous.judgeStages, event.judgeStages);
  const eventStage = event.judgeStage ?? judgeStageFromEvent(event);
  if (eventStage !== undefined) {
    const withEventStage = mergeJudgeStages(judgeStages, [eventStage]);
    if (withEventStage.length > 0) metadata.judgeStages = withEventStage;
  } else if (judgeStages.length > 0) {
    metadata.judgeStages = judgeStages;
  }
  const terminalStatus = terminalStatusFromEvent(event);
  if (terminalStatus !== undefined) metadata.terminalStatus = terminalStatus;
  else if (previous.terminalStatus !== undefined) metadata.terminalStatus = previous.terminalStatus;
  return metadata;
}

function parallelOccurrenceFields(event, previous = {}) {
  const metadata = validParallelMetadata(event.parallel) ?? previous.parallel;
  const legacyRole = legacyParallelRole(event, event.step);
  const role = metadata?.role ?? previous.parallelRole
    ?? (legacyRole === 'ambiguous' ? undefined : legacyRole);
  return {
    ...(metadata === undefined ? {} : { parallel: metadata }),
    ...(role === undefined ? {} : { parallelRole: role }),
    ...(metadata?.participationId === undefined
      ? previous.parallelParticipationId === undefined
        ? {}
        : { parallelParticipationId: previous.parallelParticipationId }
      : { parallelParticipationId: metadata.participationId }),
    ...(metadata?.parentParticipationId === undefined
      ? previous.parallelParentParticipationId === undefined
        ? {}
        : { parallelParentParticipationId: previous.parallelParentParticipationId }
      : { parallelParentParticipationId: metadata.parentParticipationId }),
    ...(metadata !== undefined
      ? { parallelLegacyAmbiguous: undefined }
      : previous.parallelLegacyAmbiguous === true || legacyRole === 'ambiguous'
        ? { parallelLegacyAmbiguous: true }
        : {}),
  };
}

function createOccurrence(event, descriptor, firstEventIndex, recordEventIndexes, meta) {
  const preview = event.preview ?? event.error ?? event.reason ?? event.content?.slice(0, 2_000);
  return {
    id: descriptor.occurrenceId,
    logicalId: descriptor.logicalId,
    workflow: descriptor.workflow,
    kind: descriptor.kind,
    childWorkflow: descriptor.childWorkflow,
    iteration: eventIteration(event),
    callInstance: event.callInstance,
    stack: event.stack,
    ...parallelOccurrenceFields(event),
    status: statusFromEvent(event),
    phases: event.phaseName === undefined ? [] : [event.phaseName],
    personas: event.persona === undefined ? [] : [event.persona],
    ...(preview === undefined ? {} : {
      preview,
      previewTruncated: event.previewTruncated === true || event.content?.length > 2_000,
    }),
    eventIndexes: recordEventIndexes ? [firstEventIndex] : [],
    firstEventIndex,
    lastEventIndex: firstEventIndex,
    ...occurrenceMetadata(event),
    ...parallelGroupFields(event, {}, meta),
  };
}

function mergeStatus(previous, next) {
  if (next === 'failed' || next === 'aborted') return next;
  if (previous === 'failed' || previous === 'aborted') return previous;
  if (next === 'completed') return next;
  return previous;
}

function updateOccurrence(occurrence, event, eventIndex, recordEventIndexes, meta) {
  const phases = event.phaseName !== undefined && !occurrence.phases.includes(event.phaseName)
    ? [...occurrence.phases, event.phaseName]
    : occurrence.phases;
  const personas = event.persona !== undefined && !occurrence.personas.includes(event.persona)
    ? [...occurrence.personas, event.persona]
    : occurrence.personas;
  const preview = event.preview ?? event.error ?? event.reason ?? event.content?.slice(0, 2_000);
  return {
    ...occurrence,
    status: mergeStatus(occurrence.status, statusFromEvent(event)),
    phases,
    personas,
    stack: event.stack ?? occurrence.stack,
    ...parallelOccurrenceFields(event, occurrence),
    ...(preview === undefined ? {} : {
      preview,
      previewTruncated: event.previewTruncated === true || event.content?.length > 2_000,
    }),
    ...occurrenceMetadata(event, occurrence),
    ...parallelGroupFields(event, occurrence, meta),
    eventIndexes: recordEventIndexes
      ? [...occurrence.eventIndexes, eventIndex]
      : occurrence.eventIndexes,
    lastEventIndex: eventIndex,
  };
}

function replaceOccurrence(nodesByLogicalId, occurrence) {
  const node = nodesByLogicalId.get(occurrence.logicalId);
  if (node === undefined) return;
  nodesByLogicalId.set(occurrence.logicalId, {
    ...node,
    occurrences: node.occurrences.some((candidate) => candidate.id === occurrence.id)
      ? node.occurrences.map((candidate) => candidate.id === occurrence.id ? occurrence : candidate)
      : [...node.occurrences, occurrence],
  });
}

function isOccurrenceStart(event) {
  return event.type === 'step_start' || event.type === 'workflow_call_start';
}

function isOccurrenceTerminal(event) {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

function iterationSourceKey(workflow, step, stack) {
  return JSON.stringify([workflow, step, stackPathKey(stack)]);
}

function indexIterationSource(graph, occurrence, step) {
  if (occurrence.iteration === undefined) return;
  if (occurrence.kind === 'step') {
    const sourceKey = iterationSourceKey(occurrence.workflow, step, occurrence.stack);
    const previousSource = graph.latestIterationBySource.get(sourceKey);
    if (previousSource === undefined || previousSource.firstEventIndex <= occurrence.firstEventIndex) {
      graph.latestIterationBySource.set(sourceKey, occurrence);
    }
  }
  const stackKey = stackPathKey(occurrence.stack);
  const previousStack = graph.latestIterationByStack.get(stackKey);
  if (previousStack === undefined || previousStack.firstEventIndex <= occurrence.firstEventIndex) {
    graph.latestIterationByStack.set(stackKey, occurrence);
  }
}

function inheritedParallelIteration(event, graph) {
  if (!Array.isArray(event.stack) || event.stack.length === 0) return undefined;
  const parallelIndexes = [...event.stack]
    .map((frame, index) => frame?.kind === 'parallel' ? index : -1)
    .filter((index) => index >= 0)
    .reverse();
  for (const frameIndex of parallelIndexes) {
    const prefixKey = stackPathKey(event.stack.slice(0, frameIndex + 1));
    const occurrence = graph.latestIterationByStack.get(prefixKey);
    if (occurrence?.iteration !== undefined) return occurrence.iteration;
  }
  return undefined;
}

function inheritEventIteration(event, meta, graph) {
  if (event.iteration !== undefined || !isWorkflowCall(event)) return event;
  const workflow = eventWorkflow(event, meta.workflow);
  const source = graph.latestIterationBySource.get(
    iterationSourceKey(workflow, event.step, event.stack),
  );
  if (source?.iteration !== undefined) {
    return { ...event, iteration: source.iteration };
  }
  const parallelIteration = inheritedParallelIteration(event, graph);
  if (parallelIteration !== undefined) return { ...event, iteration: parallelIteration };
  return event;
}

function addGraphEvent(event, index, meta, graph) {
  const effectiveEvent = inheritEventIteration(event, meta, graph);
  const initialDescriptor = eventDescriptor(effectiveEvent, meta);
  if (initialDescriptor === null) return;
  const existingId = initialDescriptor.occurrenceId
    ?? (!isOccurrenceStart(event) ? graph.activeOccurrenceIds.get(initialDescriptor.baseKey) : undefined);
  const previous = existingId === undefined ? undefined : graph.occurrencesById.get(existingId);
  let occurrenceId = existingId;
  if (occurrenceId === undefined || (isOccurrenceStart(event) && previous !== undefined)) {
    const nextOccurrence = (graph.occurrenceCounters.get(initialDescriptor.baseKey) ?? 0) + 1;
    graph.occurrenceCounters.set(initialDescriptor.baseKey, nextOccurrence);
    occurrenceId = `${initialDescriptor.baseKey}:occurrence:${nextOccurrence}`;
  }
  const descriptor = { ...initialDescriptor, occurrenceId };
  const occurrence = previous === undefined
    ? createOccurrence(effectiveEvent, descriptor, index, graph.recordEventIndexes, meta)
    : updateOccurrence(previous, effectiveEvent, index, graph.recordEventIndexes, meta);
  graph.occurrencesById.set(occurrence.id, occurrence);
  indexIterationSource(graph, occurrence, effectiveEvent.step);
  graph.occurrenceByEventIndex.set(index, occurrence);
  replaceOccurrence(graph.nodesByLogicalId, occurrence);
  if (graph.nodesByLogicalId.has(descriptor.logicalId) === false) {
    graph.nodesByLogicalId.set(descriptor.logicalId, {
      id: descriptor.logicalId,
      workflow: descriptor.workflow,
      kind: descriptor.kind,
      label: descriptor.kind === 'workflow'
        ? descriptor.childWorkflow ?? effectiveEvent.step
        : effectiveEvent.step,
      childWorkflow: descriptor.childWorkflow,
      firstEventIndex: index,
      occurrences: [occurrence],
    });
  }
  if (isOccurrenceTerminal(event)) graph.activeOccurrenceIds.delete(initialDescriptor.baseKey);
  else graph.activeOccurrenceIds.set(initialDescriptor.baseKey, occurrence.id);
  if (descriptor.kind === 'workflow' && descriptor.childWorkflow !== undefined) {
    const previousCall = graph.callsByOccurrenceId.get(occurrence.id);
    graph.callsByOccurrenceId.set(occurrence.id, {
      ...previousCall,
      id: previousCall?.id ?? `call:${encodeIdPart(occurrence.id)}`,
      occurrenceId: occurrence.id,
      workflow: descriptor.workflow,
      step: event.step,
      childWorkflow: descriptor.childWorkflow,
      callInstance: event.callInstance ?? previousCall?.callInstance,
      stack: previousCall?.stack ?? event.stack,
      startEventIndex: event.type === 'workflow_call_start'
        ? index
        : previousCall?.startEventIndex,
      completeEventIndex: event.type === 'workflow_call_complete'
        ? index
        : previousCall?.completeEventIndex,
      startObserved: event.type === 'workflow_call_start'
        || previousCall?.startObserved === true,
    });
  }
}

function nearestIndexedIteration(candidates, eventIndex) {
  if (candidates === undefined || candidates.length === 0) return undefined;
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candidates[middle].firstEventIndex < eventIndex) low = middle + 1;
    else high = middle;
  }
  const next = candidates[low];
  const previous = candidates[low - 1];
  if (next === undefined) return previous?.iteration;
  if (previous === undefined) return next.iteration;
  return eventIndex - previous.firstEventIndex <= next.firstEventIndex - eventIndex
    ? previous.iteration
    : next.iteration;
}

function inheritedIterationForCallOccurrence(occurrence, candidatesByStack) {
  const sameStack = nearestIndexedIteration(
    candidatesByStack.get(stackPathKey(occurrence.stack)),
    occurrence.firstEventIndex,
  );
  if (sameStack !== undefined) return sameStack;

  if (!Array.isArray(occurrence.stack)) return undefined;
  const parallelIndexes = [...occurrence.stack]
    .map((frame, index) => frame?.kind === 'parallel' ? index : -1)
    .filter((index) => index >= 0)
    .reverse();
  for (const frameIndex of parallelIndexes) {
    const prefixKey = stackPathKey(occurrence.stack.slice(0, frameIndex + 1));
    const iteration = nearestIndexedIteration(
      candidatesByStack.get(prefixKey),
      occurrence.firstEventIndex,
    );
    if (iteration !== undefined) return iteration;
  }
  return undefined;
}

function applyInheritedCallIterations(graph, meta) {
  const candidates = [...graph.occurrencesById.values()];
  const candidatesByStack = new Map();
  const eventIndexesByOccurrenceId = new Map();
  for (const candidate of candidates) {
    if (candidate.iteration === undefined) continue;
    const key = stackPathKey(candidate.stack);
    const indexed = candidatesByStack.get(key) ?? [];
    indexed.push(candidate);
    candidatesByStack.set(key, indexed);
  }
  for (const indexed of candidatesByStack.values()) {
    indexed.sort((left, right) => left.firstEventIndex - right.firstEventIndex);
  }
  for (const [eventIndex, occurrence] of graph.occurrenceByEventIndex) {
    const indexes = eventIndexesByOccurrenceId.get(occurrence.id) ?? [];
    indexes.push(eventIndex);
    eventIndexesByOccurrenceId.set(occurrence.id, indexes);
  }
  for (const occurrence of candidates) {
    if (occurrence.kind !== 'workflow' || occurrence.iteration !== undefined) continue;
    const iteration = inheritedIterationForCallOccurrence(occurrence, candidatesByStack);
    if (iteration === undefined) continue;
    const descriptors = parallelGroupDescriptors(occurrence.stack, iteration, meta);
    const descriptor = descriptors.at(-1);
    const membership = descriptor === undefined
      ? undefined
      : parallelMembership(occurrence, descriptor, new Set());
    const updated = descriptor === undefined || membership === undefined
      ? { ...occurrence, iteration }
      : {
          ...occurrence,
          iteration,
          parallelGroupKey: descriptor.key,
          parallelGroupFamilyKey: descriptor.familyKey,
          parallelGroupIteration: descriptor.iteration,
          parallelGroupLabel: descriptor.label,
          parallelGroupAmbiguous: undefined,
          parallelGroupDescriptors: descriptors,
        };
    graph.occurrencesById.set(occurrence.id, updated);
    replaceOccurrence(graph.nodesByLogicalId, updated);
    for (const eventIndex of eventIndexesByOccurrenceId.get(occurrence.id) ?? []) {
      graph.occurrenceByEventIndex.set(eventIndex, updated);
    }
  }
}

function laneDepths(lanes, calls) {
  const knownWorkflows = new Set(lanes.map((lane) => lane.workflow));
  const childWorkflows = new Set(calls
    .map((call) => call.childWorkflow)
    .filter((workflow) => knownWorkflows.has(workflow)));
  const depths = new Map(lanes.map((lane) => [lane.workflow, 0]));
  const queue = lanes
    .filter((lane) => !childWorkflows.has(lane.workflow))
    .map((lane) => lane.workflow);
  const children = new Map();
  for (const call of calls) {
    if (!knownWorkflows.has(call.workflow) || !knownWorkflows.has(call.childWorkflow)) continue;
    const current = children.get(call.workflow) ?? [];
    children.set(call.workflow, [...current, call.childWorkflow]);
  }
  const visited = new Set(queue);
  while (queue.length > 0) {
    const workflow = queue.shift();
    if (workflow === undefined) continue;
    const parentDepth = depths.get(workflow);
    if (parentDepth === undefined) continue;
    for (const child of children.get(workflow) ?? []) {
      if (visited.has(child)) continue;
      depths.set(child, parentDepth + 1);
      visited.add(child);
      queue.push(child);
    }
  }
  return depths;
}

function createCurrentOccurrence(meta, graph, nextEventIndex) {
  if (meta.currentStep === undefined) return;
  const event = {
    type: 'step_start',
    step: meta.currentStep,
    workflow: meta.workflow,
    iteration: meta.currentIteration,
  };
  const descriptor = eventDescriptor(event, meta);
  if (descriptor === null) return;
  const currentNode = graph.nodesByLogicalId.get(descriptor.logicalId);
  const latestObserved = [...graph.occurrenceByEventIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .at(-1)?.[1];
  if (currentNode?.occurrences.some((occurrence) => occurrence.status === 'running')
    || latestObserved?.logicalId === descriptor.logicalId) return;
  addGraphEvent(event, nextEventIndex, meta, graph);
}

function createGraph(events, meta, recordEventIndexes) {
  const graph = {
    nodesByLogicalId: new Map(),
    occurrencesById: new Map(),
    occurrenceByEventIndex: new Map(),
    callsByOccurrenceId: new Map(),
    occurrenceCounters: new Map(),
    activeOccurrenceIds: new Map(),
    latestIterationBySource: new Map(),
    latestIterationByStack: new Map(),
    recordEventIndexes,
  };
  events.forEach((event, index) => addGraphEvent(event, index, meta, graph));
  applyInheritedCallIterations(graph, meta);
  createCurrentOccurrence(meta, graph, events.length);
  return graph;
}

function annotateLiveEventIndexes(nodes, liveEvents, meta) {
  const indexesByOccurrenceId = new Map();
  const occurrencesByBaseKey = new Map();
  for (const node of nodes) {
    for (const occurrence of node.occurrences) {
      const baseKey = `${occurrence.logicalId}:scope:${stackPathKey(occurrence.stack)}`;
      const candidates = occurrencesByBaseKey.get(baseKey) ?? [];
      occurrencesByBaseKey.set(baseKey, [...candidates, occurrence]);
    }
  }
  const activeOccurrenceIds = new Map();
  const occurrenceCursor = new Map();
  liveEvents.forEach((event, index) => {
    const descriptor = eventDescriptor(event, meta);
    if (descriptor === null) return;
    let occurrenceId = descriptor.occurrenceId;
    if (occurrenceId === undefined) {
      const candidates = occurrencesByBaseKey.get(descriptor.baseKey) ?? [];
      if (isOccurrenceStart(event)) {
        const cursor = occurrenceCursor.get(descriptor.baseKey) ?? 0;
        const candidate = candidates[cursor];
        if (candidate !== undefined) {
          occurrenceId = candidate.id;
          occurrenceCursor.set(descriptor.baseKey, cursor + 1);
        }
      } else {
        occurrenceId = activeOccurrenceIds.get(descriptor.baseKey);
      }
    }
    if (occurrenceId === undefined) return;
    const indexes = indexesByOccurrenceId.get(occurrenceId) ?? [];
    indexesByOccurrenceId.set(occurrenceId, [...indexes, index]);
    if (isOccurrenceTerminal(event)) activeOccurrenceIds.delete(descriptor.baseKey);
    else activeOccurrenceIds.set(descriptor.baseKey, occurrenceId);
  });
  return nodes.map((node) => ({
    ...node,
    occurrences: node.occurrences.map((occurrence) => {
      const eventIndexes = indexesByOccurrenceId.get(occurrence.id) ?? [];
      const latestEvent = eventIndexes.length === 0
        ? undefined
        : liveEvents[eventIndexes[eventIndexes.length - 1]];
      const preview = latestEvent === undefined
        ? occurrence.preview
        : latestEvent.preview
          ?? latestEvent.error
          ?? latestEvent.reason
          ?? latestEvent.content?.slice(0, 2_000)
          ?? occurrence.preview;
      const updated = latestEvent === undefined
        ? occurrence
        : updateOccurrence(occurrence, latestEvent, eventIndexes.at(-1), true, meta);
      return {
        ...updated,
        eventIndexes,
        // `eventIndexes` belongs to the bounded live-log tail. Keep the
        // canonical graph position for ordering and terminal selection.
        lastEventIndex: occurrence.lastEventIndex,
        ...(preview === undefined ? {} : { preview }),
      };
    }),
  }));
}

function assignOccurrenceOrdinals(nodes) {
  const ordered = nodes
    .flatMap((node) => node.occurrences.map((occurrence) => ({ nodeId: node.id, occurrence })))
    .sort((left, right) => (
      left.occurrence.firstEventIndex - right.occurrence.firstEventIndex
      || left.occurrence.id.localeCompare(right.occurrence.id)
    ));
  const ordinals = new Map(ordered.map(({ occurrence }, index) => [occurrence.id, index + 1]));
  const presentationOrdinals = new Map();
  for (const node of nodes) {
    const orderedOccurrences = [...node.occurrences].sort((left, right) => (
      left.firstEventIndex - right.firstEventIndex
      || left.id.localeCompare(right.id)
    ));
    orderedOccurrences.forEach((occurrence, index) => {
      presentationOrdinals.set(occurrence.id, index + 1);
    });
  }
  return nodes.map((node) => ({
    ...node,
    occurrences: node.occurrences.map((occurrence) => ({
      ...occurrence,
      ordinal: ordinals.get(occurrence.id),
      presentationOrdinal: presentationOrdinals.get(occurrence.id),
    })),
  }));
}

function parallelMembership(occurrence, descriptor, ambiguousIds) {
  const stack = occurrence.stack;
  if (!Array.isArray(stack)) {
    return undefined;
  }
  const nearestParallelIndex = parallelFrameIndex(stack);
  if (nearestParallelIndex > descriptor.frameIndex
    && stack.length === descriptor.frameIndex + 2
    && stack[descriptor.frameIndex + 1]?.kind === 'parallel') {
    // A nested parallel boundary is one direct participant of its parent;
    // its own direct participants can share the same legacy [outer, inner]
    // stack and must remain in the inner group only.
    const metadata = validParallelMetadata(occurrence.parallel);
    if (metadata !== undefined) {
      return metadata.role === 'parent' ? 'participant' : undefined;
    }
    return occurrence.parallelRole === 'parent' ? 'participant' : undefined;
  }
  if (nearestParallelIndex !== descriptor.frameIndex) return undefined;
  const metadata = validParallelMetadata(occurrence.parallel);
  if (metadata !== undefined) {
    if (metadata.role === 'parent' && stack.length === descriptor.frameIndex + 1) {
      return 'parent';
    }
    if (metadata.role === 'direct_participant'
      && stack.length === descriptor.frameIndex + 1) {
      return 'participant';
    }
    if (metadata.role === 'workflow_call_participant'
      && stack.length === descriptor.frameIndex + 2
      && stack[descriptor.frameIndex + 1]?.kind === 'workflow_call') {
      return 'participant';
    }
    // Child events inherit the call participant identity, but remain internal
    // to the call branch and must not become a second fork/join branch.
    return undefined;
  }
  if (occurrence.parallelLegacyAmbiguous === true || ambiguousIds.has(occurrence.id)) {
    return 'ambiguous';
  }
  if (occurrence.parallelRole === 'parent'
    && stack.length === descriptor.frameIndex + 1) return 'parent';
  if (occurrence.parallelRole === 'direct_participant'
    && stack.length === descriptor.frameIndex + 1) return 'participant';
  if (occurrence.parallelRole === 'workflow_call_participant'
    && stack.length === descriptor.frameIndex + 2
    && stack[descriptor.frameIndex + 1]?.kind === 'workflow_call') return 'participant';
  if (occurrence.parallelRole === 'direct_participant'
    && stack.length === descriptor.frameIndex + 2
    && (stack[descriptor.frameIndex + 1]?.kind === 'agent'
      || stack[descriptor.frameIndex + 1]?.kind === 'system')) return 'participant';
  return undefined;
}

function assignParallelGroupOrdinals(nodes, meta) {
  const groupsByFamily = new Map();
  const legacyCandidatesByGroup = new Map();
  for (const node of nodes) {
    for (const occurrence of node.occurrences) {
      if (validParallelMetadata(occurrence.parallel) !== undefined
        || occurrence.parallelLegacyAmbiguous === true
        || occurrence.parallelRole !== 'parent') continue;
      const descriptors = occurrence.parallelGroupDescriptors
        ?? parallelGroupDescriptors(occurrence.stack, occurrence.iteration, meta);
      for (const descriptor of descriptors) {
        const stack = occurrence.stack;
        if (!Array.isArray(stack)
          || parallelFrameIndex(stack) !== descriptor.frameIndex
          || stack.length !== descriptor.frameIndex + 1
          || node.label !== descriptor.label) continue;
        const candidates = legacyCandidatesByGroup.get(descriptor.key) ?? new Set();
        candidates.add(occurrence.id);
        legacyCandidatesByGroup.set(descriptor.key, candidates);
      }
    }
  }
  const legacyAmbiguousIds = new Set(
    [...legacyCandidatesByGroup.values()]
      .filter((candidates) => candidates.size > 1)
      .flatMap((candidates) => [...candidates]),
  );
  for (const node of nodes) {
    for (const occurrence of node.occurrences) {
      const descriptors = occurrence.parallelGroupDescriptors
        ?? parallelGroupDescriptors(occurrence.stack, occurrence.iteration, meta);
      for (const descriptor of descriptors) {
        const family = groupsByFamily.get(descriptor.familyKey) ?? new Map();
        const previous = family.get(descriptor.key);
        const membership = parallelMembership(
          occurrence,
          descriptor,
          legacyAmbiguousIds,
        );
        const isParent = membership === 'parent';
        const isDirectParticipant = membership === 'participant';
        if (!isParent && !isDirectParticipant) continue;
        const parentOccurrenceIds = isParent
          ? [...new Set([...(previous?.parentOccurrenceIds ?? []), occurrence.id])]
          : previous?.parentOccurrenceIds ?? [];
        const participantOccurrenceIds = isDirectParticipant
          ? [...new Set([...(previous?.participantOccurrenceIds ?? []), occurrence.id])]
          : previous?.participantOccurrenceIds ?? [];
        family.set(descriptor.key, {
          key: descriptor.key,
          familyKey: descriptor.familyKey,
          label: descriptor.label,
          iteration: descriptor.iteration,
          firstEventIndex: Math.min(previous?.firstEventIndex ?? occurrence.firstEventIndex, occurrence.firstEventIndex),
          nodeIds: [...new Set([...(previous?.nodeIds ?? []), node.id])],
          occurrenceIds: [...new Set([...(previous?.occurrenceIds ?? []), occurrence.id])],
          parentOccurrenceIds,
          participantOccurrenceIds,
        });
        groupsByFamily.set(descriptor.familyKey, family);
      }
    }
  }
  const ordinalByKey = new Map();
  const groups = [];
  const occurrencesById = new Map(
    nodes.flatMap((node) => node.occurrences.map((occurrence) => [occurrence.id, { node, occurrence }])),
  );
  for (const family of groupsByFamily.values()) {
    const ordered = [...family.values()].sort((left, right) => (
      left.firstEventIndex - right.firstEventIndex || left.key.localeCompare(right.key)
    ));
    ordered.forEach((group, index) => {
      ordinalByKey.set(group.key, index + 1);
      const selectedParticipants = new Map();
      for (const occurrenceId of group.participantOccurrenceIds ?? []) {
        const candidate = occurrencesById.get(occurrenceId);
        if (candidate === undefined) continue;
        const participantKey = parallelParticipantDeduplicationKey(candidate);
        const previousId = selectedParticipants.get(participantKey);
        const previous = previousId === undefined ? undefined : occurrencesById.get(previousId);
        // A workflow_call emits both its step lifecycle and its dedicated
        // call lifecycle at the same participation identity. Keep one
        // participant, preferring the call occurrence because it carries the
        // workflow boundary metadata. Distinct canonical participation IDs
        // and legacy participant step identities must remain separate even
        // when they share the same [parallel] stack.
        if (previous === undefined
          || (candidate.node.kind === 'workflow' && previous.node.kind !== 'workflow')) {
          selectedParticipants.set(participantKey, occurrenceId);
        }
      }
      const participantOccurrenceIds = [...selectedParticipants.values()];
      const parentOccurrenceIds = [...new Set(group.parentOccurrenceIds ?? [])];
      const occurrenceIds = [...new Set([...parentOccurrenceIds, ...participantOccurrenceIds])];
      const selectedIds = new Set(occurrenceIds);
      const nodeIds = [...new Set(nodes
        .filter((node) => node.occurrences.some((occurrence) => selectedIds.has(occurrence.id)))
        .map((node) => node.id))];
      groups.push({
        ...group,
        nodeIds,
        occurrenceIds,
        parentOccurrenceIds,
        participantOccurrenceIds,
        ordinal: index + 1,
      });
    });
  }
  return {
    nodes: nodes.map((node) => ({
      ...node,
      occurrences: node.occurrences.map((occurrence) => (
        legacyAmbiguousIds.has(occurrence.id) || occurrence.parallelLegacyAmbiguous === true
          ? {
              ...occurrence,
              parallelGroupKey: undefined,
              parallelGroupFamilyKey: undefined,
              parallelGroupIteration: undefined,
              parallelGroupOrdinal: undefined,
              parallelGroupAmbiguous: true,
              parallelLegacyAmbiguous: true,
              parallelGroupDescriptors: [],
            }
          : occurrence.parallelGroupKey === undefined
          ? occurrence
          : {
              ...occurrence,
              parallelGroupOrdinal: ordinalByKey.get(occurrence.parallelGroupKey),
            }
      )),
    })),
    groups,
  };
}

function parallelParticipantDeduplicationKey(candidate) {
  const metadata = validParallelMetadata(candidate.occurrence.parallel);
  if (metadata !== undefined) {
    return JSON.stringify([
      'canonical',
      metadata.role,
      metadata.participationId,
    ]);
  }
  const stack = stackPathKey(candidate.occurrence.stack);
  if (candidate.occurrence.parallelRole === 'workflow_call_participant') {
    // Legacy step and workflow_call lifecycle records share this stack.
    return JSON.stringify(['legacy-call', stack]);
  }
  // Legacy direct participants have no participant frame in the [parallel]
  // shape; the logical node identity retains the observed step label.
  return JSON.stringify(['legacy-step', candidate.node.id, stack]);
}

function applyTerminalRunStatus(meta, nodes) {
  const finalStatus = meta.status === 'completed' || meta.status === 'failed' || meta.status === 'aborted'
    ? meta.status
    : null;
  if (finalStatus === null) return nodes;
  const finalOccurrence = nodes
    .flatMap((node) => node.occurrences)
    .reduce((latest, occurrence) => (
      latest === undefined || occurrence.lastEventIndex > latest.lastEventIndex
        ? occurrence
        : latest
    ), undefined);
  if (finalOccurrence === undefined || finalOccurrence.status !== 'running') return nodes;
  return nodes.map((node) => ({
    ...node,
    occurrences: node.occurrences.map((occurrence) => (
      occurrence.id === finalOccurrence.id
        ? { ...occurrence, status: finalStatus }
        : occurrence
    )),
  }));
}

function isParallelParentOccurrence(node, occurrence) {
  if (occurrence.parallel?.role === 'parent') {
    const parentIndex = parallelFrameIndex(occurrence.stack ?? []);
    return parentIndex >= 0 && occurrence.stack?.length === parentIndex + 1;
  }
  const frame = occurrence.stack?.at(-1);
  return occurrence.parallel === undefined
    && frame?.kind === 'parallel'
    && node.label === frame.step
    && occurrence.parallelLegacyAmbiguous !== true;
}

function projectParallelChildStatuses(nodes) {
  const parentStatuses = new Map();
  for (const node of nodes) {
    for (const occurrence of node.occurrences) {
      if (occurrence.parallelGroupKey === undefined
        || occurrence.parallelGroupAmbiguous === true
        || !isParallelParentOccurrence(node, occurrence)
        || occurrence.terminalStatus === undefined) continue;
      const statuses = parentStatuses.get(occurrence.parallelGroupKey) ?? new Set();
      statuses.add(occurrence.terminalStatus);
      parentStatuses.set(occurrence.parallelGroupKey, statuses);
    }
  }
  return nodes.map((node) => ({
    ...node,
    occurrences: node.occurrences.map((occurrence) => {
      if (occurrence.parallelGroupKey === undefined
        || occurrence.parallelGroupAmbiguous === true
        || isParallelParentOccurrence(node, occurrence)) return occurrence;
      if (occurrence.terminalStatus !== undefined) {
        return occurrence.status === occurrence.terminalStatus
          ? occurrence
          : { ...occurrence, status: occurrence.terminalStatus };
      }
      const statuses = parentStatuses.get(occurrence.parallelGroupKey);
      // A parent terminal is evidence that the child scope ended. Without a
      // child terminal record, retain the uncertainty instead of displaying
      // RUNNING for a finished parallel invocation.
      if (statuses === undefined || statuses.size !== 1) return occurrence;
      return { ...occurrence, status: 'unknown' };
    }),
  }));
}

function buildTransitions(events, occurrenceByEventIndex) {
  const transitions = [];
  let previous = null;
  const visitedLogicalIds = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const current = occurrenceByEventIndex.get(index);
    if (current === undefined || current.kind !== 'step' || current.id === previous?.id) continue;
    // A repeated occurrence of the same logical step is represented by the
    // chips on that card. It is not a transition by itself. Every connector
    // below therefore joins only consecutive, distinct step occurrences.
    if (previous !== null && previous.logicalId !== current.logicalId) {
      transitions.push({
        id: `${previous.id}->${current.id}`,
        source: previous.id,
        target: current.id,
        sourceLogicalId: previous.logicalId,
        targetLogicalId: current.logicalId,
        kind: visitedLogicalIds.has(current.logicalId) ? 'loop' : 'transition',
      });
    }
    visitedLogicalIds.add(current.logicalId);
    previous = current;
  }
  return transitions;
}

function buildLoops(transitions, nodes) {
  const occurrencesById = new Map(nodes.flatMap((node) => node.occurrences.map((occurrence) => [occurrence.id, occurrence])));
  const seen = new Set();
  return transitions
    .filter((transition) => transition.kind === 'loop')
    .filter((transition) => {
      const key = `${transition.source}->${transition.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((transition, index) => ({
      id: `loop:${encodeIdPart(transition.id)}:${index}`,
      logicalId: transition.sourceLogicalId,
      from: transition.source,
      to: transition.target,
      ordinal: occurrencesById.get(transition.target)?.ordinal,
    }));
}

function buildLanes(nodes, calls, locale) {
  const laneMap = new Map();
  for (const node of nodes) {
    const lane = laneMap.get(node.workflow);
    if (lane === undefined) {
      laneMap.set(node.workflow, {
        id: `lane:${encodeIdPart(node.workflow)}`,
        workflow: node.workflow,
        displayWorkflow: workflowDisplayName(node.workflow, locale, node.occurrences[0]?.stack),
        steps: [node],
      });
    } else {
      laneMap.set(node.workflow, { ...lane, steps: [...lane.steps, node] });
    }
  }
  const lanes = [...laneMap.values()];
  const depths = laneDepths(lanes, calls);
  return lanes.map((lane) => ({ ...lane, depth: depths.get(lane.workflow) ?? 0 }));
}

function sameStackFrame(left, right) {
  return left.workflow === right.workflow
    && left.workflow_ref === right.workflow_ref
    && left.step === right.step
    && left.kind === right.kind
    && left.occurrence === right.occurrence;
}

function isStackPrefix(parent, child) {
  if (!Array.isArray(parent) || !Array.isArray(child) || parent.length === 0) return false;
  if (child.length < parent.length) return false;
  return parent.every((frame, index) => sameStackFrame(frame, child[index]));
}

function callStackMatches(callStack, occurrenceStack) {
  if (!Array.isArray(callStack)) return occurrenceStack === undefined;
  return isStackPrefix(callStack, occurrenceStack);
}

function findCallTarget(call, occurrences) {
  if (call.startObserved !== true) return undefined;
  const callOccurrence = occurrences.find((occurrence) => occurrence.id === call.occurrenceId);
  if (callOccurrence === undefined) return undefined;
  const candidates = occurrences
    .filter((occurrence) => occurrence.workflow === call.childWorkflow)
    .filter((occurrence) => occurrence.firstEventIndex > callOccurrence.firstEventIndex)
    .filter((occurrence) => callStackMatches(call.stack, occurrence.stack))
    .sort((left, right) => left.firstEventIndex - right.firstEventIndex);
  if (candidates.length === 0) return undefined;
  if (call.stack === undefined && candidates.length > 1) return undefined;
  return candidates[0].id;
}

function attachCallTargets(calls, nodes) {
  const occurrences = nodes.flatMap((node) => node.occurrences);
  return calls.map((call) => {
    const targetOccurrenceId = findCallTarget(call, occurrences);
    return {
      ...call,
      ...(targetOccurrenceId === undefined ? {} : { targetOccurrenceId }),
      targetObserved: targetOccurrenceId !== undefined,
    };
  });
}

function collectCallObservations(newestFirstEvents, newestFirstHistory, meta) {
  const source = newestFirstHistory === undefined || newestFirstHistory.length === 0
    ? newestFirstEvents
    : newestFirstHistory;
  const observations = new Map();
  for (const event of [...source].reverse()) {
    if (!isWorkflowCall(event)) continue;
    const descriptor = eventDescriptor(event, meta);
    if (descriptor?.occurrenceId === undefined) continue;
    const previous = observations.get(descriptor.occurrenceId);
    observations.set(descriptor.occurrenceId, {
      startObserved: event.type === 'workflow_call_start' || previous?.startObserved === true,
      stack: previous?.stack ?? event.stack,
    });
  }
  return observations;
}

function mergeGraphEvents(summaryEvents, history, liveEvents, meta) {
  // Without a graph summary, preserve the raw event sequence so live event
  // indexes and observed transitions retain their one-record granularity.
  if (summaryEvents.length === 0) return history.length > 0 ? history : liveEvents;

  // The cache has already merged every lifecycle record into one canonical
  // snapshot per chronological occurrence. Replaying history/live records
  // here would make repeated steps indistinguishable when their iteration
  // metadata is missing or duplicated, so the summary is the topology SSOT.
  return summaryEvents;
}

export function buildExecutionTrace(meta, newestFirstEvents, newestFirstHistory, graphSummary, locale = 'ja') {
  const events = [...newestFirstEvents].reverse();
  const history = newestFirstHistory === undefined ? [] : [...newestFirstHistory].reverse();
  const summaryEvents = graphSummary?.occurrences === undefined
    ? []
    : [...graphSummary.occurrences].reverse();
  const graphEvents = mergeGraphEvents(summaryEvents, history, events, meta);
  const graph = createGraph(graphEvents, meta, summaryEvents.length === 0 && history.length === 0);
  let nodes = [...graph.nodesByLogicalId.values()]
    .map((node) => ({
      ...node,
      occurrences: [...node.occurrences].sort((left, right) => left.firstEventIndex - right.firstEventIndex),
    }))
    .sort((left, right) => left.firstEventIndex - right.firstEventIndex);
  if (summaryEvents.length > 0 || history.length > 0) {
    nodes = annotateLiveEventIndexes(nodes, events, meta);
  }
  nodes = applyTerminalRunStatus(meta, nodes);
  nodes = projectParallelChildStatuses(nodes);
  nodes = assignOccurrenceOrdinals(nodes);
  const parallelGroupResult = assignParallelGroupOrdinals(nodes, meta);
  nodes = parallelGroupResult.nodes;
  const callObservations = collectCallObservations(newestFirstEvents, newestFirstHistory, meta);
  const calls = attachCallTargets([...graph.callsByOccurrenceId.values()].map((call) => {
    const observation = callObservations.get(call.occurrenceId);
    return {
      ...call,
      stack: call.stack ?? observation?.stack,
      startObserved: call.startObserved === true || observation?.startObserved === true,
    };
  }), nodes);
  locale = locale === 'en' ? 'en' : 'ja';
  nodes = nodes.map((node) => ({
    ...node,
    displayWorkflow: workflowDisplayName(
      node.workflow,
      locale,
      node.occurrences.at(-1)?.stack ?? node.occurrences[0]?.stack,
    ),
    displayLabel: workflowDisplayName(
      node.label,
      locale,
      node.occurrences.at(-1)?.stack ?? node.occurrences[0]?.stack,
    ),
  }));
  const localizedCalls = calls.map((call) => ({
    ...call,
    displayWorkflow: workflowDisplayName(call.workflow, locale, call.stack),
    displayChildWorkflow: workflowDisplayName(call.childWorkflow, locale, call.stack),
  }));
  const lanes = buildLanes(nodes, localizedCalls, locale)
    .sort((left, right) => left.depth - right.depth || left.steps[0].firstEventIndex - right.steps[0].firstEventIndex);
  const transitions = buildTransitions(graphEvents, graph.occurrenceByEventIndex);
  const loops = buildLoops(transitions, nodes);
  return {
    events,
    lanes,
    nodes,
    transitions,
    loops,
    parallelGroups: parallelGroupResult.groups,
    calls: localizedCalls,
    totalOccurrences: nodes.reduce((total, node) => total + node.occurrences.length, 0),
    graphOccurrenceCount: graphSummary?.totalOccurrences ?? nodes.reduce(
      (total, node) => total + node.occurrences.length,
      0,
    ),
    graphTruncated: graphSummary?.truncated === true,
  };
}

export function reportDisplayName(filename) {
  const parts = filename.split('/');
  return parts[parts.length - 1];
}

export function reportDirectory(filename) {
  const parts = filename.split('/');
  return parts.length === 1 ? '' : parts.slice(0, -1).join('/');
}
