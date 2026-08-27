import { t } from './i18n.js';
import { encodeIdPart, parallelGroupDescriptors } from './execution-model.js';

const executionMapDisposers = new WeakMap();
const executionMapHeaders = new WeakMap();
const executionMapGeometryUpdaters = new WeakMap();
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
  return `${t('map.iter', { number: occurrence.presentationOrdinal ?? index + 1 })}${callLabel}`;
}

function renderPort(side, extraClass = '') {
  const classes = ['execution-port', `execution-port-${side}`];
  if (extraClass !== '') classes.push(extraClass);
  const port = element('span', classes.join(' '));
  port.dataset.port = side === 'prev' ? 'PREV' : 'NEXT';
  port.setAttribute('aria-hidden', 'true');
  const anchor = element('span', 'execution-port-anchor');
  anchor.dataset.port = port.dataset.port;
  anchor.setAttribute('aria-hidden', 'true');
  const label = element('span', 'execution-port-label', port.dataset.port);
  label.setAttribute('aria-hidden', 'true');
  port.append(anchor, label);
  return port;
}

function renderParallelCallParticipant(
  participant,
  parallelGroupKey,
  selectedOccurrenceId,
  onSelectOccurrence,
) {
  const anchor = element('span', 'execution-parallel-call-participant');
  anchor.dataset.occurrenceId = participant.occurrenceId;
  anchor.dataset.parallelGroupKey = parallelGroupKey;
  anchor.dataset.kind = 'parallel-call-participant';
  anchor.dataset.interactive = 'true';
  anchor.setAttribute('role', 'button');
  anchor.setAttribute('tabindex', '0');
  const selected = participant.occurrenceId === selectedOccurrenceId;
  anchor.dataset.selected = String(selected);
  anchor.setAttribute('aria-pressed', String(selected));
  const label = t('map.call', { value: participant.label });
  anchor.setAttribute('aria-label', label);
  anchor.title = label;
  anchor.addEventListener('pointerdown', (event) => event.stopPropagation?.());
  anchor.addEventListener('click', (event) => {
    event.stopPropagation?.();
    onSelectOccurrence?.(participant.occurrenceId);
  });
  anchor.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    onSelectOccurrence?.(participant.occurrenceId);
  });
  anchor.append(
    element('span', 'execution-parallel-call-label', label),
    renderPort('prev'),
    renderPort('next'),
  );
  return anchor;
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
  const isParallelParent = isParallelChild
    && occurrence.stack?.at(-1)?.kind === 'parallel'
    && node.label === occurrence.stack.at(-1)?.step;
  const groupSelected = selectedOccurrenceId === null
    && isParallelChild
    && occurrence.parallelGroupKey === selectedParallelGroupKey;
  const selected = occurrence.id === selectedOccurrenceId || groupSelected;
  button.dataset.parallelGroupKey = occurrence.parallelGroupKey ?? '';
  button.dataset.selected = String(selected);
  button.setAttribute('aria-pressed', String(selected));
  const ordinal = occurrence.presentationOrdinal ?? index + 1;
  const callValue = occurrenceCallValue(occurrence);
  const outcomeLabel = occurrenceOutcomeLabel(occurrence);
  const groupOrdinal = isParallelChild
    ? presentationParallelGroupOrdinals.get(occurrence.parallelGroupKey)
    : undefined;
  const groupLabel = groupOrdinal === undefined
    ? t('map.parallelMember')
    : t('map.parallelIteration', { number: groupOrdinal });
  const evidenceLabel = isParallelChild
    ? t(isParallelParent ? 'map.observedBoundary' : 'map.observedParticipant')
    : null;
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
    t('map.prevPort'),
    t('map.nextPort'),
    evidenceLabel,
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
    ...(evidenceLabel === null ? [] : [
      element('span', 'iteration-chip-evidence', evidenceLabel),
    ]),
    renderPort('prev'),
    renderPort('next'),
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
  const candidates = [];
  for (const occurrence of node.occurrences) {
    const stack = occurrence.stack;
    if (!Array.isArray(stack)) continue;
    const descriptors = occurrence.parallelGroupDescriptors
      ?? parallelGroupDescriptors(stack, occurrence.iteration);
    const presentationDescriptors = parallelGroupDescriptors(
      stack,
      occurrence.iteration,
    );
    for (const descriptor of descriptors) {
      // Only the parallel boundary itself and its direct child belong to a
      // group. Deeper workflow_call child steps are represented by the
      // direct call participant (or its normalized branch anchor).
      if (stack.length > descriptor.frameIndex + 2) continue;
      const presentationDescriptor = presentationDescriptors.find(
        (candidate) => candidate.frameIndex === descriptor.frameIndex,
      );
      candidates.push({
        frame: stack[descriptor.frameIndex],
        familyKey: descriptor.familyKey,
        presentationKey: presentationDescriptor?.familyKey ?? descriptor.familyKey,
      });
    }
  }
  return candidates;
}

