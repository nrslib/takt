import { t } from './i18n.js';
import { parallelGroupFamilyKey } from './execution-model.js';

const executionMapDisposers = new WeakMap();
const executionMapHeaders = new WeakMap();
const PAN_THRESHOLD = 4;
const NODE_MARGIN = 16;
const PARALLEL_GROUP_PADDING = 14;
// The group frame reserves this band above its member nodes for the label and
// ITER selector. Keep the frame geometry and hit-test geometry in one place.
const PARALLEL_GROUP_HEADER_HEIGHT = 58;
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

function occurrenceCallValue(occurrence) {
  const callFrame = Array.isArray(occurrence.stack)
    ? [...occurrence.stack].reverse().find((frame) => frame.kind === 'workflow_call')
    : undefined;
  return occurrence.callInstance ?? callFrame?.occurrence;
}

function occurrenceLabel(occurrence, index) {
  const callValue = occurrenceCallValue(occurrence);
  const callLabel = callValue === undefined ? '' : ` · ${t('map.call', { value: callValue })}`;
  return `${t('map.iter', { number: occurrence.ordinal ?? index + 1 })}${callLabel}`;
}

function occurrenceOutcomeLabel(occurrence) {
  return occurrence.status === 'completed'
    && Number.isSafeInteger(occurrence.matchedRuleIndex)
    && occurrence.matchedRuleIndex >= 0
    ? t('map.result', { number: occurrence.matchedRuleIndex + 1 })
    : null;
}

function renderIterationChip(
  node,
  occurrence,
  index,
  selectedOccurrenceId,
  selectedParallelGroupKey,
  presentationParallelGroupOrdinals,
  onSelectOccurrence,
) {
  const button = element('button', 'iteration-chip');
  button.type = 'button';
  button.dataset.occurrenceId = occurrence.id;
  button.dataset.kind = 'iteration';
  const isParallelChild = occurrence.parallelGroupKey !== undefined
    && occurrence.parallelGroupAmbiguous !== true;
  const groupSelected = isParallelChild && occurrence.parallelGroupKey === selectedParallelGroupKey;
  const selected = occurrence.id === selectedOccurrenceId || groupSelected;
  button.dataset.parallelGroupKey = occurrence.parallelGroupKey ?? '';
  button.dataset.selected = String(selected);
  button.setAttribute('aria-pressed', String(selected));
  const ordinal = occurrence.ordinal ?? index + 1;
  const callValue = occurrenceCallValue(occurrence);
  const outcomeLabel = occurrenceOutcomeLabel(occurrence);
  const groupOrdinal = isParallelChild
    ? presentationParallelGroupOrdinals.get(occurrence.parallelGroupKey)
    : undefined;
  const groupLabel = groupOrdinal === undefined
    ? t('map.parallelMember')
    : t('map.parallelIteration', { number: groupOrdinal });
  const visibleLabel = isParallelChild
    ? outcomeLabel ?? statusLabel(occurrence.status)
    : occurrenceLabel(occurrence, index);
  const visibleDetail = isParallelChild
    ? callValue === undefined ? statusLabel(occurrence.status) : t('map.call', { value: callValue })
    : outcomeLabel ?? statusLabel(occurrence.status);
  const accessibleLabel = [
    nodeLabel(node),
    isParallelChild ? groupLabel : t('map.iteration', { number: ordinal }),
    occurrence.iteration === undefined
      ? ''
      : t('map.workflowIteration', { number: occurrence.iteration }),
    callValue === undefined ? '' : t('map.call', { value: callValue }),
    occurrence.phases.join(' / '),
    occurrence.personas.join(' / '),
    outcomeLabel ?? statusLabel(occurrence.status),
  ].filter(Boolean).join(' · ');
  button.setAttribute('aria-label', accessibleLabel);
  button.title = accessibleLabel;
  button.append(
    element('span', 'iteration-chip-label', visibleLabel),
    element(
      'span',
      isParallelChild
        ? 'iteration-chip-parallel-detail'
        : outcomeLabel === null
        ? 'iteration-chip-status'
        : 'iteration-chip-result',
      visibleDetail,
    ),
  );
  button.addEventListener('click', () => onSelectOccurrence(node, occurrence));
  return button;
}

