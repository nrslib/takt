import { getLocale, t } from './i18n.js';
import { workflowDisplayName } from './execution-model.js';
import { markdownTitle } from './markdown-view.js';
import { taskActionButtonModel } from './task-action-ui.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusBadge(status) {
  return element('span', `status-badge status-${status}`, t(`app.status.${status}`));
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocale() === 'en' ? 'en-US' : 'ja-JP');
}

function availableActions(task) {
  if (Array.isArray(task.actionList)) return task.actionList;
  return Object.entries(task.actions ?? {})
    .filter(([, available]) => available === true)
    .map(([action]) => action);
}

function renderTaskActions(task, onAction, onRequeue) {
  const actions = availableActions(task);
  if (actions.length === 0) return null;
  const disclosure = element('details', 'task-actions');
  const summary = element('summary', 'task-actions-summary', t('task.actions'));
  summary.title = t('task.actionsHint');
  disclosure.append(summary);
  const list = element('div', 'task-actions-list');
  for (const action of actions) {
    const model = taskActionButtonModel(task, action);
    const button = element('button', `task-action task-action-${model.action}`, t(model.labelKey));
    button.type = 'button';
    button.dataset.action = model.action;
    button.dataset.taskId = model.taskId;
    button.title = t(`task.actionHint.${model.action}`);
    button.addEventListener('click', () => {
      if (typeof onAction === 'function') {
        onAction(task, model.action, button);
      } else if (model.action === 'requeue' && typeof onRequeue === 'function') {
        onRequeue(task, button);
      }
    });
    list.append(button);
  }
  disclosure.append(list);
  return disclosure;
}

function renderTask(task, selection, onSelectRun, onAction, onRequeue) {
  const card = element('article', 'task-card');
  card.dataset.taskId = task.taskId;
  card.dataset.selected = String(task.taskId === selection?.taskId);
  const header = element('header', 'task-card-header');
  const statusLine = element('div', 'task-card-status');
  statusLine.append(statusBadge(task.status), element('time', 'run-time', formatDate(task.updatedAt)));
  header.append(
    statusLine,
    element('strong', 'task-card-title', markdownTitle(task.task)),
    (() => {
      const workflow = workflowDisplayName(task.workflow, getLocale());
      const context = element('span', 'task-card-context', t('task.context', {
        project: task.projectName,
        workflow,
      }));
      if (workflow !== task.workflow) context.title = task.workflow;
      return context;
    })(),
  );
  const taskActions = renderTaskActions(task, onAction, onRequeue);
  if (taskActions !== null) header.append(taskActions);

  const attempts = element('div', 'task-attempts');
  attempts.setAttribute('aria-label', t('task.attempts'));
  for (const run of task.runs) {
    const button = element('button', 'task-attempt');
    button.type = 'button';
    button.dataset.selected = String(
      run.slug === selection?.slug && task.projectId === selection?.projectId,
    );
    button.addEventListener('click', () => onSelectRun({
      projectId: task.projectId,
      taskId: task.taskId,
      slug: run.slug,
    }));
    button.append(
      element('span', 'task-attempt-name', t('task.run', { number: run.attempt })),
      element(
        'span',
        'task-attempt-progress',
        run.currentStep === undefined
          ? workflowDisplayName(task.workflow, getLocale())
          : t('task.current', { step: run.currentStep }),
      ),
      statusBadge(run.status),
    );
    attempts.append(button);
  }
  if (task.runs.length === 0) attempts.append(element('p', 'task-run-empty', t('task.waiting')));
  card.append(header, attempts);
  return card;
}

export function renderTaskNavigator(options) {
  options.container.replaceChildren();
  options.empty.hidden = options.tasks.length !== 0;
  if (options.count !== undefined) options.count.textContent = String(options.tasks.length);
  for (const task of options.tasks) {
    options.container.append(renderTask(
      task,
      options.selection,
      options.onSelectRun,
      options.onAction,
      options.onRequeue,
    ));
  }
}
