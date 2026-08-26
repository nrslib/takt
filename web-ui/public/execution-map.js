const STATUS_LABELS = {
  running: 'Running',
  completed: 'Completed',
  aborted: 'Aborted',
  failed: 'Failed',
};
const executionMapDisposers = new WeakMap();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusBadge(status) {
  return element('span', `status-badge status-${status}`, STATUS_LABELS[status] ?? status);
}

function occurrenceLabel(occurrence, index) {
  const callFrame = Array.isArray(occurrence.stack)
    ? [...occurrence.stack].reverse().find((frame) => frame.kind === 'workflow_call')
    : undefined;
  const callLabel = occurrence.callInstance === undefined && callFrame === undefined
    ? ''
    : ` · call ${occurrence.callInstance ?? callFrame?.occurrence}`;
  return occurrence.iteration === undefined
    ? `pass ${index + 1}${callLabel}`
    : `#${occurrence.iteration}${callLabel}`;
}

function occurrenceDescription(occurrence, index) {
  const details = [
    occurrenceLabel(occurrence, index),
    occurrence.phases.join(' / '),
    occurrence.personas.join(' / '),
  ].filter(Boolean);
  return details.join(' · ');
}

function renderLaneHeader(lane) {
  const header = element('header', 'workflow-lane-header');
  const marker = element('span', 'workflow-lane-marker', String(lane.depth + 1).padStart(2, '0'));
  marker.setAttribute('aria-hidden', 'true');
  const copy = element('div', 'workflow-lane-copy');
  copy.append(
    element('strong', '', lane.workflow),
    element('span', '', `${lane.steps.length} logical step${lane.steps.length === 1 ? '' : 's'}`),
  );
  header.append(marker, copy);
  return header;
}

function renderIterationChip(node, occurrence, index, selectedOccurrenceId, onSelectOccurrence) {
  const button = element('button', 'iteration-chip');
  button.type = 'button';
  button.dataset.occurrenceId = occurrence.id;
  button.dataset.selected = String(occurrence.id === selectedOccurrenceId);
  button.setAttribute('aria-pressed', String(occurrence.id === selectedOccurrenceId));
  button.setAttribute('aria-label', `${node.label} ${occurrenceDescription(occurrence, index)}`);
  button.title = occurrenceDescription(occurrence, index);
  button.append(
    element('span', 'iteration-chip-label', occurrenceLabel(occurrence, index)),
    element('span', 'iteration-chip-status', STATUS_LABELS[occurrence.status] ?? occurrence.status),
  );
  button.addEventListener('click', () => onSelectOccurrence(node, occurrence));
  return button;
}

function renderStep(node, selectedOccurrenceId, onSelectOccurrence) {
  const step = element('article', `execution-step execution-step-${node.occurrences.at(-1).status}`);
  step.dataset.stepId = node.id;
  step.dataset.repeated = String(node.occurrences.length > 1);
  step.dataset.active = String(node.occurrences.some(
    (occurrence) => occurrence.id === selectedOccurrenceId,
  ));
  const latest = node.occurrences.at(-1);
  const headerButton = element('button', 'execution-step-header');
  headerButton.type = 'button';
  headerButton.dataset.stepId = node.id;
  headerButton.setAttribute('aria-label', `${node.label} の最新の実行を表示`);
  headerButton.append(
    element('span', 'execution-step-index', String(node.firstEventIndex + 1).padStart(2, '0')),
    element('span', 'execution-step-title', node.label),
    statusBadge(latest.status),
  );
  headerButton.addEventListener('click', () => onSelectOccurrence(node, latest));
  const iterations = element('div', 'execution-iterations');
  const iterationHeader = element('div', 'execution-iterations-header');
  iterationHeader.append(
    element('span', '', node.occurrences.length > 1 ? 'Loop passes' : 'Pass'),
    node.occurrences.length > 1
      ? element('span', 'loop-badge', `↻ ${node.occurrences.length}`)
      : element('span', 'loop-badge loop-badge-muted', '1'),
  );
  const chips = element('div', 'iteration-chips');
  node.occurrences.forEach((occurrence, index) => {
    chips.append(renderIterationChip(node, occurrence, index, selectedOccurrenceId, onSelectOccurrence));
  });
  iterations.append(iterationHeader, chips);
  const metadata = [
    node.kind === 'workflow' ? `calls ${node.childWorkflow ?? node.label}` : node.workflow,
    latest.phases.join(' / '),
    latest.personas.join(' / '),
  ].filter(Boolean);
  step.append(headerButton, iterations, element('p', 'execution-step-meta', metadata.join(' · ')));
  return step;
}