function renderStep(
  node,
  position,
  selectedStepId,
  selectedOccurrenceId,
  selectedParallelGroupKey,
  presentationParallelGroupOrdinals,
  onSelectStep,
  onSelectOccurrence,
  hasIteration,
) {
  const latest = node.occurrences.at(-1);
  if (latest === undefined) return null;
  const selectedStep = selectedOccurrenceId === null && node.id === selectedStepId;
  const activeOccurrence = selectedOccurrenceId !== null && node.occurrences.some(
    (occurrence) => occurrence.id === selectedOccurrenceId,
  ) || selectedParallelGroupKey !== null && node.occurrences.some(
    (occurrence) => occurrence.parallelGroupKey === selectedParallelGroupKey,
  );
  const step = element('article', `execution-step execution-step-${latest.status}`);
  step.dataset.stepId = node.id;
  step.dataset.kind = 'step';
  step.dataset.repeated = String(node.occurrences.length > 1);
  step.dataset.selected = String(selectedStep);
  step.dataset.active = String(activeOccurrence);
  step.dataset.layoutX = String(position.x);
  step.dataset.layoutY = String(position.y);
  step.style.setProperty('left', `${position.x}px`);
  step.style.setProperty('top', `${position.y}px`);
  const fullIdentity = node.workflow === nodeLabel(node) ? '' : node.workflow;
  if (fullIdentity !== '') step.title = fullIdentity;
  const headerButton = element('button', 'execution-step-header');
  headerButton.type = 'button';
  headerButton.dataset.stepId = node.id;
  headerButton.setAttribute('aria-pressed', String(selectedStep));
  headerButton.setAttribute('aria-label', t('map.showStep', { step: nodeLabel(node) }));
  headerButton.append(
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
  headerButton.addEventListener('click', () => {
    if (typeof onSelectStep === 'function') onSelectStep(node);
  });
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
    chips.append(renderIterationChip(
      node,
      occurrence,
      index,
      selectedOccurrenceId,
      selectedParallelGroupKey,
      presentationParallelGroupOrdinals,
      onSelectOccurrence,
    ));
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

function parallelContexts(node) {
  const candidates = node.occurrences
    .map((occurrence) => ({ occurrence, stack: occurrence.stack }))
    .filter(({ stack }) => Array.isArray(stack))
    .map(({ occurrence, stack }) => {
      const frameIndex = [...stack].findLastIndex((frame) => frame?.kind === 'parallel');
      if (frameIndex < 0) return null;
      const frame = stack[frameIndex];
      const familyKey = occurrence.parallelGroupFamilyKey ?? parallelGroupFamilyKey(stack);
      const presentationKey = parallelGroupFamilyKey(stack);
      if (familyKey === undefined || presentationKey === undefined) return null;
      return {
        frame,
        familyKey,
        presentationKey,
      };
    })
    .filter(Boolean);
  return candidates;
}

function parallelGroups(nodes, traceGroups = []) {
  const groups = new Map();
  const presentationByFamily = new Map();
  for (const node of nodes) {
    for (const context of parallelContexts(node)) {
      presentationByFamily.set(context.familyKey, context.presentationKey);
      const previous = groups.get(context.presentationKey);
      groups.set(context.presentationKey, previous === undefined
        ? {
            id: context.presentationKey,
            label: context.frame.step,
            nodeIds: [node.id],
            iterations: [],
          }
        : { ...previous, nodeIds: [...new Set([...previous.nodeIds, node.id])] });
    }
  }
  for (const traceGroup of traceGroups) {
    if (traceGroup?.familyKey === undefined) continue;
    const presentationKey = presentationByFamily.get(traceGroup.familyKey);
    if (presentationKey === undefined) continue;
    const context = groups.get(presentationKey);
    if (context === undefined) continue;
    const previous = context.iterations.find((candidate) => candidate.key === traceGroup.key);
    groups.set(presentationKey, {
      ...context,
      nodeIds: [...new Set([...context.nodeIds, ...(traceGroup.nodeIds ?? [])])],
      iterations: previous === undefined
        ? [...context.iterations, traceGroup]
        : context.iterations.map((candidate) => candidate.key === traceGroup.key
          ? { ...candidate, ...traceGroup }
          : candidate),
    });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      iterations: [...group.iterations]
        .sort((left, right) => left.firstEventIndex - right.firstEventIndex || left.key.localeCompare(right.key))
        .map((iteration, index) => ({ ...iteration, ordinal: index + 1 })),
    }))
    .filter((group) => group.nodeIds.length > 1);
}

