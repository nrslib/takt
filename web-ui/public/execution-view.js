import {
  buildExecutionTrace,
  reportDirectory,
  reportDisplayName,
} from './execution-model.js';
import {
  disposeExecutionMap,
  renderExecutionMap,
  updateExecutionMapSelection,
} from './execution-map.js';
import { renderTaskNavigator } from './task-navigator.js';

const STATUS_LABELS = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  aborted: 'Aborted',
  failed: 'Failed',
};
const LIVE_STATE_LABELS = {
  connecting: 'Connecting',
  live: 'Live',
  paused: 'Paused',
  reconnecting: 'Reconnecting',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP');
}

function statusBadge(status) {
  return element('span', `status-badge status-${status}`, STATUS_LABELS[status] ?? status);
}

function runKey(selection) {
  return `${selection.projectId}:${selection.slug}`;
}

function eventTitle(event) {
  const location = [event.workflow, event.step, event.phaseName].filter(Boolean).join(' / ');
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
    element('strong', '', '履歴プレビュー'),
    element('span', 'log-preview-badge', 'live tail外'),
  );
  panel.append(header, element('pre', '', occurrence.preview));
  if (occurrence.previewTruncated === true) {
    panel.append(element('p', 'log-preview-note', '内容は安全上の上限で切り詰められています。'));
  }
  return panel;
}