function renderLane(lane, selectedOccurrenceId, onSelectOccurrence) {
  const section = element('section', 'workflow-lane');
  section.dataset.workflow = lane.workflow;
  section.style.setProperty('--lane-depth', String(lane.depth));
  const track = element('div', 'workflow-lane-track');
  lane.steps.forEach((node, index) => {
    if (index > 0) {
      const arrow = element('span', 'workflow-step-arrow', '→');
      arrow.setAttribute('aria-hidden', 'true');
      track.append(arrow);
    }
    track.append(renderStep(node, selectedOccurrenceId, onSelectOccurrence));
  });
  section.append(renderLaneHeader(lane), track);
  return section;
}

function renderTransitionSummary(trace) {
  const transitions = trace.transitions.filter((transition) => transition.kind === 'transition');
  if (transitions.length === 0) return null;
  const summary = element('div', 'execution-transition-summary');
  summary.append(element('span', 'execution-transition-label', 'Observed path'));
  const path = element('div', 'execution-transition-path');
  const visible = transitions.slice(0, 8);
  visible.forEach((transition, index) => {
    const source = trace.nodes.find((node) => node.id === transition.sourceLogicalId);
    const target = trace.nodes.find((node) => node.id === transition.targetLogicalId);
    if (source === undefined || target === undefined) return;
    if (index === 0) path.append(element('span', 'transition-path-node', source.label));
    path.append(element('span', 'transition-path-arrow', '→'));
    path.append(element(
      'span',
      'transition-path-node',
      target.label,
    ));
  });
  if (transitions.length > visible.length) {
    path.append(element('span', 'transition-path-more', `+${transitions.length - visible.length}`));
  }
  summary.append(path);
  return summary;
}

function findOccurrence(trace, occurrenceId) {
  for (const node of trace.nodes) {
    const occurrence = node.occurrences.find((candidate) => candidate.id === occurrenceId);
    if (occurrence !== undefined) return { node, occurrence };
  }
  return null;
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
  const x = side === 'right' ? anchorRect.right : anchorRect.left;
  return {
    x: x - canvasRect.left + (canvas.scrollLeft ?? 0),
    y: anchorRect.top - canvasRect.top + (canvas.scrollTop ?? 0) + anchorRect.height / 2,
  };
}

function curvePath(source, target, kind) {
  if (kind === 'loop') {
    const height = Math.max(30, Math.abs(source.x - target.x) * 0.2);
    return `M ${source.x} ${source.y} C ${source.x + 30} ${source.y - height}, ${target.x - 30} ${target.y - height}, ${target.x} ${target.y}`;
  }
  const distance = Math.max(36, Math.abs(target.x - source.x) * 0.45);
  return `M ${source.x} ${source.y} C ${source.x + distance} ${source.y}, ${target.x - distance} ${target.y}, ${target.x} ${target.y}`;
}

function appendEdge(svg, className, relation, sourceAnchor, targetAnchor, canvas) {
  if (sourceAnchor === null || targetAnchor === null) return;
  const source = anchorPoint(sourceAnchor, canvas, 'right');
  const target = anchorPoint(targetAnchor, canvas, 'left');
  const path = svgElement('path');
  path.setAttribute('class', className);
  path.setAttribute('d', curvePath(source, target, relation.kind));
  path.setAttribute('fill', 'none');
  path.setAttribute('data-edge', 'true');
  path.setAttribute('data-relation-id', relation.id);
  path.setAttribute('data-source-occurrence-id', relation.source);
  path.setAttribute('data-target-occurrence-id', relation.target);
  if (relation.targetWorkflow !== undefined) {
    path.setAttribute('data-target-workflow', relation.targetWorkflow);
  }
  path.setAttribute('marker-end', 'url(#execution-edge-arrow)');
  svg.append(path);
}