export function parallelGroupPresentationOrdinal(trace, groupKey) {
  if (typeof groupKey !== 'string' || groupKey === '') return undefined;
  return parallelGroups(stepNodes(trace), trace.parallelGroups ?? [])
    .flatMap((group) => group.iterations)
    .find((iteration) => iteration.key === groupKey)?.ordinal;
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
  for (const group of parallelGroups(nodes, trace.parallelGroups ?? [])) {
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
  const top = Math.min(...members.map((member) => Number.parseFloat(member.style.top))) - PARALLEL_GROUP_HEADER_HEIGHT;
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

function renderParallelGroup(group, selectedParallelGroupKey, onSelectParallelGroup) {
  const container = element('section', 'execution-parallel-group');
  container.dataset.parallelGroupId = group.id;
  container.dataset.selected = String(group.iterations.some(
    (iteration) => iteration.key === selectedParallelGroupKey,
  ));
  container.setAttribute('aria-label', t('map.parallelGroup', { step: group.label }));
  const header = element('button', 'execution-parallel-label execution-parallel-group-header', t('map.parallel', { step: group.label }));
  header.type = 'button';
  header.dataset.interactive = 'true';
  header.setAttribute('aria-label', t('map.moveParallelGroup', { step: group.label }));
  header.title = t('map.moveParallelGroup', { step: group.label });
  container.append(header);
  if (group.iterations.length > 0) {
    const iterationList = element('div', 'execution-parallel-iterations');
    iterationList.setAttribute('role', 'tablist');
    iterationList.setAttribute('aria-label', t('map.parallelIterations', { step: group.label }));
    for (const iteration of group.iterations) {
      const button = element(
        'button',
        'execution-parallel-iteration',
        t('map.iter', { number: iteration.ordinal }),
      );
      button.type = 'button';
      button.dataset.interactive = 'true';
      button.dataset.parallelGroupKey = iteration.key;
      button.dataset.selected = String(iteration.key === selectedParallelGroupKey);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(iteration.key === selectedParallelGroupKey));
      button.setAttribute('aria-pressed', String(iteration.key === selectedParallelGroupKey));
      button.setAttribute('aria-label', t('map.selectParallelIteration', {
        step: group.label,
        number: iteration.ordinal,
      }));
      button.title = t('map.selectParallelIteration', {
        step: group.label,
        number: iteration.ordinal,
      });
      // Keep the iteration selector independent from the group's drag handle.
      // In particular, do not prevent the native button activation/focus path.
      button.addEventListener('pointerdown', (event) => event.stopPropagation?.());
      button.addEventListener('click', (event) => {
        event.stopPropagation?.();
        onSelectParallelGroup?.(group, iteration);
      });
      button.addEventListener('keydown', (event) => {
        event.stopPropagation?.();
        const index = group.iterations.findIndex((candidate) => candidate.key === iteration.key);
        let nextIndex = index;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          nextIndex = (index + 1) % group.iterations.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          nextIndex = (index - 1 + group.iterations.length) % group.iterations.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = group.iterations.length - 1;
        } else return;
        event.preventDefault?.();
        const next = group.iterations[nextIndex];
        const buttons = [...iterationList.querySelectorAll('.execution-parallel-iteration')];
        buttons[nextIndex]?.focus?.();
        if (next !== undefined) onSelectParallelGroup?.(group, next);
      });
      iterationList.append(button);
    }
    container.append(iterationList);
  }
  return container;
}

function readMapScale(canvas) {
  const value = Number.parseFloat(canvas.dataset.scale ?? '');
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAP_SCALE;
}

function prepareDragPointerDown(event, handle) {
  event.preventDefault?.();
  handle.focus?.();
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
    prepareDragPointerDown(event, header);
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
  const isDragHandleTarget = (target) => {
    if (target === undefined || target === null || target === header) return true;
    return typeof target.closest === 'function'
      && target.closest('.execution-parallel-group-header') === header;
  };
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
    // The header is the only drag surface. If an interactive descendant ever
    // gets added to it, keep that control's pointer sequence intact.
    if (!isDragHandleTarget(event.target)) {
      event.stopPropagation?.();
      return;
    }
    event.stopPropagation?.();
    prepareDragPointerDown(event, header);
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
  }).map((transition) => ({
    ...transition,
    sourceParallelGroupKey: findOccurrence(trace, transition.source)?.occurrence.parallelGroupKey,
    targetParallelGroupKey: findOccurrence(trace, transition.target)?.occurrence.parallelGroupKey,
  }));
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

function visibleEdgeRelations(trace) {
  const transitions = visibleTransitionRelations(trace);
  const calls = visibleCallRelations(trace)
    .filter((call) => call.targetOccurrenceId !== undefined)
    .map((call) => {
      const source = findOccurrence(trace, call.sourceOccurrenceId);
      const target = findOccurrence(trace, call.targetOccurrenceId);
      return {
        id: call.id,
        kind: 'call',
        source: call.sourceOccurrenceId,
        target: call.targetOccurrenceId,
        sourceStepId: source?.node.id,
        targetStepId: target?.node.id,
        targetWorkflow: call.childWorkflow,
        sourceParallelGroupKey: source?.occurrence.parallelGroupKey,
        targetParallelGroupKey: target?.occurrence.parallelGroupKey,
        sourceParallelGroupKey: source?.occurrence.parallelGroupKey,
        targetParallelGroupKey: target?.occurrence.parallelGroupKey,
      };
    });
  return [...transitions, ...calls];
}

function edgeRole(
  source,
  target,
  selectedOccurrenceId,
  sourceStepId,
  targetStepId,
  selectedStepId,
  selectedParallelGroupKey = null,
  sourceParallelGroupKey,
  targetParallelGroupKey,
) {
  const incoming = selectedOccurrenceId !== null
    ? target === selectedOccurrenceId
    : selectedStepId !== null
      ? targetStepId === selectedStepId
      : selectedParallelGroupKey !== null && targetParallelGroupKey === selectedParallelGroupKey;
  const outgoing = selectedOccurrenceId !== null
    ? source === selectedOccurrenceId
    : selectedStepId !== null
      ? sourceStepId === selectedStepId
      : selectedParallelGroupKey !== null && sourceParallelGroupKey === selectedParallelGroupKey;
  if (incoming && outgoing) return 'incoming-outgoing';
  if (incoming) return 'incoming';
  if (outgoing) return 'outgoing';
  return 'none';
}

