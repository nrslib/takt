const TERMINAL_EVENT_TYPES = new Set(['step_complete', 'workflow_call_complete']);

function eventWorkflow(event, fallback) {
  return event.workflow === undefined ? fallback : event.workflow;
}

function eventIteration(event) {
  return event.iteration === undefined ? 0 : event.iteration;
}

function stepNodeId(event, workflow) {
  return `step:${workflow}:${event.step}:${eventIteration(event)}`;
}

function callNodeId(event, workflow) {
  const occurrence = event.callInstance === undefined ? eventIteration(event) : event.callInstance;
  return `call:${workflow}:${event.step}:${occurrence}`;
}

function eventNodeId(event, fallbackWorkflow) {
  if (event.step === undefined) return null;
  const workflow = eventWorkflow(event, fallbackWorkflow);
  return event.type.startsWith('workflow_call_')
    ? callNodeId(event, workflow)
    : stepNodeId(event, workflow);
}

function nodeStatus(event) {
  if (!TERMINAL_EVENT_TYPES.has(event.type)) return 'running';
  if (event.status === 'failed' || event.status === 'error') return 'failed';
  if (event.status === 'aborted') return 'aborted';
  return 'completed';
}

function createNode(event, id, workflow) {
  const isCall = event.type.startsWith('workflow_call_');
  return {
    id,
    kind: isCall ? 'workflow' : 'step',
    label: isCall && event.childWorkflow !== undefined ? event.childWorkflow : event.step,
    eyebrow: isCall ? 'Nested workflow' : workflow,
    status: nodeStatus(event),
    iteration: event.iteration,
    persona: event.persona,
    phases: event.phaseName === undefined ? [] : [event.phaseName],
    eventIndexes: [],
  };
}

export function buildExecutionTrace(meta, newestFirstEvents) {
  const events = [...newestFirstEvents].reverse();
  const nodesById = new Map();
  const orderedIds = [];
  events.forEach((event, index) => {
    const id = eventNodeId(event, meta.workflow);
    if (id === null) return;
    const workflow = eventWorkflow(event, meta.workflow);
    const existing = nodesById.get(id);
    const node = existing === undefined ? createNode(event, id, workflow) : existing;
    if (existing === undefined) {
      nodesById.set(id, node);
      orderedIds.push(id);
    }
    const phases = event.phaseName !== undefined && !node.phases.includes(event.phaseName)
      ? [...node.phases, event.phaseName]
      : node.phases;
    nodesById.set(id, {
      ...node,
      status: nodeStatus(event),
      eventIndexes: [...node.eventIndexes, index],
      phases,
      ...(event.persona === undefined ? {} : { persona: event.persona }),
    });
  });

  if (meta.currentStep !== undefined) {
    const currentEvent = {
      type: 'step_start',
      step: meta.currentStep,
      workflow: meta.workflow,
      iteration: meta.currentIteration,
    };
    const id = eventNodeId(currentEvent, meta.workflow);
    if (id !== null && !nodesById.has(id)) {
      nodesById.set(id, createNode(currentEvent, id, meta.workflow));
      orderedIds.push(id);
    }
  }

  const terminalStatus = meta.status === 'completed'
    || meta.status === 'failed'
    || meta.status === 'aborted';
  const nodes = orderedIds.map((id, index) => {
    const node = nodesById.get(id);
    return terminalStatus && index === orderedIds.length - 1 && node.status === 'running'
      ? { ...node, status: meta.status }
      : node;
  });
  const edges = nodes.slice(1).map((node, index) => ({
    id: `${nodes[index].id}->${node.id}`,
    source: nodes[index].id,
    target: node.id,
  }));
  return { events, nodes, edges };
}

export function reportDisplayName(filename) {
  const parts = filename.split('/');
  return parts[parts.length - 1];
}

export function reportDirectory(filename) {
  const parts = filename.split('/');
  return parts.length === 1 ? '' : parts.slice(0, -1).join('/');
}
