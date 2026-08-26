import { t } from './i18n.js';

const executionMapDisposers = new WeakMap();
const PAN_THRESHOLD = 4;
const NODE_MARGIN = 16;
const PARALLEL_GROUP_PADDING = 14;
export const MIN_MAP_SCALE = 0.6;
export const MAX_MAP_SCALE = 2;
export const DEFAULT_MAP_SCALE = 1;
const MAP_SCALE_WHEEL_FACTOR = 0.002;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(status) {
  const localized = t(`map.status.${status}`);
  return localized === `map.status.${status}` ? t(`app.status.${status}`) : localized;
}

function statusBadge(status) {
  return element('span', `status-badge status-${status}`, statusLabel(status));
}

export function clampMapScale(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAP_SCALE;
  return Math.min(MAX_MAP_SCALE, Math.max(MIN_MAP_SCALE, value));
}

function nextMapScale(current, deltaY) {
  return clampMapScale(current * Math.exp(-deltaY * MAP_SCALE_WHEEL_FACTOR));
}

function nodeLabel(node) {
  return node.displayLabel ?? node.label;
}

function workflowLabel(value, nodeOrCall) {
  return nodeOrCall?.displayWorkflow ?? value;
}

function occurrenceLabel(occurrence, index) {
  const callFrame = Array.isArray(occurrence.stack)
    ? [...occurrence.stack].reverse().find((frame) => frame.kind === 'workflow_call')
    : undefined;
  const callValue = occurrence.callInstance ?? callFrame?.occurrence;
  const callLabel = callValue === undefined ? '' : ` · ${t('map.call', { value: callValue })}`;
  return `${t('map.pass', { number: occurrence.ordinal ?? index + 1 })}${callLabel}`;
}

function occurrenceDescription(occurrence, index) {
  return [
    occurrenceLabel(occurrence, index),
    occurrence.phases.join(' / '),
    occurrence.personas.join(' / '),
  ].filter(Boolean).join(' · ');
}