function edgeRoleParts(role) {
  return role === 'incoming-outgoing' ? ['incoming', 'outgoing'] : role === 'none' ? [] : [role];
}

function edgeDirectionLabelKey(selectedOccurrenceId, selectedStepId, selectedParallelGroupKey, role) {
  if (role === 'incoming') {
    return selectedOccurrenceId === null && selectedStepId === null && selectedParallelGroupKey !== null
      ? 'map.parallelEdgeIncoming'
      : selectedOccurrenceId === null && selectedStepId !== null
      ? 'map.stepEdgeIncoming'
      : 'map.edgeIncoming';
  }
  if (role === 'outgoing') {
    return selectedOccurrenceId === null && selectedStepId === null && selectedParallelGroupKey !== null
      ? 'map.parallelEdgeOutgoing'
      : selectedOccurrenceId === null && selectedStepId !== null
      ? 'map.stepEdgeOutgoing'
      : 'map.edgeOutgoing';
  }
  return null;
}

function markersForEdgeRole(role) {
  const variant = role === 'incoming' || role === 'incoming-outgoing'
    ? '-incoming'
    : role === 'outgoing' ? '-outgoing' : '';
  return {
    start: `url(#execution-edge-from${variant})`,
    end: `url(#execution-edge-to${variant})`,
  };
}

function applyEdgeSelection(svg, selectedOccurrenceId, selectedStepId = null, selectedParallelGroupKey = null) {
  for (const path of svg.querySelectorAll('[data-edge]')) {
    const role = edgeRole(
      path.getAttribute('data-source-occurrence-id'),
      path.getAttribute('data-target-occurrence-id'),
      selectedOccurrenceId,
      path.getAttribute('data-source-step-id'),
      path.getAttribute('data-target-step-id'),
      selectedStepId,
      selectedParallelGroupKey,
      path.getAttribute('data-source-parallel-group-key'),
      path.getAttribute('data-target-parallel-group-key'),
    );
    const baseClass = path.getAttribute('data-edge-base-class') ?? path.getAttribute('class') ?? '';
    const roleClasses = edgeRoleParts(role).map((part) => `execution-edge-emphasis-${part}`);
    path.setAttribute('data-edge-role', role);
    path.setAttribute('class', [baseClass, ...roleClasses].filter(Boolean).join(' '));
    const markers = markersForEdgeRole(role);
    path.setAttribute('marker-start', markers.start);
    path.setAttribute('marker-end', markers.end);
    const baseLabel = path.getAttribute('data-edge-base-label') ?? path.getAttribute('aria-label') ?? '';
    const directionLabels = edgeRoleParts(role)
      .map((part) => edgeDirectionLabelKey(selectedOccurrenceId, selectedStepId, selectedParallelGroupKey, part))
      .filter((key) => key !== null)
      .map((key) => t(key));
    const accessibleLabel = directionLabels.length === 0
      ? baseLabel
      : `${baseLabel} · ${directionLabels.join(' / ')}`;
    path.setAttribute('aria-label', accessibleLabel);
    const title = path.querySelectorAll('title')[0];
    if (title !== undefined) title.textContent = accessibleLabel;
  }
}

function renderSelectionLegend(selectedOccurrenceId, selectedStepId, selectedParallelGroupKey, roles) {
  if ((selectedOccurrenceId === null && selectedStepId === null && selectedParallelGroupKey === null) || roles.size === 0) return null;
  const legend = element('div', 'execution-map-legend execution-map-selection-legend');
  legend.setAttribute(
    'aria-label',
    t(selectedParallelGroupKey !== null
      ? 'map.parallelEdgeLegend'
      : selectedOccurrenceId === null ? 'map.stepEdgeLegend' : 'map.edgeLegend'),
  );
  const incomingLabel = selectedOccurrenceId === null
    ? selectedParallelGroupKey !== null ? 'map.parallelEdgeIncoming' : 'map.stepEdgeIncoming'
    : 'map.edgeIncoming';
  const outgoingLabel = selectedOccurrenceId === null
    ? selectedParallelGroupKey !== null ? 'map.parallelEdgeOutgoing' : 'map.stepEdgeOutgoing'
    : 'map.edgeOutgoing';
  for (const [role, labelKey] of [
    ['incoming', incomingLabel],
    ['outgoing', outgoingLabel],
  ]) {
    if (!roles.has(role)) continue;
    const item = element('span', `execution-map-legend-item execution-map-legend-${role}`);
    const mark = element('span', 'execution-map-legend-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(
      element('span', 'execution-map-legend-from'),
      element('span', 'execution-map-legend-to'),
    );
    item.append(mark, element('span', '', t(labelKey)));
    item.title = t(labelKey);
    legend.append(item);
  }
  return legend;
}

