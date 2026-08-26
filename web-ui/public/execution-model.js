const TERMINAL_EVENT_TYPES = new Set(['step_complete', 'workflow_call_complete']);
const EVENT_STATUS_MAP = new Map([
  ['done', 'completed'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['blocked', 'failed'],
  ['error', 'failed'],
  ['rate_limited', 'failed'],
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

function statusFromEvent(event) {
  const mapped = typeof event.status === 'string' ? EVENT_STATUS_MAP.get(event.status) : undefined;
  if (mapped === 'completed' && !TERMINAL_EVENT_TYPES.has(event.type)) return 'running';
  if (mapped !== undefined) return mapped;
  if (event.status !== undefined) return 'running';
  return TERMINAL_EVENT_TYPES.has(event.type) ? 'completed' : 'running';
}

function logicalStepId(workflow, step, kind, childWorkflow) {
  const target = kind === 'workflow' ? childWorkflow ?? step : step;
  return `step:${encodeIdPart(workflow)}:${kind}:${encodeIdPart(target)}`;
}

function eventDescriptor(event, meta) {
  if (event.step === undefined) return null;
  const workflow = eventWorkflow(event, meta.workflow);
  const kind = isWorkflowCall(event) ? 'workflow' : 'step';
  const childWorkflow = kind === 'workflow' ? event.childWorkflow : undefined;
  const logicalId = logicalStepId(workflow, event.step, kind, childWorkflow);
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

function createOccurrence(event, descriptor, firstEventIndex, recordEventIndexes) {
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
  };
}

function mergeStatus(previous, next) {
  if (next === 'failed' || next === 'aborted') return next;
  if (previous === 'failed' || previous === 'aborted') return previous;
  if (next === 'completed') return next;
  return previous;
}

function updateOccurrence(occurrence, event, eventIndex, recordEventIndexes) {
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
    ...(preview === undefined ? {} : {
      preview,
      previewTruncated: event.previewTruncated === true || event.content?.length > 2_000,
    }),
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

function addGraphEvent(event, index, meta, graph) {
  const initialDescriptor = eventDescriptor(event, meta);
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
    ? createOccurrence(event, descriptor, index, graph.recordEventIndexes)
    : updateOccurrence(previous, event, index, graph.recordEventIndexes);
  graph.occurrencesById.set(occurrence.id, occurrence);
  graph.occurrenceByEventIndex.set(index, occurrence);
  replaceOccurrence(graph.nodesByLogicalId, occurrence);
  if (graph.nodesByLogicalId.has(descriptor.logicalId) === false) {
    graph.nodesByLogicalId.set(descriptor.logicalId, {
      id: descriptor.logicalId,
      workflow: descriptor.workflow,
      kind: descriptor.kind,
      label: descriptor.kind === 'workflow'
        ? descriptor.childWorkflow ?? event.step
        : event.step,
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
    recordEventIndexes,
  };
  events.forEach((event, index) => addGraphEvent(event, index, meta, graph));
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
        : updateOccurrence(occurrence, latestEvent, eventIndexes.at(-1), true);
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
  return nodes.map((node) => ({
    ...node,
    occurrences: node.occurrences.map((occurrence) => ({
      ...occurrence,
      ordinal: ordinals.get(occurrence.id),
    })),
  }));
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
  nodes = assignOccurrenceOrdinals(nodes);
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