function renderIterationChip(node, occurrence, index, selectedOccurrenceId, onSelectOccurrence) {
  const button = element('button', 'iteration-chip');
  button.type = 'button';
  button.dataset.occurrenceId = occurrence.id;
  button.dataset.selected = String(occurrence.id === selectedOccurrenceId);
  button.setAttribute('aria-pressed', String(occurrence.id === selectedOccurrenceId));
  const label = `${nodeLabel(node)} ${occurrenceDescription(occurrence, index)}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(
    element('span', 'iteration-chip-label', occurrenceLabel(occurrence, index)),
    element('span', 'iteration-chip-status', statusLabel(occurrence.status)),
  );
  button.addEventListener('click', () => onSelectOccurrence(node, occurrence));
  return button;
}

function renderStep(node, position, selectedOccurrenceId, onSelectOccurrence, hasIteration) {
  const latest = node.occurrences.at(-1);
  if (latest === undefined) return null;
  const step = element('article', `execution-step execution-step-${latest.status}`);
  step.dataset.stepId = node.id;
  step.dataset.kind = 'step';
  step.dataset.repeated = String(node.occurrences.length > 1);
  step.dataset.active = String(node.occurrences.some(
    (occurrence) => occurrence.id === selectedOccurrenceId,
  ));
  step.dataset.layoutX = String(position.x);
  step.dataset.layoutY = String(position.y);
  step.style.setProperty('left', `${position.x}px`);
  step.style.setProperty('top', `${position.y}px`);
  const fullIdentity = node.workflow === nodeLabel(node) ? '' : node.workflow;
  if (fullIdentity !== '') step.title = fullIdentity;
  const headerButton = element('button', 'execution-step-header');
  headerButton.type = 'button';
  headerButton.dataset.stepId = node.id;
  headerButton.setAttribute('aria-label', t('map.showStep', { step: nodeLabel(node) }));
  const firstOrdinal = node.occurrences[0]?.ordinal ?? node.firstEventIndex + 1;
  headerButton.append(
    element('span', 'execution-step-index', String(firstOrdinal).padStart(2, '0')),
    element('span', 'execution-step-title', nodeLabel(node)),
  );
  if (latest.status === 'running') {
    const currentMarker = element('span', 'execution-current-marker', '●');
    currentMarker.setAttribute('aria-hidden', 'true');
    currentMarker.title = t('map.currentStep');
    headerButton.append(currentMarker);
    step.dataset.current = 'true';
  } else {
    step.dataset.current = 'false';
  }
  headerButton.append(statusBadge(latest.status));
  headerButton.addEventListener('click', () => onSelectOccurrence(node, latest));
  const iterations = element('div', 'execution-iterations');
  const iterationHeader = element('div', 'execution-iterations-header');
  const repeated = node.occurrences.length > 1;
  iterationHeader.append(
    element('span', '', hasIteration ? t('map.loopPasses') : t('map.passSingle')),
    hasIteration
      ? element('span', 'loop-badge', `↻ ${node.occurrences.length}`)
      : element('span', 'loop-badge loop-badge-muted', repeated ? `× ${node.occurrences.length}` : '1'),
  );
  const chips = element('div', 'iteration-chips');
  node.occurrences.forEach((occurrence, index) => {
    chips.append(renderIterationChip(node, occurrence, index, selectedOccurrenceId, onSelectOccurrence));
  });
  iterations.append(iterationHeader, chips);
  const metadata = [
    workflowLabel(node.workflow, node),
    latest.phases.join(' / '),
    latest.personas.join(' / '),
  ].filter(Boolean);
  step.append(headerButton, iterations, element('p', 'execution-step-meta', metadata.join(' · ')));
  return { step, headerButton };
}

function parallelFrame(node) {
  const frames = node.occurrences.flatMap((occurrence) => occurrence.stack ?? []);
  return [...frames].reverse().find((frame) => frame.kind === 'parallel');
}

function parallelGroupId(frame) {
  return frame === undefined
    ? null
    : JSON.stringify([frame.workflow_ref, frame.step, frame.occurrence]);
}

function parallelGroups(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const frame = parallelFrame(node);
    const id = parallelGroupId(frame);
    if (id === null || frame === undefined) continue;
    const previous = groups.get(id);
    groups.set(id, previous === undefined
      ? { id, label: frame.step, nodeIds: [node.id] }
      : { ...previous, nodeIds: [...previous.nodeIds, node.id] });
  }
  return [...groups.values()].filter((group) => group.nodeIds.length > 1);
}

function findOccurrence(trace, occurrenceId) {
  for (const node of trace.nodes) {
    const occurrence = node.occurrences.find((candidate) => candidate.id === occurrenceId);
    if (occurrence !== undefined) return { node, occurrence };
  }
  return null;
}

function stepNodes(trace) {
  return trace.nodes.filter((node) => node.kind === 'step' && node.occurrences.length > 0);
}

function sameStackFrame(left, right) {
  return left?.workflow === right?.workflow
    && left?.workflow_ref === right?.workflow_ref
    && left?.step === right?.step
    && left?.kind === right?.kind
    && left?.occurrence === right?.occurrence;
}

function isStackPrefix(parent, child) {
  if (!Array.isArray(parent) || !Array.isArray(child) || parent.length === 0) return false;
  if (child.length < parent.length) return false;
  return parent.every((frame, index) => sameStackFrame(frame, child[index]));
}

function parentContextMatches(candidateStack, callStack) {
  if (callStack === undefined) return candidateStack === undefined;
  const lastCallFrame = callStack.at(-1);
  const parentStack = lastCallFrame?.kind === 'workflow_call'
    ? callStack.slice(0, -1)
    : callStack;
  if (candidateStack === undefined) return parentStack.length === 0;
  const candidateParent = candidateStack.at(-1)?.kind === 'agent'
    ? candidateStack.slice(0, -1)
    : candidateStack;
  return parentStack.length === candidateParent.length
    && parentStack.every((frame, index) => sameStackFrame(frame, candidateParent[index]));
}

function layoutSteps(trace, customNodePositions) {
  const nodes = stepNodes(trace).slice().sort((left, right) => (
    left.firstEventIndex - right.firstEventIndex || left.id.localeCompare(right.id)
  ));
  const positions = new Map();
  const depthByLogicalId = new Map();
  const nodeByLogicalId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) depthByLogicalId.set(node.id, 0);
  const orderedTransitions = trace.transitions
    .filter((candidate) => candidate.kind === 'transition')
    .filter((candidate) => {
      const source = nodeByLogicalId.get(candidate.sourceLogicalId);
      const target = nodeByLogicalId.get(candidate.targetLogicalId);
      return source !== undefined
        && target !== undefined
        && target.firstEventIndex > source.firstEventIndex;
    })
    .sort((left, right) => left.source.localeCompare(right.source));
  // A bounded relaxation keeps the layout deterministic even when the
  // observed execution contains a branch that is not topologically sorted.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const transition of orderedTransitions) {
      const source = nodeByLogicalId.get(transition.sourceLogicalId);
      const target = nodeByLogicalId.get(transition.targetLogicalId);
      if (source === undefined || target === undefined || source.id === target.id) continue;
      const depth = (depthByLogicalId.get(source.id) ?? 0) + 1;
      if (depth <= (depthByLogicalId.get(target.id) ?? 0)) continue;
      depthByLogicalId.set(target.id, depth);
      changed = true;
    }
    if (!changed) break;
  }
  const columns = new Map();
  let maxX = 0;
  let maxY = 0;
  nodes.forEach((node, index) => {
    const depth = depthByLogicalId.get(node.id) ?? 0;
    const column = columns.get(depth) ?? [];
    const nesting = Math.max(...node.occurrences.map((occurrence) => occurrence.stack?.length ?? 0), 0);
    const baseY = 28 + nesting * 144 + (index % 3) * 34;
    let y = baseY;
    while (column.some((position) => Math.abs(position - y) < 154)) y += 154;
    column.push(y);
    columns.set(depth, column);
    const x = 28 + depth * 270;
    positions.set(node.id, customNodePositions.get(node.id) ?? { x, y });
    maxX = Math.max(maxX, x + 220);
    maxY = Math.max(maxY, y + 136);
  });
  for (const group of parallelGroups(nodes)) {
    const groupedNodes = group.nodeIds
      .map((nodeId) => nodeByLogicalId.get(nodeId))
      .filter(Boolean)
      .sort((left, right) => left.firstEventIndex - right.firstEventIndex);
    const groupedPositions = groupedNodes.map((node) => positions.get(node.id)).filter(Boolean);
    const anchorX = Math.min(...groupedPositions.map((position) => position.x));
    const anchorY = Math.min(...groupedPositions.map((position) => position.y));
    groupedNodes.forEach((node, index) => {
      if (customNodePositions.has(node.id)) return;
      positions.set(node.id, {
        x: anchorX + (index % 2) * 244,
        y: anchorY + Math.floor(index / 2) * 170,
      });
    });
  }
  for (const position of positions.values()) {
    maxX = Math.max(maxX, position.x + 220);
    maxY = Math.max(maxY, position.y + 136);
  }
  return { positions, width: Math.max(640, maxX + 36), height: Math.max(300, maxY + 36) };
}

function positionParallelGroup(group, canvas) {
  const members = group.nodeIds
    .map((nodeId) => [...canvas.querySelectorAll('.execution-step')]
      .find((step) => step.dataset.stepId === nodeId))
    .filter(Boolean);
  const container = [...canvas.querySelectorAll('.execution-parallel-group')]
    .find((candidate) => candidate.dataset.parallelGroupId === group.id);
  if (container === undefined || members.length === 0) return;
  const left = Math.min(...members.map((member) => Number.parseFloat(member.style.left))) - PARALLEL_GROUP_PADDING;
  const top = Math.min(...members.map((member) => Number.parseFloat(member.style.top))) - PARALLEL_GROUP_PADDING - 19;
  const right = Math.max(...members.map((member) => (
    Number.parseFloat(member.style.left) + Math.max(member.offsetWidth, 220)
  )));
  const bottom = Math.max(...members.map((member) => (
    Number.parseFloat(member.style.top) + Math.max(member.offsetHeight, 136)
  )));
  container.style.setProperty('left', `${left}px`);
  container.style.setProperty('top', `${top}px`);
  container.style.setProperty('width', `${right - left + PARALLEL_GROUP_PADDING}px`);
  container.style.setProperty('height', `${bottom - top + PARALLEL_GROUP_PADDING}px`);
}

function updateParallelGroups(groups, canvas) {
  groups.forEach((group) => positionParallelGroup(group, canvas));
}

function renderParallelGroup(group) {
  const container = element('section', 'execution-parallel-group');
  container.dataset.parallelGroupId = group.id;
  container.setAttribute('aria-label', t('map.parallelGroup', { step: group.label }));
  const header = element('button', 'execution-parallel-label execution-parallel-group-header', t('map.parallel', { step: group.label }));
  header.type = 'button';
  header.dataset.interactive = 'true';
  header.setAttribute('aria-label', t('map.moveParallelGroup', { step: group.label }));
  header.title = t('map.moveParallelGroup', { step: group.label });
  container.append(header);
  return container;
}

function readMapScale(canvas) {
  const value = Number.parseFloat(canvas.dataset.scale ?? '');
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAP_SCALE;
}

function updateCanvasBounds(canvas, steps) {
  const width = Math.max(
    Number.parseFloat(canvas.style.width) || 0,
    ...steps.map((step) => Number.parseFloat(step.style.left) + Math.max(step.offsetWidth, 220) + NODE_MARGIN),
  );
  const height = Math.max(
    Number.parseFloat(canvas.style.height) || 0,
    ...steps.map((step) => Number.parseFloat(step.style.top) + Math.max(step.offsetHeight, 136) + NODE_MARGIN),
  );
  canvas.style.setProperty('width', `${width}px`);
  canvas.style.setProperty('height', `${height}px`);
}

function attachNodeDrag(step, header, canvas, groups, onMoveNode) {
  let dragState = null;
  let suppressClick = false;
  const clear = (event) => {
    if (dragState === null || event?.pointerId !== dragState.pointerId) return;
    const completed = dragState;
    dragState = null;
    delete step.dataset.moving;
    if (header.hasPointerCapture?.(completed.pointerId)) header.releasePointerCapture?.(completed.pointerId);
    if (completed.dragging) {
      suppressClick = true;
      onMoveNode(step.dataset.stepId, {
        x: Number.parseFloat(step.style.left),
        y: Number.parseFloat(step.style.top),
      });
    }
  };
  header.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragState = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: Number.parseFloat(step.style.left),
      y: Number.parseFloat(step.style.top),
      dragging: false,
    };
    header.setPointerCapture?.(event.pointerId);
  });
  header.addEventListener('pointermove', (event) => {
    if (dragState === null || event.pointerId !== dragState.pointerId) return;
    const scale = readMapScale(canvas);
    const deltaX = (event.clientX - dragState.clientX) / scale;
    const deltaY = (event.clientY - dragState.clientY) / scale;
    if (!dragState.dragging && Math.hypot(deltaX, deltaY) < PAN_THRESHOLD) return;
    dragState.dragging = true;
    step.dataset.moving = 'true';
    const x = Math.max(NODE_MARGIN, dragState.x + deltaX);
    const y = Math.max(NODE_MARGIN, dragState.y + deltaY);
    step.style.setProperty('left', `${x}px`);
    step.style.setProperty('top', `${y}px`);
    updateCanvasBounds(canvas, [step]);
    updateParallelGroups(groups, canvas);
    canvas.dispatchEvent(new Event('execution-map-node-moved'));
    event.preventDefault?.();
  });
  header.addEventListener('pointerup', clear);
  header.addEventListener('pointercancel', clear);
  header.addEventListener('lostpointercapture', clear);
  header.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function attachParallelGroupDrag(group, container, canvas, groups, onMoveNode) {
  const header = container.querySelectorAll?.('.execution-parallel-group-header')?.[0];
  if (header === undefined || header === null) return () => undefined;
  let dragState = null;
  let suppressClick = false;
  const memberSteps = () => group.nodeIds
    .map((nodeId) => [...canvas.querySelectorAll('.execution-step')]
      .find((step) => step.dataset.stepId === nodeId))
    .filter(Boolean);
  const clear = (event) => {
    if (dragState === null || (event?.pointerId !== undefined && event.pointerId !== dragState.pointerId)) return;
    const completed = dragState;
    dragState = null;
    delete container.dataset.moving;
    if (header.hasPointerCapture?.(completed.pointerId)) header.releasePointerCapture?.(completed.pointerId);
    if (!completed.dragging) return;
    suppressClick = true;
    for (const step of completed.steps) {
      onMoveNode(step.step.dataset.stepId, {
        x: Number.parseFloat(step.step.style.left),
        y: Number.parseFloat(step.step.style.top),
      });
    }
  };
  const pointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const steps = memberSteps();
    if (steps.length === 0) return;
    dragState = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      steps: steps.map((step) => ({
        step,
        x: Number.parseFloat(step.style.left),
        y: Number.parseFloat(step.style.top),
      })),
      dragging: false,
    };
    header.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event) => {
    if (dragState === null || event.pointerId !== dragState.pointerId) return;
    const scale = readMapScale(canvas);
    const rawDeltaX = (event.clientX - dragState.clientX) / scale;
    const rawDeltaY = (event.clientY - dragState.clientY) / scale;
    if (!dragState.dragging && Math.hypot(rawDeltaX, rawDeltaY) < PAN_THRESHOLD) return;
    dragState.dragging = true;
    container.dataset.moving = 'true';
    const minX = Math.min(...dragState.steps.map(({ x }) => x));
    const minY = Math.min(...dragState.steps.map(({ y }) => y));
    const deltaX = Math.max(NODE_MARGIN - minX, rawDeltaX);
    const deltaY = Math.max(NODE_MARGIN - minY, rawDeltaY);
    for (const member of dragState.steps) {
      member.step.style.setProperty('left', `${member.x + deltaX}px`);
      member.step.style.setProperty('top', `${member.y + deltaY}px`);
    }
    updateCanvasBounds(canvas, dragState.steps.map(({ step }) => step));
    updateParallelGroups(groups, canvas);
    canvas.dispatchEvent(new Event('execution-map-node-moved'));
    event.preventDefault?.();
  };
  const click = (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  header.addEventListener('pointerdown', pointerDown);
  header.addEventListener('pointermove', pointerMove);
  header.addEventListener('pointerup', clear);
  header.addEventListener('pointercancel', clear);
  header.addEventListener('lostpointercapture', clear);
  header.addEventListener('click', click, true);
  return () => {
    header.removeEventListener('pointerdown', pointerDown);
    header.removeEventListener('pointermove', pointerMove);
    header.removeEventListener('pointerup', clear);
    header.removeEventListener('pointercancel', clear);
    header.removeEventListener('lostpointercapture', clear);
    header.removeEventListener('click', click, true);
    clear();
  };
}

function visibleTransitionRelations(trace) {
  const callPairs = new Set(visibleCallRelations(trace).map((call) => `${call.sourceOccurrenceId}->${call.targetOccurrenceId}`));
  return trace.transitions.filter((transition) => {
    const source = findOccurrence(trace, transition.source);
    const target = findOccurrence(trace, transition.target);
    return source?.node.kind === 'step'
      && target?.node.kind === 'step'
      && !callPairs.has(`${transition.source}->${transition.target}`);
  });
}

function findCallSource(trace, call) {
  if (call.startObserved !== true) return undefined;
  const callOccurrence = findOccurrence(trace, call.occurrenceId)?.occurrence;
  if (callOccurrence === undefined) return undefined;
  const candidates = stepNodes(trace)
    .filter((node) => node.workflow === call.workflow && node.label === call.step)
    .flatMap((node) => node.occurrences)
    .filter((candidate) => candidate.firstEventIndex < callOccurrence.firstEventIndex)
    .filter((candidate) => parentContextMatches(candidate.stack, call.stack))
    .sort((left, right) => left.firstEventIndex - right.firstEventIndex);
  if (candidates.length === 0) return undefined;
  return candidates.at(-1)?.id;
}

function visibleCallRelations(trace) {
  return trace.calls.map((call) => {
    const parentOccurrenceId = findCallSource(trace, call);
    return {
      ...call,
      sourceOccurrenceId: parentOccurrenceId,
    };
  }).filter((call) => call.sourceOccurrenceId !== undefined && call.targetObserved);
}

function svgElement(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function rectFor(node) {
  if (typeof node?.getBoundingClientRect !== 'function') {
    return { left: 0, top: 0, right: 0, width: 0, height: 0 };
  }
  return node.getBoundingClientRect();
}

function findOccurrenceAnchor(container, occurrenceId) {
  if (occurrenceId === undefined) return null;
  return [...container.querySelectorAll('.iteration-chip')]
    .find((candidate) => candidate.dataset.occurrenceId === occurrenceId) ?? null;
}

function anchorPoint(anchor, canvas, side) {
  const anchorRect = rectFor(anchor);
  const canvasRect = rectFor(canvas);
  const scale = readMapScale(canvas);
  const x = side === 'right' ? anchorRect.right : anchorRect.left;
  return {
    x: (x - canvasRect.left) / scale + (canvas.scrollLeft ?? 0),
    y: (anchorRect.top - canvasRect.top) / scale + (canvas.scrollTop ?? 0) + anchorRect.height / scale / 2,
  };
}

function curvePath(source, target, kind) {
  if (kind === 'loop') {
    const direction = target.x < source.x ? -1 : 1;
    const distance = Math.max(48, Math.abs(source.x - target.x) * 0.25);
    const height = Math.max(48, Math.abs(source.x - target.x) * 0.22);
    const top = Math.min(source.y, target.y) - height;
    return `M ${source.x} ${source.y} C ${source.x - direction * distance} ${top}, ${target.x + direction * distance} ${top}, ${target.x} ${target.y}`;
  }
  const distance = Math.max(42, Math.abs(target.x - source.x) * 0.42);
  const vertical = kind === 'call' ? Math.sign(target.y - source.y) * 20 : 0;
  return `M ${source.x} ${source.y} C ${source.x + distance} ${source.y + vertical}, ${target.x - distance} ${target.y - vertical}, ${target.x} ${target.y}`;
}

function appendEdge(svg, className, relation, sourceAnchor, targetAnchor, canvas) {
  if (sourceAnchor === null || targetAnchor === null) return;
  const source = anchorPoint(sourceAnchor, canvas, 'right');
  const target = anchorPoint(targetAnchor, canvas, 'left');
  const path = svgElement('path');
  const labelKey = relation.kind === 'loop'
    ? 'map.edgeIteration'
    : relation.kind === 'call'
      ? 'map.edgeCall'
      : 'map.edgeTransition';
  const label = t(labelKey);
  path.setAttribute('class', className);
  path.setAttribute('d', curvePath(source, target, relation.kind));
  path.setAttribute('fill', 'none');
  path.setAttribute('data-edge', 'true');
  path.setAttribute('data-edge-kind', relation.kind);
  path.setAttribute('aria-label', label);
  path.setAttribute('data-relation-id', relation.id);
  path.setAttribute('data-source-occurrence-id', relation.source);
  path.setAttribute('data-target-occurrence-id', relation.target);
  if (relation.targetWorkflow !== undefined) path.setAttribute('data-target-workflow', relation.targetWorkflow);
  path.setAttribute('marker-end', 'url(#execution-edge-arrow)');
  const title = svgElement('title');
  title.textContent = label;
  path.append(title);
  svg.append(path);
}

function updateExecutionMapGeometry(svg, canvas, trace) {
  const width = Math.max(
    Number.parseFloat(canvas.dataset.layoutWidth ?? '') || 0,
    Number.parseFloat(canvas.style.width) || 0,
    (canvas.scrollWidth ?? 0) / readMapScale(canvas),
    1,
  );
  const height = Math.max(
    Number.parseFloat(canvas.dataset.layoutHeight ?? '') || 0,
    Number.parseFloat(canvas.style.height) || 0,
    (canvas.scrollHeight ?? 0) / readMapScale(canvas),
    1,
  );
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.replaceChildren();
  const defs = svgElement('defs');
  const marker = svgElement('marker');
  marker.setAttribute('id', 'execution-edge-arrow');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('refX', '6');
  marker.setAttribute('refY', '3.5');
  marker.setAttribute('orient', 'auto');
  const arrow = svgElement('path');
  arrow.setAttribute('d', 'M 0 0 L 7 3.5 L 0 7 z');
  arrow.setAttribute('fill', 'currentColor');
  marker.append(arrow);
  defs.append(marker);
  svg.append(defs);

  for (const transition of visibleTransitionRelations(trace)) {
    appendEdge(
      svg,
      transition.kind === 'loop'
        ? 'execution-edge execution-edge-loop'
        : 'execution-edge execution-edge-transition',
      transition,
      findOccurrenceAnchor(canvas, transition.source),
      findOccurrenceAnchor(canvas, transition.target),
      canvas,
    );
  }
  for (const call of visibleCallRelations(trace)) {
    if (!call.targetObserved || call.targetOccurrenceId === undefined) continue;
    appendEdge(
      svg,
      'execution-edge execution-edge-call',
      {
        id: call.id,
        kind: 'call',
        source: call.sourceOccurrenceId,
        target: call.targetOccurrenceId,
        targetWorkflow: call.childWorkflow,
      },
      findOccurrenceAnchor(canvas, call.sourceOccurrenceId),
      findOccurrenceAnchor(canvas, call.targetOccurrenceId),
      canvas,
    );
  }
}

function isInteractiveTarget(target) {
  if (typeof target?.closest === 'function') {
    return target.closest('button, a, input, select, textarea, summary, [data-interactive="true"]') !== null;
  }
  const tagName = String(target?.tagName ?? '').toLowerCase();
  return ['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tagName)
    || target?.dataset?.interactive === 'true';
}

function renderRelationOverlay(section, map, canvas, trace, groups, onMoveNode, scale, onScaleChange) {
  const svg = svgElement('svg');
  svg.setAttribute('class', 'execution-edge-overlay');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('map.edgeLegend'));
  updateExecutionMapGeometry(svg, canvas, trace);
  let disposed = false;
  const update = () => {
    if (!disposed) {
      updateParallelGroups(groups, canvas);
      updateExecutionMapGeometry(svg, canvas, trace);
    }
  };
  map.addEventListener('scroll', update);
  canvas.addEventListener('execution-map-node-moved', update);
  const groupDisposers = [];
  if (onMoveNode !== undefined) {
    for (const group of groups) {
      const container = [...canvas.querySelectorAll('.execution-parallel-group')]
        .find((candidate) => candidate.dataset.parallelGroupId === group.id);
      if (container !== undefined) {
        groupDisposers.push(attachParallelGroupDrag(group, container, canvas, groups, onMoveNode));
      }
    }
  }
  let mapScale = clampMapScale(scale === undefined ? DEFAULT_MAP_SCALE : scale);
  canvas.dataset.scale = String(mapScale);
  const wheel = (event) => {
    if (!event.metaKey && !event.ctrlKey) return;
    const nextScale = nextMapScale(mapScale, Number(event.deltaY) || 0);
    const mapRect = rectFor(map);
    const offsetX = Number.isFinite(event.clientX) ? event.clientX - mapRect.left : mapRect.width / 2;
    const offsetY = Number.isFinite(event.clientY) ? event.clientY - mapRect.top : mapRect.height / 2;
    const contentX = (offsetX + (map.scrollLeft ?? 0)) / mapScale;
    const contentY = (offsetY + (map.scrollTop ?? 0)) / mapScale;
    event.preventDefault?.();
    if (nextScale === mapScale) return;
    mapScale = nextScale;
    canvas.dataset.scale = String(mapScale);
    canvas.style.setProperty('transform', `scale(${mapScale})`);
    canvas.style.setProperty('transform-origin', '0 0');
    map.scrollLeft = contentX * mapScale - offsetX;
    map.scrollTop = contentY * mapScale - offsetY;
    onScaleChange?.(mapScale);
    update();
  };
  map.addEventListener('wheel', wheel, { passive: false });
  let observer;
  let windowResize;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(update);
    observer.observe(map);
    observer.observe(canvas);
  } else if (typeof window !== 'undefined') {
    windowResize = update;
    window.addEventListener('resize', windowResize);
  }

  let panState = null;
  const clearPan = (event) => {
    if (panState === null || (event?.pointerId !== undefined && event.pointerId !== panState.pointerId)) return;
    const pointerId = panState.pointerId;
    panState = null;
    delete map.dataset.panPending;
    delete map.dataset.panning;
    map.style.setProperty('user-select', '');
    if (map.hasPointerCapture?.(pointerId)) map.releasePointerCapture?.(pointerId);
  };
  const pointerDown = (event) => {
    if (isInteractiveTarget(event.target)) return;
    if (event.button !== undefined && event.button !== 0) return;
    panState = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: map.scrollLeft ?? 0,
      scrollTop: map.scrollTop ?? 0,
      dragging: false,
    };
    map.dataset.panPending = 'true';
    map.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event) => {
    if (panState === null || event.pointerId !== panState.pointerId) return;
    const deltaX = event.clientX - panState.clientX;
    const deltaY = event.clientY - panState.clientY;
    if (!panState.dragging && Math.hypot(deltaX, deltaY) < PAN_THRESHOLD) return;
    panState.dragging = true;
    map.dataset.panning = 'true';
    delete map.dataset.panPending;
    map.style.setProperty('user-select', 'none');
    map.scrollLeft = panState.scrollLeft - deltaX;
    map.scrollTop = panState.scrollTop - deltaY;
    event.preventDefault?.();
  };
  map.addEventListener('pointerdown', pointerDown);
  map.addEventListener('pointermove', pointerMove);
  map.addEventListener('pointerup', clearPan);
  map.addEventListener('pointercancel', clearPan);
  map.addEventListener('lostpointercapture', clearPan);

  executionMapDisposers.set(section, () => {
    if (disposed) return;
    disposed = true;
    map.removeEventListener('scroll', update);
    canvas.removeEventListener('execution-map-node-moved', update);
    map.removeEventListener('pointerdown', pointerDown);
    map.removeEventListener('pointermove', pointerMove);
    map.removeEventListener('pointerup', clearPan);
    map.removeEventListener('pointercancel', clearPan);
    map.removeEventListener('lostpointercapture', clearPan);
    map.removeEventListener('wheel', wheel);
    groupDisposers.forEach((dispose) => dispose());
    clearPan();
    observer?.disconnect();
    if (windowResize !== undefined && typeof window !== 'undefined') window.removeEventListener('resize', windowResize);
  });
  return svg;
}

export function renderExecutionMap(trace, options) {
  const section = element('section', 'trace-section execution-map-section');
  const heading = element('div', 'panel-heading');
  const copy = element('div', 'panel-heading-copy');
  copy.append(
    element('h3', '', t('map.title')),
    element('p', '', t('map.description')),
  );
  heading.append(copy, options.liveIndicator);
  section.append(heading);
  const nodes = stepNodes(trace);
  if (nodes.length === 0) {
    section.append(options.emptyState);
    return section;
  }

  const customNodePositions = options.customNodePositions ?? new Map();
  const layout = layoutSteps(trace, customNodePositions);
  const groups = parallelGroups(nodes);
  const iterationTargets = new Set(trace.transitions
    .filter((transition) => transition.kind === 'loop')
    .map((transition) => transition.targetLogicalId));
  const mapHeader = element('div', 'execution-map-header');
  mapHeader.append(
    element('span', 'execution-map-summary', t('map.summarySteps', {
      steps: nodes.length,
      passes: trace.totalOccurrences,
      lanes: trace.lanes.length,
    })),
    element('span', 'execution-map-key', t('map.selectPass')),
  );
  const legend = element('div', 'execution-map-legend');
  legend.setAttribute('aria-label', t('map.edgeLegend'));
  for (const [kind, labelKey] of [
    ['transition', 'map.edgeTransition'],
    ['loop', 'map.edgeIteration'],
    ['call', 'map.edgeCall'],
  ]) {
    const item = element('span', `execution-map-legend-item execution-map-legend-${kind}`);
    item.append(element('span', 'execution-map-legend-mark', ''), element('span', '', t(labelKey)));
    item.title = t(labelKey);
    legend.append(item);
  }
  mapHeader.append(legend);
  section.append(mapHeader);

  const map = element('div', 'execution-map');
  map.id = 'execution-map';
  map.setAttribute('role', 'group');
  map.setAttribute('aria-label', t('map.ariaLabel'));
  map.setAttribute('aria-description', t('map.panHint'));
  map.dataset.panHint = t('map.panHint');
  const canvas = element('div', 'execution-map-canvas');
  const scale = clampMapScale(options.scale === undefined ? DEFAULT_MAP_SCALE : options.scale);
  canvas.dataset.layoutWidth = String(layout.width);
  canvas.dataset.layoutHeight = String(layout.height);
  canvas.dataset.scale = String(scale);
  canvas.style.setProperty('width', `${layout.width}px`);
  canvas.style.setProperty('height', `${layout.height}px`);
  canvas.style.setProperty('transform', `scale(${scale})`);
  canvas.style.setProperty('transform-origin', '0 0');
  for (const group of groups) canvas.append(renderParallelGroup(group));
  for (const node of nodes) {
    const renderedStep = renderStep(
      node,
      layout.positions.get(node.id) ?? { x: 28, y: 28 },
      options.selectedOccurrenceId,
      options.onSelectOccurrence,
      iterationTargets.has(node.id),
    );
    if (renderedStep !== null) {
      canvas.append(renderedStep.step);
      if (options.onMoveNode !== undefined) {
        attachNodeDrag(
          renderedStep.step,
          renderedStep.headerButton,
          canvas,
          groups,
          options.onMoveNode,
        );
      }
    }
  }
  updateParallelGroups(groups, canvas);
  map.append(canvas);
  section.append(map);
  // Measure anchors after the map is attached. Detached nodes have zero
  // geometry in browsers, which would leave the initial SVG paths at 0,0.
  const overlay = renderRelationOverlay(
    section,
    map,
    canvas,
    trace,
    groups,
    options.onMoveNode,
    scale,
    options.onScaleChange,
  );
  canvas.append(overlay);
  return section;
}

export function disposeExecutionMap(container) {
  const sections = [];
  if (container?.matches?.('.execution-map-section')) sections.push(container);
  sections.push(...(container?.querySelectorAll?.('.execution-map-section') ?? []));
  for (const section of sections) {
    const dispose = executionMapDisposers.get(section);
    if (dispose === undefined) continue;
    dispose();
    executionMapDisposers.delete(section);
  }
}

export function updateExecutionMapSelection(container, selectedOccurrenceId) {
  for (const step of container.querySelectorAll('.execution-step')) {
    const selected = [...step.querySelectorAll('[data-occurrence-id]')]
      .some((button) => button.dataset.occurrenceId === selectedOccurrenceId);
    step.dataset.active = String(selected);
  }
  for (const chip of container.querySelectorAll('[data-occurrence-id]')) {
    const selected = chip.dataset.occurrenceId === selectedOccurrenceId;
    chip.dataset.selected = String(selected);
    chip.setAttribute('aria-pressed', String(selected));
  }
}