function selectionRolesFromRelations(
  relations,
  selectedOccurrenceId,
  selectedStepId = null,
  selectedParallelGroupKey = null,
) {
  const roles = new Set();
  if (selectedOccurrenceId === null && selectedStepId === null && selectedParallelGroupKey === null) return roles;
  for (const relation of relations) {
    const role = edgeRole(
      relation.source,
      relation.target,
      selectedOccurrenceId,
      relation.sourceStepId ?? relation.sourceLogicalId,
      relation.targetStepId ?? relation.targetLogicalId,
      selectedStepId,
      selectedParallelGroupKey,
      relation.sourceParallelGroupKey,
      relation.targetParallelGroupKey,
    );
    for (const part of edgeRoleParts(role)) roles.add(part);
  }
  return roles;
}

function selectionRolesFromEdges(
  edges,
  selectedOccurrenceId,
  selectedStepId = null,
  selectedParallelGroupKey = null,
) {
  const roles = new Set();
  if (selectedOccurrenceId === null && selectedStepId === null && selectedParallelGroupKey === null) return roles;
  for (const edge of edges) {
    const role = edgeRole(
      edge.getAttribute('data-source-occurrence-id'),
      edge.getAttribute('data-target-occurrence-id'),
      selectedOccurrenceId,
      edge.getAttribute('data-source-step-id'),
      edge.getAttribute('data-target-step-id'),
      selectedStepId,
      selectedParallelGroupKey,
      edge.getAttribute('data-source-parallel-group-key'),
      edge.getAttribute('data-target-parallel-group-key'),
    );
    for (const part of edgeRoleParts(role)) roles.add(part);
  }
  return roles;
}

function replaceSelectionLegend(header, selectedOccurrenceId, selectedStepId, selectedParallelGroupKey, roles) {
  const existing = header.querySelectorAll('.execution-map-selection-legend')[0];
  const children = [...header.children].filter((child) => child !== existing);
  const legend = renderSelectionLegend(
    selectedOccurrenceId,
    selectedStepId,
    selectedParallelGroupKey,
    roles,
  );
  header.replaceChildren(...children, ...(legend === null ? [] : [legend]));
}

function appendCircleMarker(defs, id, color, filled) {
  const marker = svgElement('marker');
  marker.setAttribute('id', id);
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('markerUnits', 'userSpaceOnUse');
  marker.setAttribute('refX', '4');
  marker.setAttribute('refY', '4');
  marker.setAttribute('orient', 'auto');
  const circle = svgElement('circle');
  circle.setAttribute('cx', '4');
  circle.setAttribute('cy', '4');
  circle.setAttribute('r', '3');
  circle.setAttribute('fill', filled ? color : 'none');
  circle.setAttribute('stroke', color);
  circle.setAttribute('stroke-width', '1.5');
  marker.append(circle);
  defs.append(marker);
}

function svgElement(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function rectFor(node) {
  if (typeof node?.getBoundingClientRect !== 'function') {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  const rect = node.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: Number.isFinite(rect.right) ? rect.right : rect.left + rect.width,
    bottom: Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height,
    width: rect.width,
    height: rect.height,
  };
}

function findOccurrenceAnchor(container, occurrenceId) {
  if (occurrenceId === undefined) return null;
  return [...container.querySelectorAll('.iteration-chip')]
    .find((candidate) => candidate.dataset.occurrenceId === occurrenceId) ?? null;
}

function directionForSide(side) {
  return {
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    top: { x: 0, y: -1 },
    bottom: { x: 0, y: 1 },
  }[side] ?? { x: 1, y: 0 };
}

function sideForRelativePosition(anchorRect, otherRect, fallback) {
  const anchorCenterX = (anchorRect.left + anchorRect.right) / 2;
  const anchorCenterY = (anchorRect.top + anchorRect.bottom) / 2;
  const otherCenterX = (otherRect.left + otherRect.right) / 2;
  const otherCenterY = (otherRect.top + otherRect.bottom) / 2;
  const deltaX = otherCenterX - anchorCenterX;
  const deltaY = otherCenterY - anchorCenterY;
  if (deltaX === 0 && deltaY === 0) return fallback;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return deltaX >= 0 ? 'right' : 'left';
  return deltaY >= 0 ? 'bottom' : 'top';
}

function pointOnSide(anchorRect, canvasRect, scale, side, scrollLeft = 0, scrollTop = 0) {
  const x = side === 'right'
    ? anchorRect.right
    : side === 'left'
      ? anchorRect.left
      : (anchorRect.left + anchorRect.right) / 2;
  const y = side === 'bottom'
    ? anchorRect.bottom
    : side === 'top'
      ? anchorRect.top
      : (anchorRect.top + anchorRect.bottom) / 2;
  return {
    x: (x - canvasRect.left) / scale + scrollLeft,
    y: (y - canvasRect.top) / scale + scrollTop,
    side,
  };
}

export function edgeAnchorGeometry(sourceRect, targetRect, canvasRect, scale = 1, forceLoopPorts = false) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const sourceSide = forceLoopPorts
    ? 'right'
    : sideForRelativePosition(sourceRect, targetRect, 'right');
  const targetSide = forceLoopPorts
    ? 'right'
    : sideForRelativePosition(targetRect, sourceRect, 'left');
  return {
    source: pointOnSide(sourceRect, canvasRect, safeScale, sourceSide),
    target: pointOnSide(targetRect, canvasRect, safeScale, targetSide),
  };
}

