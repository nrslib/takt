import {
  buildExecutionTrace,
  reportDirectory,
  reportDisplayName,
  workflowDisplayName,
} from './execution-model.js';
import {
  DEFAULT_MAP_SCALE,
  disposeExecutionMap,
  parallelGroupPresentationOrdinal,
  renderExecutionMap,
  updateExecutionMapSelection,
} from './execution-map.js';
import { renderTaskNavigator } from './task-navigator.js';
import { getLocale, t } from './i18n.js';
import { renderMarkdown } from './markdown-view.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocale() === 'en' ? 'en-US' : 'ja-JP');
}

function statusBadge(status) {
  return element('span', `status-badge status-${status}`, t(`app.status.${status}`));
}

function liveStateLabel(state) {
  const key = {
    connecting: 'app.statusConnecting',
    live: 'app.live',
    paused: 'app.manualRefresh',
    reconnecting: 'app.statusReconnecting',
  }[state];
  return key === undefined ? state : t(key);
}

function runKey(selection) {
  return `${selection.projectId}:${selection.slug}`;
}

function eventTitle(event) {
  const location = [workflowDisplayName(event.workflow, getLocale()), event.step, event.phaseName].filter(Boolean).join(' / ');
  return location === '' ? event.type : `${location} · ${event.type}`;
}

function renderEmpty(title, body) {
  const empty = element('div', 'workspace-empty');
  empty.append(element('strong', '', title), element('span', '', body));
  return empty;
}

function renderLogPreview(occurrence) {
  const panel = element('article', 'log-preview');
  const header = element('header', 'log-event-header');
  header.append(
    element('strong', '', t('viewer.historyPreview')),
    element('span', 'log-preview-badge', t('viewer.liveTailOutside')),
  );
  panel.append(header, element('pre', '', occurrence.preview));
  if (occurrence.previewTruncated === true) {
    panel.append(element('p', 'log-preview-note', t('viewer.previewTruncated')));
  }
  return panel;
}

function renderArtifactWarnings(detail, trace) {
  const warnings = [
    ...(Array.isArray(detail.warnings) ? detail.warnings : []),
    ...(detail.historyTruncated === true ? [t('viewer.historyLimited')] : []),
    ...(trace.graphTruncated ? [t('viewer.summaryCapped', { count: trace.graphOccurrenceCount })] : []),
  ];
  if (warnings.length === 0) return null;
  const panel = element('aside', 'run-artifact-warning');
  panel.setAttribute('role', 'status');
  panel.append(
    element('strong', '', t('viewer.dataSummarized')),
    element('p', '', warnings.join(' ')),
  );
  return panel;
}

function findOccurrence(trace, occurrenceId) {
  for (const node of trace.nodes) {
    const occurrence = node.occurrences.find((candidate) => candidate.id === occurrenceId);
    if (occurrence !== undefined) return { node, occurrence };
  }
  return null;
}

function findStep(trace, stepId) {
  return trace.nodes.find((node) => node.id === stepId) ?? null;
}

function latestParallelGroup(trace) {
  return [...(trace.parallelGroups ?? [])]
    .filter((group) => typeof group?.key === 'string' && group.key !== '')
    .sort((left, right) => (
      left.firstEventIndex - right.firstEventIndex
      || left.ordinal - right.ordinal
      || left.key.localeCompare(right.key)
    ))
    .at(-1) ?? null;
}