function updateExecutionMapGeometry(svg, canvas, trace) {
  const canvasRect = rectFor(canvas);
  const width = Math.max(
    canvasRect.width,
    typeof canvas.scrollWidth === 'number' ? canvas.scrollWidth : 0,
    1,
  );
  const height = Math.max(
    canvasRect.height,
    typeof canvas.scrollHeight === 'number' ? canvas.scrollHeight : 0,
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
  for (const loop of trace.loops) {
    appendEdge(
      svg,
      'execution-edge execution-edge-loop',
      { id: loop.id, kind: 'loop', source: loop.from, target: loop.to },
      findOccurrenceAnchor(canvas, loop.from),
      findOccurrenceAnchor(canvas, loop.to),
      canvas,
    );
  }
  for (const call of trace.calls) {
    if (!call.targetObserved || call.targetOccurrenceId === undefined) continue;
    appendEdge(
      svg,
      'execution-edge execution-edge-call',
      {
        id: call.id,
        kind: 'call',
        source: call.occurrenceId,
        target: call.targetOccurrenceId,
        targetWorkflow: call.childWorkflow,
      },
      findOccurrenceAnchor(canvas, call.occurrenceId),
      findOccurrenceAnchor(canvas, call.targetOccurrenceId),
      canvas,
    );
  }
}

function renderRelationOverlay(section, map, canvas, trace) {
  const svg = svgElement('svg');
  svg.setAttribute('class', 'execution-edge-overlay');
  svg.setAttribute('aria-hidden', 'true');
  updateExecutionMapGeometry(svg, canvas, trace);
  let disposed = false;
  const update = () => {
    if (!disposed) updateExecutionMapGeometry(svg, canvas, trace);
  };
  map.addEventListener('scroll', update);
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
  executionMapDisposers.set(section, () => {
    if (disposed) return;
    disposed = true;
    map.removeEventListener('scroll', update);
    observer?.disconnect();
    if (windowResize !== undefined && typeof window !== 'undefined') {
      window.removeEventListener('resize', windowResize);
    }
  });
  return svg;
}

function renderLoopConnector(trace, loop) {
  const source = findOccurrence(trace, loop.from);
  const target = findOccurrence(trace, loop.to);
  if (source === null || target === null) return null;
  const sourceLabel = occurrenceLabel(
    source.occurrence,
    source.node.occurrences.indexOf(source.occurrence),
  );
  const targetLabel = occurrenceLabel(
    target.occurrence,
    target.node.occurrences.indexOf(target.occurrence),
  );
  const connector = element('div', 'execution-loop-connector');
  connector.dataset.loopId = loop.id;
  connector.dataset.sourceOccurrenceId = loop.from;
  connector.dataset.targetOccurrenceId = loop.to;
  connector.setAttribute('data-loop-id', loop.id);
  connector.setAttribute('data-source-occurrence-id', loop.from);
  connector.setAttribute('data-target-occurrence-id', loop.to);
  connector.setAttribute('role', 'img');
  connector.setAttribute(
    'aria-label',
    `${source.node.label} ${sourceLabel} から ${target.node.label} ${targetLabel} へ戻る loop`,
  );
  connector.append(
    element('span', 'execution-relation-glyph', '↶'),
    element('span', 'execution-relation-source', `${source.node.label} ${sourceLabel}`),
    element('span', 'execution-relation-line', 'return'),
    element('span', 'execution-relation-target', `${target.node.label} ${targetLabel}`),
  );
  return connector;
}

function renderCallConnector(trace, call) {
  const source = findOccurrence(trace, call.occurrenceId);
  if (source === null) return null;
  const target = call.targetOccurrenceId === undefined
    ? null
    : findOccurrence(trace, call.targetOccurrenceId);
  const targetLabel = target === null
    ? `${call.childWorkflow} · not observed`
    : `${target.node.label} ${occurrenceLabel(
      target.occurrence,
      target.node.occurrences.indexOf(target.occurrence),
    )}`;
  const connector = element('div', 'execution-call-connector');
  connector.dataset.callId = call.id;
  connector.dataset.sourceOccurrenceId = call.occurrenceId;
  connector.dataset.sourceWorkflow = call.workflow;
  connector.dataset.targetWorkflow = call.childWorkflow;
  connector.dataset.targetOccurrenceId = call.targetOccurrenceId ?? '';
  connector.dataset.targetObserved = String(call.targetObserved === true && target !== null);
  connector.setAttribute('data-call-id', call.id);
  connector.setAttribute('data-source-occurrence-id', call.occurrenceId);
  connector.setAttribute('data-source-workflow', call.workflow);
  connector.setAttribute('data-target-workflow', call.childWorkflow);
  connector.setAttribute('data-target-occurrence-id', call.targetOccurrenceId ?? '');
  connector.setAttribute('data-target-observed', String(call.targetObserved === true && target !== null));
  connector.setAttribute('data-target-lane', call.childWorkflow);
  connector.setAttribute('role', 'img');
  connector.setAttribute(
    'aria-label',
    `${call.workflow} の ${source.node.label} から ${call.childWorkflow} lane を呼び出し`,
  );
  connector.append(
    element('span', 'execution-relation-source', `${call.workflow} · ${source.node.label}`),
    element('span', 'execution-relation-line', 'calls'),
    element('span', 'execution-relation-arrow', '↘'),
    element('span', 'execution-relation-target', targetLabel),
  );
  return connector;
}

function renderObservedRelations(trace) {
  const loops = trace.loops.flatMap((loop) => {
    const connector = renderLoopConnector(trace, loop);
    return connector === null ? [] : [connector];
  });
  const calls = trace.calls.flatMap((call) => {
    const connector = renderCallConnector(trace, call);
    return connector === null ? [] : [connector];
  });
  if (loops.length === 0 && calls.length === 0) return null;
  const relations = element('div', 'execution-map-relations');
  relations.setAttribute('aria-label', '観測された workflow 関係');
  if (loops.length > 0) {
    const loopGroup = element('section', 'execution-relation-group');
    loopGroup.append(element('h4', '', 'Loop returns'), ...loops);
    relations.append(loopGroup);
  }
  if (calls.length > 0) {
    const callGroup = element('section', 'execution-relation-group');
    callGroup.append(element('h4', '', 'Workflow calls'), ...calls);
    relations.append(callGroup);
  }
  return relations;
}

export function renderExecutionMap(trace, options) {
  const section = element('section', 'trace-section execution-map-section');
  const heading = element('div', 'panel-heading');
  const copy = element('div', 'panel-heading-copy');
  copy.append(
    element('h3', '', 'Execution map'),
    element('p', '', '実行イベントから構成した観測済みの workflow map。カード内の ↻ は同じ step の再実行です。'),
  );
  heading.append(copy, options.liveIndicator);
  section.append(heading);
  if (trace.nodes.length === 0) {
    section.append(options.emptyState);
    return section;
  }

  const mapHeader = element('div', 'execution-map-header');
  mapHeader.append(
    element('span', 'execution-map-summary', `${trace.lanes.length} lanes · ${trace.nodes.length} steps · ${trace.totalOccurrences} passes`),
    element('span', 'execution-map-key', '選択すると該当passのログを表示'),
  );
  section.append(mapHeader);

  const map = element('div', 'execution-map');
  map.id = 'execution-map';
  map.setAttribute('role', 'group');
  map.setAttribute('aria-label', '観測済みの実行マップ');
  const canvas = element('div', 'execution-map-canvas');
  for (const lane of trace.lanes) {
    canvas.append(renderLane(lane, options.selectedOccurrenceId, options.onSelectOccurrence));
  }
  const relations = renderObservedRelations(trace);
  if (relations !== null) canvas.append(relations);
  const overlay = renderRelationOverlay(section, map, canvas, trace);
  canvas.append(overlay);
  map.append(canvas);
  section.append(map);
  const transitionSummary = renderTransitionSummary(trace);
  if (transitionSummary !== null) section.append(transitionSummary);
  return section;
}

export function disposeExecutionMap(container) {
  const sections = [];
  if (container?.matches?.('.execution-map-section')) sections.push(container);
  sections.push(...container.querySelectorAll('.execution-map-section'));
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