function anchorPoints(sourceAnchor, targetAnchor, canvas, kind) {
  const sourceRect = rectFor(sourceAnchor);
  const targetRect = rectFor(targetAnchor);
  const canvasRect = rectFor(canvas);
  const sameStep = typeof sourceAnchor?.closest === 'function'
    && sourceAnchor.closest('.execution-step') !== null
    && sourceAnchor.closest('.execution-step') === targetAnchor?.closest?.('.execution-step');
  return edgeAnchorGeometry(
    sourceRect,
    targetRect,
    canvasRect,
    readMapScale(canvas),
    kind === 'loop' && sameStep,
  );
}

export function curvePath(source, target, kind) {
  const sourceDirection = directionForSide(source.side);
  const targetDirection = directionForSide(target.side);
  const distance = Math.max(42, Math.min(220, Math.hypot(target.x - source.x, target.y - source.y) * 0.42));
  const sourceControl = {
    x: source.x + sourceDirection.x * distance,
    y: source.y + sourceDirection.y * distance,
  };
  const targetControl = {
    x: target.x + targetDirection.x * distance,
    y: target.y + targetDirection.y * distance,
  };
  if (kind === 'loop' && source.side === target.side) {
    const perpendicular = source.side === 'left' || source.side === 'right' ? distance : 0;
    const vertical = source.side === 'top' || source.side === 'bottom' ? distance : 0;
    const sign = source.side === 'left' || source.side === 'top' ? -1 : 1;
    sourceControl.x += source.side === 'left' || source.side === 'right' ? 0 : sign * perpendicular;
    sourceControl.y += source.side === 'top' || source.side === 'bottom' ? 0 : sign * vertical;
    targetControl.x += source.side === 'left' || source.side === 'right' ? 0 : sign * perpendicular;
    targetControl.y += source.side === 'top' || source.side === 'bottom' ? 0 : sign * vertical;
  }
  return `M ${source.x} ${source.y} C ${sourceControl.x} ${sourceControl.y}, ${targetControl.x} ${targetControl.y}, ${target.x} ${target.y}`;
}

function appendEdge(svg, className, relation, sourceAnchor, targetAnchor, canvas) {
  if (sourceAnchor === null || targetAnchor === null) return;
  const { source, target } = anchorPoints(sourceAnchor, targetAnchor, canvas, relation.kind);
  const sourceStepId = relation.sourceStepId
    ?? relation.sourceLogicalId
    ?? sourceAnchor.closest?.('.execution-step')?.dataset?.stepId;
  const targetStepId = relation.targetStepId
    ?? relation.targetLogicalId
    ?? targetAnchor.closest?.('.execution-step')?.dataset?.stepId;
  const path = svgElement('path');
  const labelKey = relation.kind === 'loop'
    ? 'map.edgeIteration'
    : relation.kind === 'call'
      ? 'map.edgeCall'
      : 'map.edgeTransition';
  const label = `${t(labelKey)} · ${t('map.edgeDirection')}`;
  path.setAttribute('class', className);
  path.setAttribute('data-edge-base-class', className);
  path.setAttribute('d', curvePath(source, target, relation.kind));
  path.setAttribute('fill', 'none');
  path.setAttribute('data-edge', 'true');
  path.setAttribute('data-edge-key', `${relation.kind}:${relation.id}`);
  path.setAttribute('data-edge-base-label', label);
  path.setAttribute('data-edge-kind', relation.kind);
  path.setAttribute('aria-label', label);
  path.setAttribute('data-relation-id', relation.id);
  path.setAttribute('data-source-occurrence-id', relation.source);
  path.setAttribute('data-target-occurrence-id', relation.target);
  if (sourceStepId !== undefined) path.setAttribute('data-source-step-id', sourceStepId);
  if (targetStepId !== undefined) path.setAttribute('data-target-step-id', targetStepId);
  if (relation.sourceParallelGroupKey !== undefined) {
    path.setAttribute('data-source-parallel-group-key', relation.sourceParallelGroupKey);
  }
  if (relation.targetParallelGroupKey !== undefined) {
    path.setAttribute('data-target-parallel-group-key', relation.targetParallelGroupKey);
  }
  if (relation.targetWorkflow !== undefined) path.setAttribute('data-target-workflow', relation.targetWorkflow);
  const markers = markersForEdgeRole('none');
  path.setAttribute('marker-start', markers.start);
  path.setAttribute('marker-end', markers.end);
  const title = svgElement('title');
  title.textContent = label;
  path.append(title);
  svg.append(path);
}

