import {
  buildExecutionTrace,
  reportDirectory,
  reportDisplayName,
} from './execution-model.js';
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
  return element('span', `status-badge status-${status}`, STATUS_LABELS[status]);
}

function runKey(selection) {
  return `${selection.projectId}:${selection.slug}`;
}

function eventTitle(event) {
  const location = [event.step, event.phaseName].filter(Boolean).join(' / ');
  return location === '' ? event.type : `${location} · ${event.type}`;
}

function renderEmpty(title, body) {
  const empty = element('div', 'workspace-empty');
  empty.append(element('strong', '', title), element('span', '', body));
  return empty;
}

export function createExecutionView(options) {
  let activeRunKey = '';
  let activeTab = 'live';
  let activeNodeId = null;
  let selectedReport = '';
  let currentDetail = null;
  let currentSelection = null;
  let liveState = 'connecting';
  let followLog = true;

  function renderTaskList(tasks, selection) {
    renderTaskNavigator({
      container: options.runList,
      empty: options.runListEmpty,
      tasks,
      selection,
      onSelectRun: options.onSelectRun,
      onRequeue: options.onRequeue,
    });
  }

  function renderTrace(trace, meta) {
    const section = element('section', 'trace-section');
    const heading = element('div', 'panel-heading');
    const headingCopy = element('div', 'panel-heading-copy');
    const liveIndicator = element('span', `live-state live-state-${liveState}`, LIVE_STATE_LABELS[liveState]);
    heading.append(
      headingCopy,
      liveIndicator,
    );
    headingCopy.append(
      element('h3', '', 'Execution trace'),
      element('p', '', '実行イベントから構成した現在地'),
    );
    section.append(heading);
    if (trace.nodes.length === 0) {
      section.append(renderEmpty('実行開始を待っています', '最初の step が始まるとノードが表示されます。'));
      return section;
    }

    const graph = element('div', 'trace-graph');
    graph.setAttribute('role', 'group');
    graph.setAttribute('aria-label', '実行トレース');
    trace.nodes.forEach((node, index) => {
      if (index > 0) {
        const connector = element('span', 'trace-connector');
        connector.setAttribute('aria-hidden', 'true');
        graph.append(connector);
      }
      const button = element('button', `trace-node trace-node-${node.status}`);
      button.type = 'button';
      button.dataset.active = String(node.id === activeNodeId);
      button.setAttribute('aria-pressed', String(node.id === activeNodeId));
      button.addEventListener('click', () => {
        activeNodeId = activeNodeId === node.id ? null : node.id;
        activeTab = 'live';
        renderDetail(currentDetail, currentSelection);
      });
      const metaLine = [node.eyebrow, node.iteration === undefined ? '' : `#${node.iteration}`]
        .filter(Boolean)
        .join(' · ');
      button.append(
        element('span', 'trace-node-index', String(index + 1).padStart(2, '0')),
        element('strong', '', node.label),
        element('span', 'trace-node-meta', metaLine),
        element('span', 'trace-node-phase', node.phases.join(' / ')),
      );
      graph.append(button);
    });
    section.append(graph);
    if (meta.reason !== undefined) section.append(element('p', 'run-reason', meta.reason));
    return section;
  }

  function renderLogPanel(trace) {
    const panel = element('section', 'detail-panel log-panel');
    const toolbar = element('div', 'detail-toolbar');
    const filteredIndexes = activeNodeId === null
      ? null
      : new Set(trace.nodes.find((node) => node.id === activeNodeId)?.eventIndexes ?? []);
    const visibleEvents = filteredIndexes === null
      ? trace.events
      : trace.events.filter((_event, index) => filteredIndexes.has(index));
    const summary = element(
      'span',
      'detail-toolbar-summary',
      activeNodeId === null ? `${visibleEvents.length} events` : `${visibleEvents.length} matching events`,
    );
    const follow = element('button', 'toolbar-button', followLog ? 'Following' : 'Follow latest');
    follow.type = 'button';
    follow.setAttribute('aria-pressed', String(followLog));
    follow.addEventListener('click', () => {
      followLog = !followLog;
      renderDetail(currentDetail, currentSelection);
    });
    toolbar.append(summary);
    if (activeNodeId !== null) {
      const clear = element('button', 'toolbar-button', 'Show all');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        activeNodeId = null;
        renderDetail(currentDetail, currentSelection);
      });
      toolbar.append(clear);
    }
    toolbar.append(follow);
    panel.append(toolbar);
    if (visibleEvents.length === 0) {
      panel.append(renderEmpty('ログはまだありません', 'イベントを受信するとここへ追加されます。'));
      return panel;
    }
    const list = element('ol', 'log-events');
    for (const event of visibleEvents) {
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
      panel.append(renderEmpty('レポートはまだありません', '生成された Markdown はここへ追加されます。'));
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
        renderDetail(currentDetail, currentSelection);
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
        renderDetail(currentDetail, currentSelection);
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
        renderDetail(currentDetail, currentSelection);
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

  function renderDetail(detail, selection) {
    if (detail === null || selection === null) return false;
    if (detail.project.id !== selection.projectId || detail.meta.runSlug !== selection.slug) return false;
    const nextRunKey = runKey(selection);
    const sameRun = nextRunKey === activeRunKey;
    const previousScrollTop = sameRun ? options.runDetail.scrollTop : 0;
    if (!sameRun) {
      activeRunKey = nextRunKey;
      activeTab = detail.meta.status === 'completed' && detail.reports.length > 0 ? 'reports' : 'live';
      activeNodeId = null;
      selectedReport = '';
    }
    currentDetail = detail;
    currentSelection = selection;
    const trace = buildExecutionTrace(detail.meta, detail.events);
    const header = element('header', 'run-detail-header');
    const title = element('div', 'run-detail-title');
    title.append(
      statusBadge(detail.meta.status),
      element('h2', '', detail.meta.workflow),
      element('p', '', `${detail.project.displayName} / ${detail.meta.runSlug}`),
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
    header.append(title, facts);
    if (detail.prUrl !== undefined) {
      const link = element('a', 'pr-link', 'Open pull request');
      link.href = detail.prUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      header.append(link);
    }
    options.runDetail.replaceChildren(header, renderTrace(trace, detail.meta), renderTabs(detail, trace));
    options.runDetail.scrollTop = previousScrollTop;
    const logList = options.runDetail.querySelector('.log-events');
    if (followLog && logList !== null) logList.scrollTop = logList.scrollHeight;
    options.onStatusChange(detail.meta.status);
    return true;
  }

  function renderPlaceholder() {
    activeRunKey = '';
    currentDetail = null;
    currentSelection = null;
    options.runDetail.replaceChildren(renderEmpty(
      'Run を選択',
      '左のタスクから run を選ぶと、実行トレースと成果物を確認できます。',
    ));
  }

  return {
    renderTaskList,
    renderDetail,
    renderPlaceholder,
    setLiveState(state) {
      liveState = state;
      if (currentDetail !== null) renderDetail(currentDetail, currentSelection);
    },
  };
}