function parallelGroups(nodes, traceGroups = [], trace) {
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
  // A presentation family may contain multiple recorded ITER batches. The
  // visual frame and its group-drag handle must cover every occurrence-derived
  // member across those batches. Do not fall back to the raw context union:
  // traceGroup.nodeIds has already applied nearest-parallel membership and
  // therefore excludes nested direct participants from the outer group.
  const resolvedNodeIdsByPresentation = new Map();
  for (const traceGroup of traceGroups) {
    if (traceGroup?.familyKey === undefined) continue;
    const presentationKey = presentationByFamily.get(traceGroup.familyKey);
    if (presentationKey === undefined) continue;
    const traceNodeIds = traceGroup.nodeIds ?? [];
    if (traceNodeIds.length === 0) continue;
    const previous = resolvedNodeIdsByPresentation.get(presentationKey) ?? [];
    resolvedNodeIdsByPresentation.set(
      presentationKey,
      [...new Set([...previous, ...traceNodeIds])],
    );
  }
  for (const traceGroup of traceGroups) {
    if (traceGroup?.familyKey === undefined) continue;
    const presentationKey = presentationByFamily.get(traceGroup.familyKey);
    if (presentationKey === undefined) continue;
    const context = groups.get(presentationKey);
    if (context === undefined) continue;
    const previous = context.iterations.find((candidate) => candidate.key === traceGroup.key);
    const callParticipants = trace === undefined
      ? []
      : (traceGroup.participantOccurrenceIds ?? [])
        .map((occurrenceId) => {
          const found = findOccurrence(trace, occurrenceId);
          if (found?.node.kind !== 'workflow') return null;
          const call = trace.calls.find((candidate) => candidate.occurrenceId === occurrenceId);
          const target = call?.targetOccurrenceId === undefined
            ? undefined
            : findOccurrence(trace, call.targetOccurrenceId);
          return {
            occurrenceId,
            label: call?.displayChildWorkflow ?? found.node.displayLabel ?? found.node.label,
            targetOccurrenceId: target?.node.kind === 'step' ? call?.targetOccurrenceId : undefined,
          };
        })
        .filter(Boolean);
    groups.set(presentationKey, {
      ...context,
      // The execution model has already resolved nearest-parallel membership;
      // retain that occurrence-derived node set so nested direct participants
      // do not leak into their outer group's visual frame.
      nodeIds: resolvedNodeIdsByPresentation.get(presentationKey) ?? [],
      iterations: previous === undefined
        ? [...context.iterations, { ...traceGroup, callParticipants }]
        : context.iterations.map((candidate) => candidate.key === traceGroup.key
          ? { ...candidate, ...traceGroup, callParticipants }
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
  return parallelGroups(stepNodes(trace), trace.parallelGroups ?? [], trace)
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
  for (const group of parallelGroups(nodes, trace.parallelGroups ?? [], trace)) {
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

function renderParallelGroup(
  group,
  selectedParallelGroupKey,
  selectedOccurrenceId,
  onSelectParallelGroup,
  onSelectOccurrence,
) {
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
  header.setAttribute('aria-description', t('map.observedParticipants'));
  header.title = t('map.moveParallelGroup', { step: group.label });
  header.append(element('span', 'execution-parallel-evidence', t('map.observedParticipants')));
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
      button.setAttribute(
        'aria-description',
        `${t('map.prevPort')} / ${t('map.nextPort')}`,
      );
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
      button.append(
        ...(iteration.callParticipants ?? [])
          .map((participant) => renderParallelCallParticipant(
            participant,
            iteration.key,
            selectedOccurrenceId,
            onSelectOccurrence,
          )),
        renderPort('prev', 'execution-port-boundary'),
        renderPort('next', 'execution-port-boundary'),
      );
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

function observedTransitionRelations(trace) {
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

function isParallelParentOccurrence(node, occurrence, groupKey) {
  if (occurrence.parallel?.role === 'parent') {
    const parentIndex = occurrence.stack === undefined ? -1 : [...occurrence.stack]
      .findLastIndex((frame) => frame?.kind === 'parallel');
    return parentIndex >= 0 && occurrence.stack?.length === parentIndex + 1;
  }
  if (occurrence.parallel !== undefined || occurrence.parallelLegacyAmbiguous === true) return false;
  const descriptor = groupKey === undefined
    ? undefined
    : parallelGroupDescriptorForOccurrence(occurrence, groupKey);
  if (descriptor !== undefined) {
    return (occurrence.stack?.length ?? 0) === descriptor.frameIndex + 1;
  }
  const frame = occurrence.stack?.at(-1);
  return frame?.kind === 'parallel' && node.label === frame.step;
}

function parallelGroupMembers(trace, group) {
  const occurrences = (group.occurrenceIds ?? [])
    .map((occurrenceId) => findOccurrence(trace, occurrenceId))
    .filter(Boolean);
  const parentIds = new Set(
    group.parentOccurrenceIds
      ?? occurrences
        .filter(({ node, occurrence }) => isParallelParentOccurrence(node, occurrence, group.key))
        .map(({ occurrence }) => occurrence.id),
  );
  const participantIds = group.participantOccurrenceIds === undefined
    ? occurrences
      .filter(({ occurrence }) => {
        const descriptor = parallelGroupDescriptorForOccurrence(occurrence, group.key);
        return descriptor === undefined
          ? !parentIds.has(occurrence.id)
          : (occurrence.stack?.length ?? 0) === descriptor.frameIndex + 2;
      })
      .map(({ occurrence }) => occurrence.id)
    : [...group.participantOccurrenceIds];
  return {
    parentIds,
    participantIds: [...new Set(participantIds)],
  };
}

function parallelGroupDescriptorForOccurrence(occurrence, groupKey) {
  return (occurrence.parallelGroupDescriptors
    ?? parallelGroupDescriptors(occurrence.stack, occurrence.iteration))
    .find((descriptor) => descriptor.key === groupKey);
}

function parallelParticipantAnchor(trace, groupKey, occurrenceId) {
  const participant = findOccurrence(trace, occurrenceId);
  if (participant === null) return {};
  const descriptor = parallelGroupDescriptorForOccurrence(participant.occurrence, groupKey);
  if (descriptor !== undefined && Array.isArray(participant.occurrence.stack)) {
    const nestedFrame = participant.occurrence.stack[descriptor.frameIndex + 1];
    const nestedDescriptor = (participant.occurrence.parallelGroupDescriptors
      ?? parallelGroupDescriptors(
        participant.occurrence.stack,
        participant.occurrence.iteration,
      )).find((candidate) => candidate.frameIndex === descriptor.frameIndex + 1);
    if (nestedFrame?.kind === 'parallel' && nestedDescriptor !== undefined) {
      return { boundaryKey: nestedDescriptor.key };
    }
  }
  if (participant.node.kind === 'workflow') {
    // The call occurrence is the participant boundary. Child workflow steps
    // remain detail data and must never replace the visible PREV/NEXT anchor.
    return { occurrenceId };
  }
  return { occurrenceId };
}

function isNestedParallelGroupTransition(trace, sourceOccurrenceId, targetOccurrenceId) {
  const source = findOccurrence(trace, sourceOccurrenceId);
  const target = findOccurrence(trace, targetOccurrenceId);
  const sourceStack = source?.occurrence.stack;
  const targetStack = target?.occurrence.stack;
  if (!Array.isArray(sourceStack) || !Array.isArray(targetStack)) return false;
  return (sourceStack.length < targetStack.length && isStackPrefix(sourceStack, targetStack))
    || (targetStack.length < sourceStack.length && isStackPrefix(targetStack, sourceStack));
}

function parallelBoundaryRelation(
  transition,
  sourceBoundaryKey,
  targetBoundaryKey,
  trace,
) {
  const source = sourceBoundaryKey === undefined ? findOccurrence(trace, transition.source) : null;
  const target = targetBoundaryKey === undefined ? findOccurrence(trace, transition.target) : null;
  return {
    ...transition,
    source: sourceBoundaryKey === undefined ? transition.source : undefined,
    target: targetBoundaryKey === undefined ? transition.target : undefined,
    sourceStepId: source?.node.id,
    targetStepId: target?.node.id,
    sourceParallelGroupKey: sourceBoundaryKey,
    targetParallelGroupKey: targetBoundaryKey,
    ...(sourceBoundaryKey === undefined ? {} : {
      sourceBoundaryKey,
      sourceBoundary: true,
      sourceBoundaryPort: 'next',
    }),
    ...(targetBoundaryKey === undefined ? {} : {
      targetBoundaryKey,
      targetBoundary: true,
      targetBoundaryPort: 'prev',
    }),
  };
}

function parallelRelationTopology(trace) {
  const groups = (trace.parallelGroups ?? [])
    .filter((group) => (group.nodeIds?.length ?? 0) > 1)
    .map((group) => ({
      ...group,
      members: parallelGroupMembers(trace, group),
    }));
  if (groups.length === 0) return observedTransitionRelations(trace);

  const groupByKey = new Map(groups.map((group) => [group.key, group]));
  const occurrenceGroupKey = (occurrenceId) => {
    if (occurrenceId === undefined) return undefined;
    const groupKey = findOccurrence(trace, occurrenceId)?.occurrence.parallelGroupKey;
    return groupByKey.has(groupKey) ? groupKey : undefined;
  };
  const relations = [];
  const incomingBoundaryKeys = new Set();
  const outgoingBoundaryKeys = new Set();
  const groupBoundaryPairs = new Set();

  for (const transition of observedTransitionRelations(trace)) {
    const sourceGroupKey = occurrenceGroupKey(transition.source);
    const targetGroupKey = occurrenceGroupKey(transition.target);
    if (sourceGroupKey === undefined && targetGroupKey === undefined) {
      relations.push(transition);
      continue;
    }
    // The observed parent -> child -> child -> parent sequence is an
    // implementation detail of a parallel invocation. It must not become a
    // direct child-to-child edge in the presentation graph.
    if (sourceGroupKey !== undefined && sourceGroupKey === targetGroupKey) continue;
    if (sourceGroupKey === undefined && targetGroupKey !== undefined) {
      if (incomingBoundaryKeys.has(targetGroupKey)) continue;
      incomingBoundaryKeys.add(targetGroupKey);
      relations.push(parallelBoundaryRelation(
        transition,
        undefined,
        targetGroupKey,
        trace,
      ));
      continue;
    }
    if (sourceGroupKey !== undefined && targetGroupKey === undefined) {
      if (outgoingBoundaryKeys.has(sourceGroupKey)) continue;
      outgoingBoundaryKeys.add(sourceGroupKey);
      relations.push(parallelBoundaryRelation(
        transition,
        sourceGroupKey,
        undefined,
        trace,
      ));
      continue;
    }
    if (sourceGroupKey !== undefined && targetGroupKey !== undefined) {
      if (sourceGroupKey !== targetGroupKey
        && isNestedParallelGroupTransition(trace, transition.source, transition.target)) {
        // A nested group is the direct participant of its parent. Its own
        // PREV/NEXT boundary is connected by the branch relations below;
        // this observed lifecycle hop must not bypass that fork/join rail.
        continue;
      }
      const pair = `${sourceGroupKey}->${targetGroupKey}`;
      if (groupBoundaryPairs.has(pair)) continue;
      groupBoundaryPairs.add(pair);
      relations.push(parallelBoundaryRelation(
        transition,
        sourceGroupKey,
        targetGroupKey,
        trace,
      ));
    }
  }

  // Add the actual fork and join branches once per observed participant. The
  // boundary chip is the sole source/target for these relations, so no line
  // can accidentally connect two parallel children directly.
  for (const group of groups) {
    for (const occurrenceId of group.members.participantIds) {
      const participant = findOccurrence(trace, occurrenceId);
      if (participant === null) continue;
      const base = {
        kind: 'parallel',
        sourceParallelGroupKey: group.key,
        targetParallelGroupKey: group.key,
      };
      const participantAnchor = parallelParticipantAnchor(trace, group.key, occurrenceId);
      if (participantAnchor.boundaryKey !== undefined) {
        relations.push({
          ...base,
          id: `parallel:fork:${encodeIdPart(group.key)}:${encodeIdPart(occurrenceId)}`,
          source: undefined,
          target: undefined,
          targetParallelGroupKey: participantAnchor.boundaryKey,
          sourceBoundaryKey: group.key,
          targetBoundaryKey: participantAnchor.boundaryKey,
          sourceBoundary: true,
          targetBoundary: true,
          sourceBoundaryPort: 'prev',
          targetBoundaryPort: 'prev',
        });
        relations.push({
          ...base,
          id: `parallel:join:${encodeIdPart(occurrenceId)}:${encodeIdPart(group.key)}`,
          source: undefined,
          target: undefined,
          sourceParallelGroupKey: participantAnchor.boundaryKey,
          targetParallelGroupKey: group.key,
          sourceBoundaryKey: participantAnchor.boundaryKey,
          targetBoundaryKey: group.key,
          sourceBoundary: true,
          targetBoundary: true,
          sourceBoundaryPort: 'next',
          targetBoundaryPort: 'next',
        });
        continue;
      }
      const participantOccurrenceId = participantAnchor.occurrenceId ?? occurrenceId;
      const participantAnchorOccurrence = findOccurrence(trace, participantOccurrenceId);
      relations.push({
        ...base,
        id: `parallel:fork:${encodeIdPart(group.key)}:${encodeIdPart(occurrenceId)}`,
        source: undefined,
        target: participantOccurrenceId,
        ...(participantOccurrenceId === occurrenceId
          ? {}
          : { targetAnchorOccurrenceId: participantOccurrenceId }),
        targetParticipantOccurrenceId: occurrenceId,
        targetStepId: participantAnchorOccurrence?.node.id,
        sourceBoundaryKey: group.key,
        sourceBoundary: true,
        sourceBoundaryPort: 'prev',
      });
      relations.push({
        ...base,
        id: `parallel:join:${encodeIdPart(occurrenceId)}:${encodeIdPart(group.key)}`,
        source: participantOccurrenceId,
        target: undefined,
        ...(participantOccurrenceId === occurrenceId
          ? {}
          : { sourceAnchorOccurrenceId: participantOccurrenceId }),
        sourceParticipantOccurrenceId: occurrenceId,
        sourceStepId: participantAnchorOccurrence?.node.id,
        targetBoundaryKey: group.key,
        targetBoundary: true,
        targetBoundaryPort: 'next',
      });
    }
  }
  return relations;
}

function visibleTransitionRelations(trace) {
  return parallelRelationTopology(trace);
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

function isParallelCallBoundary(trace, call) {
  const callOccurrence = findOccurrence(trace, call.occurrenceId);
  const stack = Array.isArray(call.stack)
    ? call.stack
    : callOccurrence?.occurrence.stack;
  if (!Array.isArray(stack) || stack.length === 0) return false;
  const parallelIndex = [...stack].findLastIndex((frame) => frame?.kind === 'parallel');
  if (parallelIndex < 0 || stack.length !== parallelIndex + 2) return false;
  if (stack[parallelIndex + 1]?.kind !== 'workflow_call') return false;
  const metadata = callOccurrence?.occurrence.parallel;
  return metadata === undefined || metadata.role === 'workflow_call_participant';
}

function callRelation(trace, call) {
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
  };
}

function normalizedCallRelations(trace) {
  return visibleCallRelations(trace)
    .filter((call) => !isParallelCallBoundary(trace, call))
    .filter((call) => call.targetOccurrenceId !== undefined)
    .map((call) => callRelation(trace, call));
}

function visibleEdgeRelations(trace) {
  const transitions = visibleTransitionRelations(trace);
  return [...transitions, ...normalizedCallRelations(trace)];
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
  sourceBoundary = false,
  targetBoundary = false,
  sourceParticipantOccurrenceId,
  targetParticipantOccurrenceId,
) {
  const targetMatches = target === selectedOccurrenceId
    || targetParticipantOccurrenceId === selectedOccurrenceId;
  const sourceMatches = source === selectedOccurrenceId
    || sourceParticipantOccurrenceId === selectedOccurrenceId;
  const incoming = selectedOccurrenceId !== null
    ? targetMatches
      || source !== selectedOccurrenceId
        && targetBoundary
        && targetParallelGroupKey === selectedParallelGroupKey
        && sourceParallelGroupKey !== selectedParallelGroupKey
    : selectedStepId !== null
      ? targetStepId === selectedStepId
      : selectedParallelGroupKey !== null && targetParallelGroupKey === selectedParallelGroupKey;
  const outgoing = selectedOccurrenceId !== null
    ? sourceMatches
      || target !== selectedOccurrenceId
        && sourceBoundary
        && sourceParallelGroupKey === selectedParallelGroupKey
        && targetParallelGroupKey !== selectedParallelGroupKey
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
    return selectedStepId === null && selectedParallelGroupKey !== null
      ? 'map.parallelEdgeIncoming'
      : selectedOccurrenceId === null && selectedStepId !== null
      ? 'map.stepEdgeIncoming'
      : 'map.edgeIncoming';
  }
  if (role === 'outgoing') {
    return selectedStepId === null && selectedParallelGroupKey !== null
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
      path.getAttribute('data-source-boundary') === 'true',
      path.getAttribute('data-target-boundary') === 'true',
      path.getAttribute('data-source-participant-occurrence-id'),
      path.getAttribute('data-target-participant-occurrence-id'),
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
  const incomingLabel = selectedParallelGroupKey !== null && selectedStepId === null
    ? 'map.parallelEdgeIncoming'
    : selectedOccurrenceId === null
      ? 'map.stepEdgeIncoming'
    : 'map.edgeIncoming';
  const outgoingLabel = selectedParallelGroupKey !== null && selectedStepId === null
    ? 'map.parallelEdgeOutgoing'
    : selectedOccurrenceId === null
      ? 'map.stepEdgeOutgoing'
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
      relation.sourceBoundary === true,
      relation.targetBoundary === true,
      relation.sourceParticipantOccurrenceId,
      relation.targetParticipantOccurrenceId,
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
      edge.getAttribute('data-source-boundary') === 'true',
      edge.getAttribute('data-target-boundary') === 'true',
      edge.getAttribute('data-source-participant-occurrence-id'),
      edge.getAttribute('data-target-participant-occurrence-id'),
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

function findParallelBoundaryAnchor(container, groupKey, side) {
  if (typeof groupKey !== 'string' || groupKey === '') return null;
  const button = [...container.querySelectorAll('.execution-parallel-iteration')]
    .find((candidate) => candidate.dataset.parallelGroupKey === groupKey);
  const port = [...(button?.querySelectorAll?.('.execution-port-boundary') ?? [])]
    .find((candidate) => candidate.dataset.port === (side === 'prev' ? 'PREV' : 'NEXT'));
  return port?.querySelector?.('.execution-port-anchor') ?? port ?? button ?? null;
}

function findParallelCallParticipantAnchor(container, occurrenceId, side) {
  if (occurrenceId === undefined) return null;
  const participant = [...container.querySelectorAll('.execution-parallel-call-participant')]
    .find((candidate) => candidate.dataset.occurrenceId === occurrenceId);
  const port = participant?.querySelector?.(`.execution-port-${side}`);
  return port?.querySelector?.('.execution-port-anchor') ?? port ?? participant ?? null;
}

function findRelationAnchor(container, occurrenceId, boundaryKey, side, participantOccurrenceId) {
  if (boundaryKey !== undefined) return findParallelBoundaryAnchor(container, boundaryKey, side);
  const participantAnchor = findParallelCallParticipantAnchor(container, participantOccurrenceId, side);
  return participantAnchor ?? findOccurrenceAnchor(container, occurrenceId);
}

function relationAnchorSide(relation, endpoint) {
  if (endpoint === 'source') return relation.sourceBoundaryPort ?? 'next';
  return relation.targetBoundaryPort ?? 'prev';
}

function directionForSide(side) {
  return {
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    top: { x: 0, y: -1 },
    bottom: { x: 0, y: 1 },
  }[side] ?? { x: 1, y: 0 };
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

function pointAtCenter(anchorRect, canvasRect, scale, side, scrollLeft = 0, scrollTop = 0) {
  return {
    x: ((anchorRect.left + anchorRect.right) / 2 - canvasRect.left) / scale + scrollLeft,
    y: ((anchorRect.top + anchorRect.bottom) / 2 - canvasRect.top) / scale + scrollTop,
    side,
  };
}

export function edgeAnchorGeometry(
  sourceRect,
  targetRect,
  canvasRect,
  scale = 1,
  _forceLoopPorts = false,
  portRects,
) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    source: portRects?.source === undefined
      ? pointOnSide(sourceRect, canvasRect, safeScale, 'right')
      : pointAtCenter(portRects.source, canvasRect, safeScale, 'right'),
    target: portRects?.target === undefined
      ? pointOnSide(targetRect, canvasRect, safeScale, 'left')
      : pointAtCenter(portRects.target, canvasRect, safeScale, 'left'),
  };
}

function usablePortRect(port, anchorRect, isAnchor = false) {
  if (port === null || port === undefined) return undefined;
  const portRect = rectFor(port);
  // The lightweight DOM used by the model tests gives every node the same
  // default rectangle. Treat that as an unmeasured port and retain the chip
  // fallback; real browser port rectangles are intentionally narrower.
  if (portRect.width <= 0 || portRect.height <= 0
    || (!isAnchor && portRect.width === anchorRect.width && portRect.height === anchorRect.height)) {
    return undefined;
  }
  return portRect;
}

function findPort(anchor, side) {
  const expected = side.toUpperCase();
  if (anchor?.dataset?.port === expected) return anchor;
  const port = anchor?.querySelector?.(`.execution-port-${side.toLowerCase()}`);
  return port?.querySelector?.('.execution-port-anchor')
    ?? port
    ?? anchor?.querySelector?.('.execution-port-anchor')
    ?? null;
}

function anchorPoints(sourceAnchor, targetAnchor, canvas, kind, sourceSide = 'next', targetSide = 'prev') {
  const sourceRect = rectFor(sourceAnchor);
  const targetRect = rectFor(targetAnchor);
  const canvasRect = rectFor(canvas);
  const sourcePort = findPort(sourceAnchor, sourceSide);
  const targetPort = findPort(targetAnchor, targetSide);
  const sourcePortRect = usablePortRect(sourcePort, sourceRect, sourcePort === sourceAnchor);
  const targetPortRect = usablePortRect(targetPort, targetRect, targetPort === targetAnchor);
  const sameStep = typeof sourceAnchor?.closest === 'function'
    && sourceAnchor.closest('.execution-step') !== null
    && sourceAnchor.closest('.execution-step') === targetAnchor?.closest?.('.execution-step');
  return edgeAnchorGeometry(
    sourceRect,
    targetRect,
    canvasRect,
    readMapScale(canvas),
    kind === 'loop' && sameStep,
    { source: sourcePortRect, target: targetPortRect },
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
  const sourceSide = relation.sourceBoundaryPort ?? 'next';
  const targetSide = relation.targetBoundaryPort ?? 'prev';
  const { source, target } = anchorPoints(
    sourceAnchor,
    targetAnchor,
    canvas,
    relation.kind,
    sourceSide,
    targetSide,
  );
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
      : relation.kind === 'parallel'
        ? 'map.edgeParallel'
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
  path.setAttribute('data-source-port', relation.sourceBoundaryPort === 'prev' ? 'PREV' : 'NEXT');
  path.setAttribute('data-target-port', relation.targetBoundaryPort === 'next' ? 'NEXT' : 'PREV');
  path.setAttribute('aria-label', label);
  path.setAttribute('data-relation-id', relation.id);
  if (relation.source !== undefined) path.setAttribute('data-source-occurrence-id', relation.source);
  if (relation.target !== undefined) path.setAttribute('data-target-occurrence-id', relation.target);
  if (relation.sourceParticipantOccurrenceId !== undefined) {
    path.setAttribute('data-source-participant-occurrence-id', relation.sourceParticipantOccurrenceId);
  }
  if (relation.targetParticipantOccurrenceId !== undefined) {
    path.setAttribute('data-target-participant-occurrence-id', relation.targetParticipantOccurrenceId);
  }
  if (sourceStepId !== undefined) path.setAttribute('data-source-step-id', sourceStepId);
  if (targetStepId !== undefined) path.setAttribute('data-target-step-id', targetStepId);
  if (relation.sourceParallelGroupKey !== undefined) {
    path.setAttribute('data-source-parallel-group-key', relation.sourceParallelGroupKey);
  }
  if (relation.targetParallelGroupKey !== undefined) {
    path.setAttribute('data-target-parallel-group-key', relation.targetParallelGroupKey);
  }
  if (relation.sourceBoundary === true) path.setAttribute('data-source-boundary', 'true');
  if (relation.targetBoundary === true) path.setAttribute('data-target-boundary', 'true');
  if (relation.targetWorkflow !== undefined) path.setAttribute('data-target-workflow', relation.targetWorkflow);
  const markers = markersForEdgeRole('none');
  path.setAttribute('marker-start', markers.start);
  path.setAttribute('marker-end', markers.end);
  const title = svgElement('title');
  title.textContent = label;
  path.append(title);
  svg.append(path);
}

function relationVisibleForParallelSelection(relation, selectedParallelGroupKey) {
  if (selectedParallelGroupKey === null || selectedParallelGroupKey === '') return true;
  const sourceGroupKey = relation.sourceParallelGroupKey;
  const targetGroupKey = relation.targetParallelGroupKey;
  return (sourceGroupKey === undefined && targetGroupKey === undefined)
    || sourceGroupKey === selectedParallelGroupKey
    || targetGroupKey === selectedParallelGroupKey;
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

  const selectedParallelGroupKey = canvas.dataset.selectedParallelGroupKey || null;
  for (const relation of visibleEdgeRelations(trace)) {
    if (!relationVisibleForParallelSelection(relation, selectedParallelGroupKey)) continue;
    const className = relation.kind === 'loop'
      ? 'execution-edge execution-edge-loop'
      : relation.kind === 'parallel'
        ? 'execution-edge execution-edge-parallel'
        : relation.kind === 'call'
          ? 'execution-edge execution-edge-call'
          : 'execution-edge execution-edge-transition';
    appendEdge(
      svg,
      className,
      relation,
      findRelationAnchor(
        canvas,
        relation.sourceAnchorOccurrenceId ?? relation.source,
        relation.sourceBoundaryKey,
        relationAnchorSide(relation, 'source'),
        relation.sourceParticipantOccurrenceId,
      ),
      findRelationAnchor(
        canvas,
        relation.targetAnchorOccurrenceId ?? relation.target,
        relation.targetBoundaryKey,
        relationAnchorSide(relation, 'target'),
        relation.targetParticipantOccurrenceId,
      ),
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
    canvas.dataset.selectedParallelGroupKey !== undefined
      && canvas.dataset.selectedParallelGroupKey !== ''
      && (canvas.dataset.selectedStepId === undefined || canvas.dataset.selectedStepId === '')
      ? t('map.parallelEdgeLegend')
      : canvas.dataset.selectedOccurrenceId !== undefined && canvas.dataset.selectedOccurrenceId !== ''
        ? t('map.edgeLegend')
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
  executionMapGeometryUpdaters.set(canvas, update);
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
    executionMapGeometryUpdaters.delete(canvas);
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
  const groups = parallelGroups(nodes, trace.parallelGroups ?? [], trace);
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
  const onSelectParallelOccurrence = (occurrenceId) => {
    const selected = findOccurrence(trace, occurrenceId);
    if (selected !== null) options.onSelectOccurrence(selected.node, selected.occurrence);
  };
  for (const group of groups) {
    canvas.append(renderParallelGroup(
      group,
      options.selectedParallelGroupKey ?? null,
      options.selectedOccurrenceId ?? null,
      options.onSelectParallelGroup,
      onSelectParallelOccurrence,
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
          && selectedOccurrenceId === null
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
        && selectedOccurrenceId === null
        && parallelGroupKey === selectedParallelGroupKey;
    chip.dataset.selected = String(selected);
    chip.setAttribute('aria-pressed', String(selected));
  }
  for (const anchor of container.querySelectorAll('.execution-parallel-call-participant')) {
    const selected = anchor.dataset.occurrenceId === selectedOccurrenceId;
    anchor.dataset.selected = String(selected);
    anchor.setAttribute('aria-pressed', String(selected));
  }
  executionMapGeometryUpdaters.get(canvas)?.();
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
      selectedParallelGroupKey !== null && selectedStepId === null
        ? t('map.parallelEdgeLegend')
        : selectedOccurrenceId === null
          ? selectedStepId === null ? t('map.observedPath') : t('map.stepEdgeLegend')
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