function updateExecutionMapGeometry(svg, canvas, trace) {
  const width = Math.max(
    Number.parseFloat(canvas.dataset.layoutWidth ?? '') || 0,
    Number.parseFloat(canvas.style.width) || 0,
    canvas.scrollWidth ?? 0,
    1,
  );
  const height = Math.max(
    Number.parseFloat(canvas.dataset.layoutHeight ?? '') || 0,
    Number.parseFloat(canvas.style.height) || 0,
    canvas.scrollHeight ?? 0,
    1,
  );
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.replaceChildren();
  const defs = svgElement('defs');
  for (const [suffix, color] of [
    ['', 'currentColor'],
    ['-incoming', 'var(--accent)'],
    ['-outgoing', 'var(--warning)'],
  ]) {
    appendCircleMarker(defs, `execution-edge-from${suffix}`, color, false);
    appendCircleMarker(defs, `execution-edge-to${suffix}`, color, true);
  }
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
    const source = findOccurrence(trace, call.sourceOccurrenceId);
    const target = findOccurrence(trace, call.targetOccurrenceId);
    appendEdge(
      svg,
      'execution-edge execution-edge-call',
      {
        id: call.id,
        kind: 'call',
        source: call.sourceOccurrenceId,
        target: call.targetOccurrenceId,
        sourceStepId: source?.node.id,
        targetStepId: target?.node.id,
        targetWorkflow: call.childWorkflow,
      },
      findOccurrenceAnchor(canvas, call.sourceOccurrenceId),
      findOccurrenceAnchor(canvas, call.targetOccurrenceId),
      canvas,
    );
  }
  applyEdgeSelection(
    svg,
    canvas.dataset.selectedOccurrenceId || null,
    canvas.dataset.selectedStepId || null,
    canvas.dataset.selectedParallelGroupKey || null,
  );
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
  svg.setAttribute(
    'aria-label',
    canvas.dataset.selectedOccurrenceId !== undefined && canvas.dataset.selectedOccurrenceId !== ''
      ? t('map.edgeLegend')
      : canvas.dataset.selectedParallelGroupKey !== undefined && canvas.dataset.selectedParallelGroupKey !== ''
        ? t('map.parallelEdgeLegend')
      : canvas.dataset.selectedStepId !== undefined && canvas.dataset.selectedStepId !== ''
        ? t('map.stepEdgeLegend')
        : t('map.observedPath'),
  );
  let disposed = false;
  const update = () => {
    if (!disposed) {
      updateParallelGroups(groups, canvas);
      updateExecutionMapGeometry(svg, canvas, trace);
    }
  };
  // renderExecutionMap returns a detached section and the caller attaches it
  // afterwards. Re-measure on the next frame so the first visible paths use
  // the browser's transformed DOM rectangles, not the detached zero rects.
  update();
  if (typeof window !== 'undefined') {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(update);
    else queueMicrotask(update);
  }
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
  const groups = parallelGroups(nodes, trace.parallelGroups ?? []);
  const presentationParallelGroupOrdinals = new Map(
    groups.flatMap((group) => group.iterations.map((iteration) => [iteration.key, iteration.ordinal])),
  );
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
  const selectionLegend = renderSelectionLegend(
    options.selectedOccurrenceId ?? null,
    options.selectedStepId ?? null,
    options.selectedParallelGroupKey ?? null,
    selectionRolesFromRelations(
      visibleEdgeRelations(trace),
      options.selectedOccurrenceId ?? null,
      options.selectedStepId ?? null,
      options.selectedParallelGroupKey ?? null,
    ),
  );
  if (selectionLegend !== null) mapHeader.append(selectionLegend);
  section.append(mapHeader);

  const map = element('div', 'execution-map');
  map.id = 'execution-map';
  map.setAttribute('role', 'group');
  map.setAttribute('aria-label', t('map.ariaLabel'));
  map.setAttribute('aria-description', t('map.panHint'));
  map.dataset.panHint = t('map.panHint');
  map.dataset.iterationSelected = String(
    options.selectedOccurrenceId !== null || options.selectedParallelGroupKey !== null,
  );
  executionMapHeaders.set(map, mapHeader);
  const canvas = element('div', 'execution-map-canvas');
  const scale = clampMapScale(options.scale === undefined ? DEFAULT_MAP_SCALE : options.scale);
  canvas.dataset.layoutWidth = String(layout.width);
  canvas.dataset.layoutHeight = String(layout.height);
  canvas.dataset.scale = String(scale);
  canvas.dataset.selectedOccurrenceId = options.selectedOccurrenceId ?? '';
  canvas.dataset.selectedStepId = options.selectedStepId ?? '';
  canvas.dataset.selectedParallelGroupKey = options.selectedParallelGroupKey ?? '';
  canvas.style.setProperty('width', `${layout.width}px`);
  canvas.style.setProperty('height', `${layout.height}px`);
  canvas.style.setProperty('transform', `scale(${scale})`);
  canvas.style.setProperty('transform-origin', '0 0');
  for (const group of groups) {
    canvas.append(renderParallelGroup(
      group,
      options.selectedParallelGroupKey ?? null,
      options.onSelectParallelGroup,
    ));
  }
  for (const node of nodes) {
    const renderedStep = renderStep(
      node,
      layout.positions.get(node.id) ?? { x: 28, y: 28 },
      options.selectedStepId,
      options.selectedOccurrenceId,
      options.selectedParallelGroupKey ?? null,
      presentationParallelGroupOrdinals,
      options.onSelectStep,
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
  updateExecutionMapSelection(
    map,
    options.selectedOccurrenceId ?? null,
    options.selectedStepId ?? null,
    options.selectedParallelGroupKey ?? null,
  );
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
    const map = section.querySelectorAll('.execution-map')[0];
    if (map !== undefined) executionMapHeaders.delete(map);
  }
}