function renderArtifactWarnings(detail, trace) {
  const warnings = [
    ...(Array.isArray(detail.warnings) ? detail.warnings : []),
    ...(detail.historyTruncated === true ? ['履歴ログは上限件数まで保持しています。'] : []),
    ...(trace.graphTruncated ? [`Graph summary is capped at ${trace.graphOccurrenceCount} occurrences.`] : []),
  ];
  if (warnings.length === 0) return null;
  const panel = element('aside', 'run-artifact-warning');
  panel.setAttribute('role', 'status');
  panel.append(
    element('strong', '', '一部の実行データを要約しています'),
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

function selectionText(trace, selectedOccurrenceId) {
  if (selectedOccurrenceId === null) {
    return 'All events · select a pass to focus the log';
  }
  const selected = findOccurrence(trace, selectedOccurrenceId);
  if (selected === null) return 'All events · select a pass to focus the log';
  const occurrenceIndex = selected.node.occurrences.findIndex(
    (occurrence) => occurrence.id === selected.occurrence.id,
  );
  const pass = selected.occurrence.iteration === undefined
    ? `pass ${occurrenceIndex + 1}`
    : `#${selected.occurrence.iteration}`;
  return `${selected.node.label} · ${pass} · ${STATUS_LABELS[selected.occurrence.status]}`;
}

export function createExecutionView(options) {
  let activeRunKey = '';
  let activeTab = 'live';
  let selectedOccurrenceId = null;
  let selectedReport = '';
  let currentDetail = null;
  let currentTrace = null;
  let liveState = 'connecting';
  let followLog = true;

  function renderTaskList(tasks, selection) {
    renderTaskNavigator({
      container: options.runList,
      empty: options.runListEmpty,
      count: options.taskCount,
      tasks,
      selection,
      onSelectRun: options.onSelectRun,
      onRequeue: options.onRequeue,
    });
  }

  function liveIndicator() {
    return element('span', `live-state live-state-${liveState}`, LIVE_STATE_LABELS[liveState]);
  }

  function renderSelectionSummary(trace) {
    const summary = element('div', 'trace-selection');
    summary.id = 'trace-selection';
    summary.append(
      element('span', 'trace-selection-label', 'Focus'),
      element('strong', '', selectionText(trace, selectedOccurrenceId)),
    );
    if (selectedOccurrenceId !== null && findOccurrence(trace, selectedOccurrenceId) !== null) {
      const clear = element('button', 'toolbar-button', 'Show all');
      clear.type = 'button';
      clear.addEventListener('click', () => selectOccurrence(null, null));
      summary.append(clear);
    }
    return summary;
  }

  function renderTrace(trace, meta) {
    const section = renderExecutionMap(trace, {
      liveIndicator: liveIndicator(),
      emptyState: renderEmpty('実行開始を待っています', '最初のstepが始まるとカードが表示されます。'),
      selectedOccurrenceId,
      onSelectOccurrence: selectOccurrence,
    });
    if (trace.nodes.length > 0) section.append(renderSelectionSummary(trace));
    if (meta.reason !== undefined) section.append(element('p', 'run-reason', meta.reason));
    return section;
  }

  function visibleEvents(trace) {
    if (selectedOccurrenceId === null) return trace.events;
    const selected = findOccurrence(trace, selectedOccurrenceId);
    if (selected === null) return trace.events;
    const indexes = new Set(selected.occurrence.eventIndexes);
    return trace.events.filter((_event, index) => indexes.has(index));
  }

  function renderLogPanel(trace) {
    const panel = element('section', 'detail-panel log-panel');
    const toolbar = element('div', 'detail-toolbar');
    const events = visibleEvents(trace);
    const summary = element(
      'span',
      'detail-toolbar-summary',
      selectedOccurrenceId === null ? `${events.length} events` : `${events.length} events · focused`,
    );
    const follow = element('button', 'toolbar-button', followLog ? 'Following' : 'Follow latest');
    follow.type = 'button';
    follow.setAttribute('aria-pressed', String(followLog));
    follow.addEventListener('click', () => {
      followLog = !followLog;
      renderDetailPanel();
    });
    toolbar.append(summary, follow);
    panel.append(toolbar);
    if (events.length === 0) {
      if (selectedOccurrenceId !== null) {
        const selected = findOccurrence(trace, selectedOccurrenceId);
        if (selected?.occurrence.preview !== undefined) {
          panel.append(renderLogPreview(selected.occurrence));
          return panel;
        }
      }
      panel.append(renderEmpty('ログはまだありません', 'イベントを受信するとここへ追加されます。'));
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
      if (event.status !== undefined) item.append(element('span', 'log-event-status', event.status));
      if (result !== undefined) item.append(element('pre', '', result));
      list.append(item);
    }
    panel.append(list);
    return panel;
  }

  function renderReportsPanel(reports) {
    const panel = element('section', 'detail-panel reports-panel');
    if (reports.length === 0) {
      panel.append(renderEmpty('レポートはまだありません', '生成されたMarkdownはここへ追加されます。'));
      return panel;
    }
    const selected = reports.find((report) => report.filename === selectedReport) ?? reports[0];
    selectedReport = selected.filename;
    const list = element('nav', 'report-list');
    list.setAttribute('aria-label', 'レポート一覧');
    for (const report of reports) {
      const button = element('button', 'report-list-item');
      button.type = 'button';
      button.dataset.selected = String(report.filename === selected.filename);
      button.addEventListener('click', () => {
        selectedReport = report.filename;
        renderDetailPanel();
      });
      button.append(
        element('strong', '', reportDisplayName(report.filename)),
        element('span', '', reportDirectory(report.filename) || 'run report'),
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
      element('pre', '', selected.omitted ? 'ファイルサイズが表示上限を超えています。' : selected.content),
    );
    panel.append(list, viewer);
    return panel;
  }

  function renderTaskPanel(meta) {
    const panel = element('section', 'detail-panel task-panel');
    panel.append(element('pre', '', meta.task));
    return panel;
  }

  function renderTabs(detail, trace) {
    const container = element('section', 'detail-tabs');
    const tabs = element('div', 'tab-list');
    tabs.setAttribute('role', 'tablist');
    const definitions = [
      ['live', 'Live log', trace.events.length],
      ['reports', 'Reports', detail.reports.length],
      ['task', 'Task', null],
    ];
    for (const [id, label, count] of definitions) {
      const button = element('button', 'tab-button', count === null ? label : `${label} ${count}`);
      button.type = 'button';
      button.id = `run-tab-${id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'run-tab-panel');
      button.setAttribute('aria-selected', String(activeTab === id));
      button.tabIndex = activeTab === id ? 0 : -1;
      button.addEventListener('click', () => {
        activeTab = id;
        renderDetailPanel();
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
        renderDetailPanel();
        options.runDetail.querySelector('[role="tab"][aria-selected="true"]')?.focus();
      });
      tabs.append(button);
    }
    container.append(tabs);
    let panel;
    if (activeTab === 'reports') panel = renderReportsPanel(detail.reports);
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
    const logs = options.runDetail.querySelector('.log-events');
    return {
      detailScrollTop: options.runDetail.scrollTop,
      mapScrollLeft: map?.scrollLeft ?? 0,
      mapScrollTop: map?.scrollTop ?? 0,
      logScrollTop: logs?.scrollTop ?? 0,
    };
  }

  function restoreViewState(state) {
    options.runDetail.scrollTop = state.detailScrollTop;
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) {
      map.scrollLeft = state.mapScrollLeft;
      map.scrollTop = state.mapScrollTop;
    }
    const logs = options.runDetail.querySelector('.log-events');
    if (logs !== null) logs.scrollTop = followLog ? logs.scrollHeight : state.logScrollTop;
  }

  function renderDetailPanel() {
    if (currentDetail === null || currentTrace === null) return;
    const tabs = options.runDetail.querySelector('.detail-tabs');
    if (tabs === null) return;
    const state = captureViewState();
    tabs.replaceWith(renderTabs(currentDetail, currentTrace));
    restoreViewState(state);
  }

  function selectOccurrence(_node, occurrence) {
    selectedOccurrenceId = occurrence?.id ?? null;
    activeTab = 'live';
    const map = options.runDetail.querySelector('.execution-map');
    if (map !== null) updateExecutionMapSelection(map, selectedOccurrenceId);
    const summary = options.runDetail.querySelector('#trace-selection');
    if (summary !== null && currentTrace !== null) {
      summary.replaceWith(renderSelectionSummary(currentTrace));
    }
    renderDetailPanel();
  }

  function renderDetail(detail, selection) {
    if (detail === null || selection === null) return false;
    if (detail.project.id !== selection.projectId || detail.meta.runSlug !== selection.slug) return false;
    const nextRunKey = runKey(selection);
    const sameRun = nextRunKey === activeRunKey;
    const state = sameRun ? captureViewState() : null;
    if (!sameRun) {
      activeRunKey = nextRunKey;
      activeTab = detail.meta.status === 'completed' && detail.reports.length > 0 ? 'reports' : 'live';
      selectedOccurrenceId = null;
      selectedReport = '';
    }
    currentDetail = detail;
    const trace = buildExecutionTrace(detail.meta, detail.events, detail.history, detail.graphSummary);
    if (sameRun && selectedOccurrenceId !== null && findOccurrence(trace, selectedOccurrenceId) === null) {
      selectedOccurrenceId = null;
    }
    currentTrace = trace;
    const title = element('div', 'run-detail-title');
    title.append(
      statusBadge(detail.meta.status),
      element('h2', '', detail.meta.workflow),
      element('p', '', `${detail.project.displayName} / ${detail.meta.runSlug}`),
      element('p', 'run-task-summary', detail.meta.task),
    );
    const facts = element('dl', 'run-facts');
    const entries = [
      ['Current', detail.meta.currentStep ?? 'Waiting'],
      ['Iteration', detail.meta.currentIteration === undefined ? '—' : String(detail.meta.currentIteration)],
      ['Updated', formatDate(detail.meta.updatedAt)],
    ];
    for (const [label, value] of entries) {
      const fact = element('div', 'run-fact');
      fact.append(element('dt', '', label), element('dd', '', value));
      facts.append(fact);
    }
    const header = element('header', 'run-detail-header');
    header.append(title, facts);
    if (detail.prUrl !== undefined) {
      const link = element('a', 'pr-link', 'Open pull request');
      link.href = detail.prUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      header.append(link);
    }
    const warning = renderArtifactWarnings(detail, trace);
    disposeExecutionMap(options.runDetail);
    options.runDetail.replaceChildren(
      header,
      ...(warning === null ? [] : [warning]),
      renderTrace(trace, detail.meta),
      renderTabs(detail, trace),
    );
    if (state !== null) restoreViewState(state);
    else restoreViewState({ detailScrollTop: 0, mapScrollLeft: 0, mapScrollTop: 0, logScrollTop: 0 });
    options.onStatusChange(detail.meta.status);
    return true;
  }

  function renderPlaceholder() {
    activeRunKey = '';
    currentDetail = null;
    currentTrace = null;
    selectedOccurrenceId = null;
    disposeExecutionMap(options.runDetail);
    options.runDetail.replaceChildren(renderEmpty(
      'Run を選択',
      'タスクからrunを選ぶと、実行マップと成果物を確認できます。',
    ));
  }

  return {
    renderTaskList,
    renderDetail,
    renderPlaceholder,
    dispose() {
      disposeExecutionMap(options.runDetail);
    },
    setLiveState(state) {
      liveState = state;
      const indicator = options.runDetail.querySelector('.live-state');
      if (indicator !== null) {
        indicator.className = `live-state live-state-${liveState}`;
        indicator.textContent = LIVE_STATE_LABELS[liveState];
      }
    },
  };
}