function validRuleIndex(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function occurrenceResultIndex(occurrence, outcome) {
  return validRuleIndex(outcome?.matchedRuleIndex)
    ?? validRuleIndex(occurrence?.matchedRuleIndex);
}

function occurrenceResultValue(occurrence, outcome) {
  return outcome?.returnValue ?? occurrence?.returnValue;
}

function occurrenceJudgeStages(occurrence, outcome) {
  const stages = Array.isArray(outcome?.judgeStages)
    ? outcome.judgeStages
    : Array.isArray(occurrence?.judgeStages) ? occurrence.judgeStages : [];
  return stages.filter((stage) => stage !== null && typeof stage === 'object');
}

function observedTransitionLabel(trace, occurrence) {
  const relation = trace.transitions.find((candidate) => candidate.source === occurrence.id);
  if (relation === undefined) return undefined;
  const target = findOccurrence(trace, relation.target);
  if (target === null) return undefined;
  const targetOrdinal = target.occurrence.presentationOrdinal === undefined
    ? ''
    : ` · ${t('map.iter', { number: target.occurrence.presentationOrdinal })}`;
  return `${target.node.displayLabel ?? target.node.label}${targetOrdinal}`;
}

function executionTargetLabel(occurrence) {
  const target = [occurrence.provider, occurrence.model].filter(Boolean).join(' / ');
  return target === '' ? undefined : target;
}

export function resolveLogSelection(trace, selectedOccurrenceId) {
  if (selectedOccurrenceId === null) {
    return { events: trace.events, occurrence: null, historyPreview: false, scope: 'run' };
  }
  const selected = findOccurrence(trace, selectedOccurrenceId);
  if (selected === null) {
    return {
      events: trace.events,
      occurrence: null,
      historyPreview: false,
      scope: 'run',
    };
  }
  const indexes = new Set(selected.occurrence.eventIndexes);
  const events = trace.events.filter((_event, index) => indexes.has(index));
  return {
    events,
    occurrence: selected.occurrence,
    historyPreview: events.length === 0 && selected.occurrence.preview !== undefined,
    scope: 'iteration',
  };
}

export function createExecutionView(options) {
  let activeRunKey = '';
  let activeTab = 'live';
  let selectedStepId = null;
  let selectedOccurrenceId = null;
  let selectedParallelGroupKey = null;
  let selectedParallelGroupFamilyKey = null;
  let selectedParallelGroupIteration = null;
  let parallelSelectionInitialized = false;
  let selectedReport = '';
  let currentDetail = null;
  let currentTrace = null;
  let liveState = 'connecting';
  let followLog = true;
  let taskList = [];
  let taskSelection = null;
  let customNodePositions = new Map();
  let mapScale = DEFAULT_MAP_SCALE;
  let occurrenceArtifactGeneration = 0;
  let occurrenceArtifactAbortController = null;
  let occurrenceArtifactReleaseLiveRun = null;
  let focusRevision = 0;
  let occurrenceArtifacts = {
    key: null,
    status: 'idle',
    reports: [],
    prompts: [],
    promptsTruncated: false,
    omittedPromptCount: 0,
    outcome: null,
    error: null,
  };

  const focusRoot = options.inspector ?? options.runDetail;
  const focusObserver = () => {
    focusRevision += 1;
  };
  const focusObserverTarget = typeof document !== 'undefined'
    && typeof document.addEventListener === 'function'
    ? document
    : focusRoot;
  focusObserverTarget?.addEventListener?.('focusin', focusObserver);

  function documentActiveElement() {
    return typeof document === 'undefined' ? null : document.activeElement ?? null;
  }

  function focusKey(node) {
    if (node === null || node === undefined) return null;
    const role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
    const id = node.id ?? (typeof node.getAttribute === 'function' ? node.getAttribute('id') : null);
    if (role === 'tab' && typeof id === 'string' && id !== '') {
      return { kind: 'tab', value: id };
    }
    const reportFilename = node.dataset?.reportFilename;
    if (typeof reportFilename === 'string' && reportFilename !== '') {
      return { kind: 'report', value: reportFilename };
    }
    const promptIndex = node.dataset?.promptIndex;
    if (typeof promptIndex === 'string' && promptIndex !== '') {
      return { kind: 'prompt', value: promptIndex };
    }
    const parallelGroupKey = node.dataset?.parallelGroupKey;
    if (typeof parallelGroupKey === 'string' && parallelGroupKey !== '') {
      return { kind: 'parallel-group', value: parallelGroupKey };
    }
    if (typeof id === 'string' && id !== '') return { kind: 'id', value: id };
    return null;
  }

  function captureFocusState() {
    const active = documentActiveElement();
    if (active === null || !focusRoot?.contains?.(active)) return null;
    const key = focusKey(active);
    return key === null ? null : { element: active, key, revision: focusRevision };
  }

  function focusTargetForKey(key) {
    if (key.kind === 'tab') {
      return [...focusRoot?.querySelectorAll?.('[role="tab"]') ?? []]
        .find((node) => (node.id ?? node.getAttribute?.('id')) === key.value) ?? null;
    }
    if (key.kind === 'report') {
      return [...focusRoot?.querySelectorAll?.('[data-report-filename]') ?? []]
        .find((node) => node.dataset?.reportFilename === key.value) ?? null;
    }
    if (key.kind === 'prompt') {
      return [...focusRoot?.querySelectorAll?.('[data-prompt-index]') ?? []]
        .find((node) => node.dataset?.promptIndex === key.value) ?? null;
    }
    if (key.kind === 'parallel-group') {
      return [...focusRoot?.querySelectorAll?.('[data-parallel-group-key]') ?? []]
        .find((node) => node.dataset?.parallelGroupKey === key.value) ?? null;
    }
    return null;
  }

  function restoreFocusState(state) {
    if (state === null || focusRevision !== state.revision) return;
    const active = documentActiveElement();
    // Replacing the Inspector subtree normally moves focus to the document
    // body.  That is not a user navigation event; the focusin revision above
    // lets us distinguish it from a user moving focus elsewhere while the
    // subtree was being rebuilt.
    if (active !== null
      && active !== state.element
      && focusRoot?.contains?.(active)) return;
    const target = focusTargetForKey(state.key);
    if (target !== null && typeof target.focus === 'function') target.focus();
  }

  function resetOccurrenceArtifacts() {
    occurrenceArtifactAbortController?.abort();
    occurrenceArtifactAbortController = null;
    if (typeof occurrenceArtifactReleaseLiveRun === 'function') occurrenceArtifactReleaseLiveRun();
    occurrenceArtifactReleaseLiveRun = null;
    occurrenceArtifactGeneration += 1;
    occurrenceArtifacts = {
      key: null,
      status: 'idle',
      reports: [],
      prompts: [],
      promptsTruncated: false,
      omittedPromptCount: 0,
      outcome: null,
      error: null,
    };
    selectedReport = '';
  }

  function currentOccurrenceArtifactKey() {
    return selectedOccurrenceId === null || activeRunKey === ''
      ? null
      : `${activeRunKey}:${selectedOccurrenceId}`;
  }

  function occurrenceArtifactState() {
    const key = currentOccurrenceArtifactKey();
    return key !== null && occurrenceArtifacts.key === key
      ? occurrenceArtifacts
      : {
          key,
          status: 'idle',
          reports: [],
          prompts: [],
          promptsTruncated: false,
          omittedPromptCount: 0,
          outcome: null,
          error: null,
        };
  }

  function requestOccurrenceArtifacts() {
    const key = currentOccurrenceArtifactKey();
    const occurrenceId = selectedOccurrenceId;
    const detail = currentDetail;
    if (key === null || occurrenceId === null || detail === null) return;
    if (typeof options.getOccurrenceArtifacts !== 'function') return;
    if (occurrenceArtifacts.key === key && occurrenceArtifacts.status !== 'idle') return;
    const generation = ++occurrenceArtifactGeneration;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    occurrenceArtifactAbortController = controller;
    occurrenceArtifacts = {
      key,
      status: 'loading',
      reports: [],
      prompts: [],
      promptsTruncated: false,
      omittedPromptCount: 0,
      outcome: null,
      error: null,
    };
    renderInspectorPanel();
    const releaseLiveRun = options.onOccurrenceArtifactsStart?.(
      detail.project.id,
      detail.meta.runSlug,
    );
    occurrenceArtifactReleaseLiveRun = releaseLiveRun;
    Promise.resolve()
      .then(() => options.getOccurrenceArtifacts(
        detail.project.id,
        detail.meta.runSlug,
        occurrenceId,
        controller?.signal,
      ))
      .then((result) => {
        if (generation !== occurrenceArtifactGeneration || currentOccurrenceArtifactKey() !== key) return;
        const reports = Array.isArray(result?.reports)
          ? result.reports.filter((report) => report !== null && typeof report === 'object'
            && typeof report.filename === 'string')
          : [];
        const prompts = Array.isArray(result?.prompts)
          ? result.prompts.filter((prompt) => prompt !== null && typeof prompt === 'object')
          : [];
        const omittedPromptCount = Number.isSafeInteger(result?.omittedPromptCount)
          && result.omittedPromptCount >= 0
          ? result.omittedPromptCount
          : 0;
        const outcome = result?.outcome !== null && typeof result?.outcome === 'object'
          ? result.outcome
          : null;
        occurrenceArtifacts = {
          key,
          status: 'ready',
          reports,
          prompts,
          promptsTruncated: result?.promptsTruncated === true && omittedPromptCount > 0,
          omittedPromptCount,
          outcome,
          error: null,
        };
        renderInspectorPanel();
      })
      .catch((error) => {
        if (generation !== occurrenceArtifactGeneration || currentOccurrenceArtifactKey() !== key) return;
        occurrenceArtifacts = {
          key,
          status: 'error',
          reports: [],
          prompts: [],
          promptsTruncated: false,
          omittedPromptCount: 0,
          outcome: null,
          error: error instanceof Error ? error.message : String(error),
        };
        renderInspectorPanel();
      })
      .finally(() => {
        if (occurrenceArtifactAbortController === controller) {
          occurrenceArtifactAbortController = null;
          occurrenceArtifactReleaseLiveRun = null;
        }
        if (typeof releaseLiveRun === 'function') releaseLiveRun();
      });
  }

  function renderTaskList(tasks, selection) {
    taskList = tasks;
    taskSelection = selection;
    renderTaskNavigator({
      container: options.runList,
      empty: options.runListEmpty,
      count: options.taskCount,
      tasks,
      selection,
      onSelectRun: options.onSelectRun,
      onAction: options.onAction,
      onRequeue: options.onRequeue,
    });
  }

  function liveIndicator() {
    return element('span', `live-state live-state-${liveState}`, liveStateLabel(liveState));
  }

  function renderTrace(trace, meta) {
    const section = renderExecutionMap(trace, {
      liveIndicator: liveIndicator(),
      emptyState: renderEmpty(t('viewer.waitingForExecution'), t('viewer.firstStepDescription')),
      selectedStepId,
      selectedOccurrenceId,
      selectedParallelGroupKey,
      onSelectStep: selectStep,
      onSelectOccurrence: selectOccurrence,
      onSelectParallelGroup: selectParallelGroup,
      customNodePositions,
      onMoveNode(nodeId, position) {
        customNodePositions = new Map(customNodePositions).set(nodeId, position);
      },
      scale: mapScale,
      onScaleChange(scale) {
        mapScale = scale;
      },
    });
    if (meta.reason !== undefined) section.append(element('p', 'run-reason', meta.reason));
    return section;
  }

  function renderLogPanel(trace) {
    const panel = element('section', 'detail-panel log-panel');
    const toolbar = element('div', 'detail-toolbar');
    const selection = resolveLogSelection(trace, selectedOccurrenceId);
    const { events } = selection;
    const scopeLabel = t(`viewer.${selection.scope}Scope`);
    const summary = element(
      'span',
      'detail-toolbar-summary',
      selection.historyPreview
        ? `${scopeLabel} · ${t('viewer.historyPreview')}`
        : `${scopeLabel} · ${t('viewer.events', { count: events.length })}`
          + (selection.scope === 'run' ? '' : ` · ${t('viewer.eventsFocused')}`),
    );
    const follow = element('button', 'toolbar-button', followLog ? t('viewer.following') : t('viewer.followLatest'));
    follow.type = 'button';
    follow.setAttribute('aria-pressed', String(followLog));
    follow.addEventListener('click', () => {
      followLog = !followLog;
      renderDetailPanel();
    });
    toolbar.append(summary);
    if (!selection.historyPreview) toolbar.append(follow);
    panel.append(toolbar);
    if (events.length === 0) {
      if (selection.historyPreview && selection.occurrence !== null) {
        panel.append(renderLogPreview(selection.occurrence));
        return panel;
      }
      panel.append(renderEmpty(t('viewer.logsEmpty'), t('viewer.logsEmptyDescription')));
      return panel;
    }
    const list = element('ol', 'log-events');
    for (const event of events) {
      const item = element('li', 'log-event');
      const header = element('header', 'log-event-header');
      header.append(
        element('strong', '', eventTitle(event)),
        element('time', '', formatDate(event.timestamp)),
      );
      item.append(header);
      const result = event.error ?? event.reason ?? event.content;
      if (event.status !== undefined) item.append(element('span', 'log-event-status', t(`app.status.${event.status}`)));
      if (result !== undefined) item.append(element('pre', '', result));
      list.append(item);
    }
    panel.append(list);
    return panel;
  }

  function renderReportsPanel(reports) {
    const panel = element('section', 'detail-panel reports-panel');
    if (reports.length === 0) {
      panel.append(renderEmpty(t('viewer.reportsEmpty'), t('viewer.reportsEmptyDescription')));
      return panel;
    }
    const selected = reports.find((report) => report.filename === selectedReport) ?? reports[0];
    selectedReport = selected.filename;
    const list = element('nav', 'report-list');
    list.setAttribute('aria-label', t('viewer.reportList'));
    for (const report of reports) {
      const button = element('button', 'report-list-item');
      button.type = 'button';
      button.dataset.selected = String(report.filename === selected.filename);
      button.dataset.reportFilename = report.filename;
      button.addEventListener('click', () => {
        selectedReport = report.filename;
        renderDetailPanel();
      });
      button.append(
        element('strong', '', reportDisplayName(report.filename)),
        element('span', '', reportDirectory(report.filename) || t('viewer.reportFile')),
      );
      list.append(button);
    }
    const viewer = element('article', 'report-viewer');
    const header = element('header', 'report-viewer-header');
    header.append(
      element('h3', '', reportDisplayName(selected.filename)),
      element('span', '', selected.filename),
    );
    viewer.append(
      header,
      element('pre', '', selected.omitted ? t('viewer.reportOmitted') : selected.content),
    );
    panel.append(list, viewer);
    return panel;
  }

  function renderPromptLimitNotice(state) {
    if (state.promptsTruncated !== true
      || !Number.isSafeInteger(state.omittedPromptCount)
      || state.omittedPromptCount <= 0) return null;
    const notice = element(
      'p',
      'artifact-limit-notice',
      t('viewer.promptsTruncated', { count: state.omittedPromptCount }),
    );
    notice.setAttribute('role', 'status');
    return notice;
  }

  function renderOccurrenceArtifactState(kind) {
    const panel = element('section', `detail-panel ${kind === 'reports' ? 'reports-panel' : 'prompts-panel'}`);
    const state = occurrenceArtifactState();
    if (state.status === 'loading') {
      panel.append(renderEmpty(t('viewer.artifactsLoading'), t('viewer.artifactsLoadingDescription')));
      return panel;
    }
    if (state.status === 'error') {
      panel.append(renderEmpty(t('viewer.artifactsError'), state.error ?? t('viewer.artifactsErrorDescription')));
      return panel;
    }
    if (kind === 'reports') {
      if (state.reports.length === 0) {
        panel.append(renderEmpty(t('viewer.iterationReportsEmpty'), t('viewer.iterationReportsEmptyDescription')));
        return panel;
      }
      return renderReportsPanel(state.reports);
    }
    const limitNotice = renderPromptLimitNotice(state);
    if (state.prompts.length === 0) {
      if (limitNotice !== null) panel.append(limitNotice);
      panel.append(renderEmpty(t('viewer.iterationPromptsEmpty'), t('viewer.iterationPromptsEmptyDescription')));
      return panel;
    }
    const list = element('div', 'prompt-list');
    for (const [index, prompt] of state.prompts.entries()) {
      const card = element('article', 'prompt-card');
      card.tabIndex = 0;
      const heading = element('header', 'prompt-card-header');
      const phase = prompt.phaseName
        ?? (prompt.phase === undefined ? t('viewer.promptPhaseUnknown') : t('viewer.promptPhase', { number: prompt.phase }));
      heading.append(element('h3', '', phase));
      if (prompt.timestamp !== undefined) heading.append(element('time', '', formatDate(prompt.timestamp)));
      if (prompt.phaseExecutionId !== undefined) {
        heading.append(element('span', 'prompt-phase-id', prompt.phaseExecutionId));
      }
      card.append(heading);
      if (prompt.systemPrompt !== undefined) {
        const system = element('section', 'prompt-section');
        system.append(element('h4', '', t('viewer.systemPrompt')), element('pre', '', prompt.systemPrompt));
        card.append(system);
      }
      if (prompt.userInstruction !== undefined) {
        const user = element('section', 'prompt-section');
        user.append(element('h4', '', t('viewer.userInstruction')), element('pre', '', prompt.userInstruction));
        card.append(user);
      }
      if (prompt.instruction !== undefined) {
        const instruction = element('section', 'prompt-section');
        instruction.append(element('h4', '', t('viewer.phaseInstruction')), element('pre', '', prompt.instruction));
        card.append(instruction);
      }
      card.dataset.promptIndex = String(index);
      list.append(card);
    }
    panel.append(...(limitNotice === null ? [] : [limitNotice]), list);
    return panel;
  }

  function renderTaskPanel(meta) {
    const panel = element('section', 'detail-panel task-panel');
    panel.append(renderMarkdown(meta.task));
    return panel;
  }

  function renderTabs(detail, trace) {
    const container = element('section', 'detail-tabs');
    const tabs = element('div', 'tab-list');
    tabs.setAttribute('role', 'tablist');
    const logLabel = selectedOccurrenceId !== null
      ? t('viewer.iterationLog')
      : t('viewer.runLog');
    const definitions = selectedOccurrenceId !== null
      ? [
          ['live', logLabel],
          ['reports', t('viewer.iterationReports')],
          ['prompts', t('viewer.prompts')],
        ]
      : [
          ['live', logLabel],
          ...(selectedStepId === null
            ? [['reports', t('viewer.runReports')], ['task', t('viewer.runTask')]]
            : []),
        ];
    if (!definitions.some(([id]) => id === activeTab)) activeTab = 'live';
    for (const [id, label] of definitions) {
      const button = element('button', 'tab-button', label);
      button.type = 'button';
      button.id = `run-tab-${id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'run-tab-panel');
      button.setAttribute('aria-selected', String(activeTab === id));
      button.tabIndex = activeTab === id ? 0 : -1;
      button.addEventListener('click', () => {
        activeTab = id;
        renderInspectorPanel();
      });
      button.addEventListener('keydown', (event) => {
        const index = definitions.findIndex(([definitionId]) => definitionId === id);
        let nextIndex = index;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % definitions.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + definitions.length) % definitions.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = definitions.length - 1;
        else return;
        event.preventDefault();
        activeTab = definitions[nextIndex][0];
        renderInspectorPanel();
        (options.inspector ?? options.runDetail).querySelector('[role="tab"][aria-selected="true"]')?.focus();
      });
      tabs.append(button);
    }
    container.append(tabs);
    let panel;
    if (activeTab === 'reports') {
      panel = selectedOccurrenceId === null
        ? renderReportsPanel(detail.reports)
        : renderOccurrenceArtifactState('reports');
    }
    else if (activeTab === 'prompts') panel = renderOccurrenceArtifactState('prompts');
    else if (activeTab === 'task') panel = renderTaskPanel(detail.meta);
    else panel = renderLogPanel(trace);
    panel.id = 'run-tab-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `run-tab-${activeTab}`);
    container.append(panel);
    return container;
  }

  function captureViewState() {
    const map = options.runDetail.querySelector('.execution-map');
    const inspector = options.inspector ?? options.runDetail;
    const logs = inspector.querySelector('.log-events');
    return {
      detailScrollTop: options.runDetail.scrollTop,
      mapScrollLeft: map?.scrollLeft ?? 0,
      mapScrollTop: map?.scrollTop ?? 0,
      logScrollTop: logs?.scrollTop ?? 0,
      inspectorScrollTop: inspector.scrollTop ?? 0,
    };
  }

  function restoreViewState(state) {
    options.runDetail.scrollTop = state.detailScrollTop;
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) {
      map.scrollLeft = state.mapScrollLeft;
      map.scrollTop = state.mapScrollTop;
    }
    const logs = (options.inspector ?? options.runDetail).querySelector('.log-events');
    if (logs !== null) logs.scrollTop = followLog ? logs.scrollHeight : state.logScrollTop;
    const inspector = options.inspector;
    if (inspector !== undefined && inspector !== null) inspector.scrollTop = state.inspectorScrollTop ?? 0;
  }

  function renderDetailPanel() {
    if (currentDetail === null || currentTrace === null) return;
    const tabs = (options.inspector ?? options.runDetail).querySelector('.detail-tabs');
    if (tabs === null) return;
    const state = captureViewState();
    const focus = captureFocusState();
    tabs.replaceWith(renderTabs(currentDetail, currentTrace));
    restoreViewState(state);
    restoreFocusState(focus);
  }

  function renderInspectorPanel() {
    if (currentDetail === null || currentTrace === null || options.inspector === undefined) {
      renderDetailPanel();
      return;
    }
    const state = captureViewState();
    const focus = captureFocusState();
    options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
    restoreViewState(state);
    restoreFocusState(focus);
  }

  function renderRunSummary(detail) {
    const summary = element('section', 'inspector-run-summary');
    const heading = element('div', 'inspector-run-heading');
    heading.append(
      element('span', 'section-kicker', t('viewer.inspector')),
      element('span', 'scope-label', t('viewer.runScope')),
      statusBadge(detail.meta.status),
    );
    const facts = element('dl', 'run-facts');
    const entries = [
      [t('viewer.current'), detail.meta.currentStep ?? t('viewer.waiting')],
      [t('viewer.iteration'), detail.meta.currentIteration === undefined ? '—' : String(detail.meta.currentIteration)],
      [t('viewer.updated'), formatDate(detail.meta.updatedAt)],
    ];
    for (const [label, value] of entries) {
      const fact = element('div', 'run-fact');
      fact.append(element('dt', '', label), element('dd', '', value));
      facts.append(fact);
    }
    summary.append(heading, facts);
    if (detail.prUrl !== undefined) {
      const link = element('a', 'pr-link', t('viewer.openPullRequest'));
      link.href = detail.prUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      summary.append(link);
    }
    return summary;
  }

  function renderStepSummary(trace) {
    const selected = findStep(trace, selectedStepId);
    if (selected === null || selectedOccurrenceId !== null) return null;
    const latest = selected.occurrences.at(-1);
    if (latest === undefined) return null;
    const summary = element('section', 'inspector-run-summary inspector-step-summary');
    const heading = element('div', 'inspector-run-heading');
    heading.append(
      element('span', 'section-kicker', t('viewer.stepInspector')),
      element('span', 'scope-label', t('viewer.stepScope')),
      element('strong', 'inspector-selection-title', selected.displayLabel ?? selected.label),
      statusBadge(latest.status),
    );
    const phases = [...new Set(selected.occurrences.flatMap((occurrence) => occurrence.phases))];
    const personas = [...new Set(selected.occurrences.flatMap((occurrence) => occurrence.personas))];
    const entries = [
      [t('viewer.stepOccurrences'), String(selected.occurrences.length)],
      [t('viewer.phase'), phases.join(' / ') || '—'],
      [t('viewer.persona'), personas.join(' / ') || '—'],
    ];
    const facts = element('dl', 'run-facts');
    for (const [label, value] of entries) {
      const fact = element('div', 'run-fact');
      fact.append(element('dt', '', label), element('dd', '', value));
      facts.append(fact);
    }
    const iterationList = element('div', 'inspector-iteration-list');
    iterationList.append(element('h4', 'inspector-iteration-list-heading', t('viewer.stepIterations')));
    for (const [index, occurrence] of selected.occurrences.entries()) {
      const ordinal = occurrence.presentationOrdinal ?? index + 1;
      const item = element('button', 'inspector-iteration-item');
      item.type = 'button';
      item.dataset.kind = 'iteration';
      item.dataset.occurrenceId = occurrence.id;
      item.dataset.selected = 'false';
      item.setAttribute('aria-pressed', 'false');
      const resultIndex = validRuleIndex(occurrence.matchedRuleIndex);
      const resultLabel = resultIndex === undefined
        ? t(`app.status.${occurrence.status}`)
        : t('map.result', { number: resultIndex + 1 });
      const label = `${selected.displayLabel ?? selected.label} · ${t('map.iteration', { number: ordinal })} · ${resultLabel}`;
      item.setAttribute('aria-label', label);
      item.title = label;
      item.append(
        element('span', 'inspector-iteration-item-label', t('map.iter', { number: ordinal })),
        resultIndex === undefined
          ? statusBadge(occurrence.status)
          : element('span', 'iteration-chip-result', resultLabel),
      );
      item.addEventListener('click', () => selectOccurrence(selected, occurrence));
      iterationList.append(item);
    }
    const clear = element('button', 'toolbar-button inspector-clear-selection', t('viewer.backToRun'));
    clear.type = 'button';
    clear.addEventListener('click', () => selectOccurrence(null, null));
    summary.append(heading, facts, iterationList, clear);
    return summary;
  }

  function renderParallelGroupSummary(trace) {
    const selectedGroup = trace.parallelGroups?.find(
      (group) => group.key === selectedParallelGroupKey,
    );
    if (selectedGroup === undefined) return null;
    const parentOccurrenceIds = new Set(selectedGroup.parentOccurrenceIds ?? []);
    const children = (selectedGroup.participantOccurrenceIds ?? selectedGroup.occurrenceIds)
      .map((occurrenceId) => findOccurrence(trace, occurrenceId))
      .filter(Boolean)
      .filter(({ node, occurrence }) => !parentOccurrenceIds.has(occurrence.id)
        && !(occurrence.stack?.at(-1)?.kind === 'parallel' && node.label === occurrence.stack.at(-1)?.step))
      .sort((left, right) => left.occurrence.firstEventIndex - right.occurrence.firstEventIndex);
    const summary = element('section', 'inspector-run-summary inspector-parallel-summary');
    const heading = element('div', 'inspector-run-heading');
    const presentationOrdinal = parallelGroupPresentationOrdinal(trace, selectedParallelGroupKey);
    const iterationLabel = presentationOrdinal === undefined
      ? t('map.parallelMember')
      : t('map.iter', { number: presentationOrdinal });
    heading.append(
      element('span', 'section-kicker', t('viewer.parallelInspector')),
      element('span', 'scope-label', t('viewer.parallelScope')),
      element('strong', 'inspector-selection-title', `${t('map.parallel', { step: selectedGroup.label ?? '—' })} · ${iterationLabel}`),
    );
    const facts = element('dl', 'run-facts inspector-parallel-facts');
    for (const [label, value] of [[t('viewer.parallelChildren'), String(children.length)]]) {
      const fact = element('div', 'run-fact');
      fact.append(element('dt', '', label), element('dd', '', value));
      facts.append(fact);
    }
    const list = element('div', 'inspector-parallel-children');
    list.append(element('h4', 'inspector-iteration-list-heading', t('viewer.parallelChildResults')));
    for (const { node, occurrence } of children) {
      const item = element('button', 'inspector-parallel-child');
      item.type = 'button';
      item.dataset.occurrenceId = occurrence.id;
      const resultIndex = validRuleIndex(occurrence.matchedRuleIndex);
      const result = resultIndex === undefined
        ? t(`app.status.${occurrence.status}`)
        : t('map.result', { number: resultIndex + 1 });
      const label = `${node.displayLabel ?? node.label} · ${result}`;
      item.setAttribute('aria-label', t('viewer.selectParallelChild', { child: label }));
      item.append(
        element('strong', '', node.displayLabel ?? node.label),
        resultIndex === undefined ? statusBadge(occurrence.status) : element('span', 'iteration-chip-result', result),
      );
      item.addEventListener('click', () => selectParallelChild(node, occurrence));
      list.append(item);
    }
    const clear = element('button', 'toolbar-button inspector-clear-selection', t('viewer.backToRun'));
    clear.type = 'button';
    clear.addEventListener('click', clearParallelGroupSelection);
    summary.append(heading, facts, list, clear);
    return summary;
  }

  function renderIterationSummary(trace, parallelGroup = null) {
    const selected = findOccurrence(trace, selectedOccurrenceId);
    if (selected === null) return null;
    const isParallelChild = parallelGroup !== null;
    const artifacts = occurrenceArtifactState();
    const outcome = artifacts.outcome;
    const resultIndex = occurrenceResultIndex(selected.occurrence, outcome);
    const returnValue = occurrenceResultValue(selected.occurrence, outcome);
    const observedTransition = observedTransitionLabel(trace, selected.occurrence);
    const stages = occurrenceJudgeStages(selected.occurrence, outcome);
    const occurrenceIndex = selected.node.occurrences.findIndex(
      (candidate) => candidate.id === selected.occurrence.id,
    );
    const ordinal = selected.occurrence.presentationOrdinal ?? occurrenceIndex + 1;
    const summary = element('section', 'inspector-run-summary inspector-iteration-summary');
    const heading = element('div', 'inspector-run-heading');
    heading.append(
      element('span', 'section-kicker', t(isParallelChild ? 'viewer.parallelInspector' : 'viewer.iterationInspector')),
      element('span', 'scope-label', t(isParallelChild ? 'viewer.parallelScope' : 'viewer.iterationScope')),
      element(
        'strong',
        'inspector-selection-title',
        isParallelChild
          ? `${t('map.parallel', { step: parallelGroup.label ?? '—' })} · ${t('map.iter', { number: parallelGroup.ordinal })} · ${selected.node.displayLabel ?? selected.node.label}`
          : `${selected.node.displayLabel ?? selected.node.label} · ${t('map.iter', { number: ordinal })}`,
      ),
      statusBadge(selected.occurrence.status),
    );
    const resultLabel = resultIndex === undefined
      ? returnValue === undefined ? t('viewer.resultUnknown') : `${t('viewer.returnValue')}: ${returnValue}`
      : t('map.result', { number: resultIndex + 1 });
    const transitionLabel = outcome?.nextStep === undefined
      ? observedTransition ?? t('viewer.transitionUnknown')
      : observedTransition === undefined
        ? outcome.nextStep
        : `${outcome.nextStep} · ${t('viewer.observedTransition')}: ${observedTransition}`;
    const entries = [
      ...(isParallelChild ? [] : [
        [t('viewer.execution'), String(ordinal)],
        [t('viewer.iteration'), selected.occurrence.iteration === undefined
          ? '—'
          : String(selected.occurrence.iteration)],
      ]),
      [t('viewer.phase'), selected.occurrence.phases.join(' / ') || '—'],
      [t('viewer.persona'), selected.occurrence.personas.join(' / ') || '—'],
      [t('viewer.result'), resultLabel],
      [t('viewer.condition'), outcome?.condition ?? t('viewer.conditionUnknown')],
      [t('viewer.transition'), transitionLabel],
    ];
    const executionTarget = executionTargetLabel(selected.occurrence);
    if (executionTarget !== undefined) entries.push([t('viewer.executionTarget'), executionTarget]);
    if (selected.occurrence.providerSource !== undefined) {
      entries.push([t('viewer.providerSource'), selected.occurrence.providerSource]);
    }
    if (selected.occurrence.modelSource !== undefined) {
      entries.push([t('viewer.modelSource'), selected.occurrence.modelSource]);
    }
    if (selected.occurrence.matchedRuleMethod !== undefined) {
      entries.push([t('viewer.judgeMethod'), selected.occurrence.matchedRuleMethod]);
    }
    if (selected.occurrence.matchMethod !== undefined) {
      entries.push([t('viewer.matchMethod'), selected.occurrence.matchMethod]);
    }
    const facts = element('dl', 'run-facts inspector-iteration-facts');
    for (const [label, value] of entries) {
      const fact = element('div', 'run-fact');
      fact.append(element('dt', '', label), element('dd', '', value));
      facts.append(fact);
    }
    const clear = element(
      'button',
      'toolbar-button inspector-clear-selection',
      t(isParallelChild ? 'viewer.backToParallel' : 'viewer.backToStep'),
    );
    clear.type = 'button';
    clear.addEventListener('click', isParallelChild ? clearParallelChildSelection : clearIterationSelection);
    summary.append(heading, facts);
    if (outcome?.outputPreview !== undefined) {
      const output = element('section', 'inspector-iteration-output');
      output.append(
        element('h4', 'inspector-iteration-subheading', t('viewer.output')),
        element('pre', 'inspector-iteration-output-content', outcome.outputPreview),
      );
      summary.append(output);
    }
    const judgePanel = element('section', 'inspector-judge-panel');
    judgePanel.append(
      element('h4', 'inspector-iteration-subheading', t('viewer.judgePath')),
      element('p', 'inspector-judge-description', t('viewer.judgePathDescription')),
    );
    if (stages.length === 0) {
      judgePanel.append(element('p', 'inspector-judge-empty', t('viewer.judgeStagesEmpty')));
    } else {
      const stageList = element('ol', 'inspector-judge-stages');
      for (const stage of stages) {
        const stageItem = element('li', 'inspector-judge-stage');
        stageItem.append(
          element('strong', '', t('viewer.judgeStage', { number: stage.stage })),
          element('span', '', `${stage.method} · ${stage.status}`),
        );
        if (stage.response !== undefined && stage.response !== '') {
          stageItem.append(element('pre', 'inspector-judge-response', stage.response));
        }
        stageList.append(stageItem);
      }
      judgePanel.append(stageList);
    }
    summary.append(judgePanel, clear);
    return summary;
  }

  function renderParallelChildSummary(trace) {
    if (selectedParallelGroupKey === null || selectedOccurrenceId === null) return null;
    const group = trace.parallelGroups?.find((candidate) => candidate.key === selectedParallelGroupKey);
    const selected = findOccurrence(trace, selectedOccurrenceId);
    if (group === undefined || selected === null
      || selected.occurrence.parallelGroupKey !== selectedParallelGroupKey) return null;
    return renderIterationSummary(trace, {
      ...group,
      ordinal: parallelGroupPresentationOrdinal(trace, selectedParallelGroupKey) ?? group.ordinal,
    });
  }

  function renderInspector(detail, trace) {
    const inspector = element('section', 'inspector-content');
    const back = element('button', 'mobile-inspector-back', t('viewer.backToGraph'));
    back.type = 'button';
    back.addEventListener('click', () => {
      const screen = options.inspector?.closest?.('.viewer-screen');
      if (screen !== null && screen !== undefined) screen.dataset.mobileView = 'detail';
    });
    if (selectedParallelGroupKey !== null) {
      if (selectedOccurrenceId !== null) {
        const childSummary = renderParallelChildSummary(trace);
        inspector.append(back, childSummary ?? renderParallelGroupSummary(trace) ?? renderRunSummary(detail));
        if (childSummary !== null) inspector.append(renderTabs(detail, trace));
      } else {
        inspector.append(back, renderParallelGroupSummary(trace) ?? renderRunSummary(detail));
      }
      return inspector;
    }
    if (selectedStepId !== null && selectedOccurrenceId === null) {
      inspector.append(back, renderStepSummary(trace) ?? renderRunSummary(detail));
      return inspector;
    }
    const selectionSummary = selectedOccurrenceId === null
      ? renderRunSummary(detail)
      : renderIterationSummary(trace);
    inspector.append(back, selectionSummary ?? renderRunSummary(detail));
    inspector.append(renderTabs(detail, trace));
    return inspector;
  }

  function selectStep(node) {
    selectedStepId = node.id;
    selectedOccurrenceId = null;
    selectedParallelGroupKey = null;
    selectedParallelGroupFamilyKey = null;
    selectedParallelGroupIteration = null;
    parallelSelectionInitialized = true;
    resetOccurrenceArtifacts();
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) updateExecutionMapSelection(map, null, selectedStepId);
    if (currentDetail !== null && currentTrace !== null && options.inspector !== undefined) {
      const state = captureViewState();
      const focus = captureFocusState();
      options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
      restoreViewState({ ...state, inspectorScrollTop: 0 });
      restoreFocusState(focus);
    } else {
      renderDetailPanel();
    }
  }

  function clearIterationSelection() {
    selectedOccurrenceId = null;
    selectedParallelGroupKey = null;
    selectedParallelGroupFamilyKey = null;
    selectedParallelGroupIteration = null;
    parallelSelectionInitialized = true;
    resetOccurrenceArtifacts();
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) updateExecutionMapSelection(map, null, selectedStepId);
    if (currentDetail !== null && currentTrace !== null && options.inspector !== undefined) {
      const state = captureViewState();
      const focus = captureFocusState();
      options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
      restoreViewState({ ...state, inspectorScrollTop: 0 });
      restoreFocusState(focus);
    } else {
      renderDetailPanel();
    }
  }

  function selectOccurrence(node, occurrence) {
    if (occurrence?.parallelGroupKey !== undefined
      && selectedParallelGroupKey === occurrence.parallelGroupKey) {
      selectParallelChild(node, occurrence);
      return;
    }
    const nextOccurrenceId = occurrence?.id ?? null;
    const changed = selectedOccurrenceId !== nextOccurrenceId || selectedStepId !== (node?.id ?? null);
    selectedStepId = node?.id ?? null;
    selectedOccurrenceId = nextOccurrenceId;
    selectedParallelGroupKey = null;
    selectedParallelGroupFamilyKey = null;
    selectedParallelGroupIteration = null;
    parallelSelectionInitialized = true;
    if (changed) resetOccurrenceArtifacts();
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) updateExecutionMapSelection(map, selectedOccurrenceId, selectedStepId);
    if (currentDetail !== null && currentTrace !== null && options.inspector !== undefined) {
      const state = captureViewState();
      const focus = captureFocusState();
      options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
      restoreViewState({ ...state, inspectorScrollTop: 0 });
      restoreFocusState(focus);
    } else {
      renderDetailPanel();
    }
    if (selectedOccurrenceId !== null) requestOccurrenceArtifacts();
  }

  function selectParallelChild(_node, occurrence) {
    if (selectedParallelGroupKey === null
      || occurrence?.parallelGroupKey !== selectedParallelGroupKey) return;
    const nextOccurrenceId = occurrence.id;
    const changed = selectedOccurrenceId !== nextOccurrenceId || selectedStepId !== null;
    selectedStepId = null;
    selectedOccurrenceId = nextOccurrenceId;
    parallelSelectionInitialized = true;
    if (changed) resetOccurrenceArtifacts();
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) {
      updateExecutionMapSelection(map, selectedOccurrenceId, null, selectedParallelGroupKey);
    }
    if (currentDetail !== null && currentTrace !== null && options.inspector !== undefined) {
      const state = captureViewState();
      const focus = captureFocusState();
      options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
      restoreViewState({ ...state, inspectorScrollTop: 0 });
      restoreFocusState(focus);
    } else {
      renderDetailPanel();
    }
    requestOccurrenceArtifacts();
  }

  function clearParallelChildSelection() {
    selectedOccurrenceId = null;
    selectedStepId = null;
    parallelSelectionInitialized = true;
    resetOccurrenceArtifacts();
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) updateExecutionMapSelection(map, null, null, selectedParallelGroupKey);
    if (currentDetail !== null && currentTrace !== null && options.inspector !== undefined) {
      const state = captureViewState();
      const focus = captureFocusState();
      options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
      restoreViewState({ ...state, inspectorScrollTop: 0 });
      restoreFocusState(focus);
    } else {
      renderDetailPanel();
    }
  }

  function selectParallelGroup(_group, iteration) {
    const nextKey = iteration?.key ?? null;
    if (nextKey === null) return;
    const changed = selectedParallelGroupKey !== nextKey
      || selectedOccurrenceId !== null
      || selectedStepId !== null;
    selectedParallelGroupKey = nextKey;
    selectedParallelGroupFamilyKey = iteration?.familyKey ?? null;
    selectedParallelGroupIteration = Number.isSafeInteger(iteration?.iteration)
      ? iteration.iteration
      : null;
    selectedOccurrenceId = null;
    selectedStepId = null;
    parallelSelectionInitialized = true;
    if (changed) resetOccurrenceArtifacts();
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) updateExecutionMapSelection(map, null, null, selectedParallelGroupKey);
    if (currentDetail !== null && currentTrace !== null && options.inspector !== undefined) {
      const state = captureViewState();
      const focus = captureFocusState();
      options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
      restoreViewState({ ...state, inspectorScrollTop: 0 });
      restoreFocusState(focus);
    } else {
      renderDetailPanel();
    }
  }

  function clearParallelGroupSelection() {
    selectedParallelGroupKey = null;
    selectedParallelGroupFamilyKey = null;
    selectedParallelGroupIteration = null;
    parallelSelectionInitialized = true;
    resetOccurrenceArtifacts();
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) updateExecutionMapSelection(map, null, null, null);
    if (currentDetail !== null && currentTrace !== null && options.inspector !== undefined) {
      const state = captureViewState();
      const focus = captureFocusState();
      options.inspector.replaceChildren(renderInspector(currentDetail, currentTrace));
      restoreViewState({ ...state, inspectorScrollTop: 0 });
      restoreFocusState(focus);
    } else {
      renderDetailPanel();
    }
  }

  function renderDetail(detail, selection) {
    if (detail === null || selection === null) return false;
    if (detail.project.id !== selection.projectId || detail.meta.runSlug !== selection.slug) return false;
    const nextRunKey = runKey(selection);
    const sameRun = nextRunKey === activeRunKey;
    const detailChanged = currentDetail !== detail;
    const state = sameRun ? captureViewState() : null;
    const focus = sameRun ? captureFocusState() : null;
    if (!sameRun) {
      activeRunKey = nextRunKey;
      activeTab = detail.meta.status === 'completed' && detail.reports.length > 0 ? 'reports' : 'live';
      selectedStepId = null;
      selectedOccurrenceId = null;
      selectedParallelGroupKey = null;
      selectedParallelGroupFamilyKey = null;
      selectedParallelGroupIteration = null;
      parallelSelectionInitialized = false;
      selectedReport = '';
      customNodePositions = new Map();
      mapScale = DEFAULT_MAP_SCALE;
      resetOccurrenceArtifacts();
    }
    currentDetail = detail;
    const trace = buildExecutionTrace(detail.meta, detail.events, detail.history, detail.graphSummary, getLocale());
    if (selectedStepId !== null && findStep(trace, selectedStepId) === null) {
      selectedStepId = null;
      selectedOccurrenceId = null;
      resetOccurrenceArtifacts();
    }
    if (sameRun && selectedOccurrenceId !== null && findOccurrence(trace, selectedOccurrenceId) === null) {
      selectedOccurrenceId = null;
      resetOccurrenceArtifacts();
    }
    if (sameRun && selectedParallelGroupKey !== null) {
      const exactGroup = trace.parallelGroups?.find((group) => group.key === selectedParallelGroupKey);
      if (exactGroup !== undefined) {
        selectedParallelGroupFamilyKey = exactGroup.familyKey ?? selectedParallelGroupFamilyKey;
        selectedParallelGroupIteration = exactGroup.iteration ?? selectedParallelGroupIteration;
      } else {
        const candidates = trace.parallelGroups?.filter((group) => (
          group.familyKey === selectedParallelGroupFamilyKey
          && group.iteration === selectedParallelGroupIteration
        )) ?? [];
        if (candidates.length === 1) {
          selectedParallelGroupKey = candidates[0].key;
        } else {
          selectedParallelGroupKey = null;
          selectedParallelGroupFamilyKey = null;
          selectedParallelGroupIteration = null;
          parallelSelectionInitialized = true;
        }
      }
    }
    if (selectedParallelGroupKey === null
      && selectedOccurrenceId === null
      && selectedStepId === null
      && !parallelSelectionInitialized) {
      const defaultGroup = latestParallelGroup(trace);
      if (defaultGroup !== null) {
        selectedParallelGroupKey = defaultGroup.key;
        selectedParallelGroupFamilyKey = defaultGroup.familyKey ?? null;
        selectedParallelGroupIteration = defaultGroup.iteration ?? null;
        parallelSelectionInitialized = true;
      }
    }
    if (selectedOccurrenceId !== null && selectedStepId === null && selectedParallelGroupKey === null) {
      selectedStepId = findOccurrence(trace, selectedOccurrenceId)?.node.id ?? null;
    }
    currentTrace = trace;
    const title = element('div', 'run-detail-title');
    const displayWorkflow = workflowDisplayName(detail.meta.workflow, getLocale());
    const workflowHeading = element('h2', '', displayWorkflow);
    if (displayWorkflow !== detail.meta.workflow) workflowHeading.title = detail.meta.workflow;
    title.append(
      workflowHeading,
      element('p', '', `${detail.project.displayName} / ${detail.meta.runSlug}`),
    );
    const taskDisclosure = element('details', 'run-task-disclosure');
    taskDisclosure.dataset.scope = 'run';
    const taskSummary = element('summary', 'run-task-summary');
    taskSummary.append(
      element('span', '', t('viewer.taskInstruction')),
      element('span', 'scope-label', t('viewer.runScope')),
    );
    taskDisclosure.append(
      taskSummary,
      renderMarkdown(detail.meta.task),
    );
    title.append(taskDisclosure);
    const header = element('header', 'run-detail-header');
    header.append(title);
    const warning = renderArtifactWarnings(detail, trace);
    disposeExecutionMap(options.runDetail);
    options.runDetail.replaceChildren(
      header,
      ...(warning === null ? [] : [warning]),
      renderTrace(trace, detail.meta),
    );
    if (options.inspector !== undefined && options.inspector !== null) {
      options.inspector.replaceChildren(renderInspector(detail, trace));
    } else {
      options.runDetail.append(renderInspector(detail, trace));
    }
    if (state !== null) restoreViewState(state);
    else restoreViewState({ detailScrollTop: 0, mapScrollLeft: 0, mapScrollTop: 0, logScrollTop: 0, inspectorScrollTop: 0 });
    restoreFocusState(focus);
    options.onStatusChange(detail.meta.status);
    if (detailChanged && selectedOccurrenceId !== null) requestOccurrenceArtifacts();
    return true;
  }

  function renderPlaceholder() {
    activeRunKey = '';
    currentDetail = null;
    currentTrace = null;
    selectedStepId = null;
    selectedOccurrenceId = null;
    selectedParallelGroupKey = null;
    selectedParallelGroupFamilyKey = null;
    selectedParallelGroupIteration = null;
    parallelSelectionInitialized = false;
    resetOccurrenceArtifacts();
    mapScale = DEFAULT_MAP_SCALE;
    disposeExecutionMap(options.runDetail);
    options.runDetail.replaceChildren(renderEmpty(
      t('viewer.noRun'),
      t('viewer.noRunDescription'),
    ));
    options.inspector?.replaceChildren(renderEmpty(t('viewer.noRun'), t('viewer.noRunDescription')));
  }

  function prepareRunSelection(selection) {
    if (runKey(selection) === activeRunKey) return;
    // Invalidate the old occurrence request before the new run's detail or
    // SSE snapshot arrives. This prevents a delayed response for the old run
    // from keeping its reports visible while the new run is loading.
    renderPlaceholder();
  }

  return {
    renderTaskList,
    renderDetail,
    renderPlaceholder,
    prepareRunSelection,
    refreshLocale() {
      renderTaskList(taskList, taskSelection);
      if (currentDetail === null) return;
      const selection = {
        projectId: currentDetail.project.id,
        slug: currentDetail.meta.runSlug,
      };
      renderDetail(currentDetail, selection);
    },
    dispose() {
      disposeExecutionMap(options.runDetail);
      resetOccurrenceArtifacts();
      focusObserverTarget?.removeEventListener?.('focusin', focusObserver);
    },
    setLiveState(state) {
      liveState = state;
      const indicator = options.runDetail.querySelector('.live-state');
      if (indicator !== null) {
        indicator.className = `live-state live-state-${liveState}`;
        indicator.textContent = liveStateLabel(liveState);
      }
    },
  };
}