export function updateExecutionMapSelection(
  container,
  selectedOccurrenceId,
  selectedStepId = null,
  selectedParallelGroupKey = null,
) {
  container.dataset.iterationSelected = String(
    selectedOccurrenceId !== null || selectedParallelGroupKey !== null,
  );
  const canvas = container.querySelectorAll('.execution-map-canvas')[0];
  if (canvas !== undefined) {
    canvas.dataset.selectedOccurrenceId = selectedOccurrenceId ?? '';
    canvas.dataset.selectedStepId = selectedStepId ?? '';
    canvas.dataset.selectedParallelGroupKey = selectedParallelGroupKey ?? '';
  }
  for (const step of container.querySelectorAll('.execution-step')) {
    const selectedStep = selectedStepId !== null
      && selectedOccurrenceId === null
      && step.dataset.stepId === selectedStepId;
    const selectedOccurrence = [...step.querySelectorAll('[data-occurrence-id]')]
      .some((button) => button.dataset.occurrenceId === selectedOccurrenceId
        || selectedParallelGroupKey !== null
          && button.dataset.parallelGroupKey === selectedParallelGroupKey);
    step.dataset.selected = String(selectedStep);
    step.dataset.active = String(selectedOccurrence);
    const header = step.querySelectorAll('.execution-step-header')[0];
    if (header !== undefined) header.setAttribute('aria-pressed', String(selectedStep));
  }
  for (const chip of container.querySelectorAll('[data-occurrence-id]')) {
    const parallelGroupKey = chip.dataset.parallelGroupKey ?? '';
    const hidden = selectedParallelGroupKey !== null
      && parallelGroupKey !== ''
      && parallelGroupKey !== selectedParallelGroupKey;
    chip.hidden = hidden;
    const selected = chip.dataset.occurrenceId === selectedOccurrenceId
      || selectedParallelGroupKey !== null
        && parallelGroupKey === selectedParallelGroupKey;
    chip.dataset.selected = String(selected);
    chip.setAttribute('aria-pressed', String(selected));
  }
  for (const button of container.querySelectorAll('.execution-parallel-iteration')) {
    const selected = button.dataset.parallelGroupKey === selectedParallelGroupKey;
    button.dataset.selected = String(selected);
    button.setAttribute('aria-selected', String(selected));
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const group of container.querySelectorAll('.execution-parallel-group')) {
    const selected = [...group.querySelectorAll('.execution-parallel-iteration')]
      .some((button) => button.dataset.parallelGroupKey === selectedParallelGroupKey);
    group.dataset.selected = String(selected);
  }
  const overlay = container.querySelectorAll('.execution-edge-overlay')[0];
  if (overlay !== undefined) {
    applyEdgeSelection(overlay, selectedOccurrenceId, selectedStepId, selectedParallelGroupKey);
    overlay.setAttribute(
      'aria-label',
      selectedOccurrenceId === null
        ? selectedParallelGroupKey !== null
          ? t('map.parallelEdgeLegend')
          : selectedStepId === null ? t('map.observedPath') : t('map.stepEdgeLegend')
        : t('map.edgeLegend'),
    );
  }
  const header = executionMapHeaders.get(container) ?? container.querySelectorAll('.execution-map-header')[0];
  if (header !== undefined) {
    const roles = selectionRolesFromEdges(
      container.querySelectorAll('[data-edge]'),
      selectedOccurrenceId,
      selectedStepId,
      selectedParallelGroupKey,
    );
    replaceSelectionLegend(header, selectedOccurrenceId, selectedStepId, selectedParallelGroupKey, roles);
  }
}
