const STATUS_LABELS = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  aborted: 'Aborted',
  failed: 'Failed',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusBadge(status) {
  return element('span', `status-badge status-${status}`, STATUS_LABELS[status]);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP');
}

function renderTask(task, selection, onSelectRun, onRequeue) {
  const card = element('article', 'task-card');
  card.dataset.selected = String(task.taskId === selection?.taskId);
  const header = element('header', 'task-card-header');
  const statusLine = element('div', 'task-card-status');
  statusLine.append(statusBadge(task.status), element('time', 'run-time', formatDate(task.updatedAt)));
  header.append(
    statusLine,
    element('strong', 'task-card-title', task.task),
    element('span', 'task-card-context', `${task.projectName} / ${task.workflow}`),
  );
  if (task.actions.requeue) {
    const requeue = element('button', 'task-requeue-button', 'Requeue task');
    requeue.type = 'button';
    requeue.addEventListener('click', () => onRequeue(task, requeue));
    header.append(requeue);
  }

  const attempts = element('div', 'task-attempts');
  attempts.setAttribute('aria-label', 'Run attempts');
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
      element('span', 'task-attempt-name', `Run ${run.attempt}`),
      element(
        'span',
        'task-attempt-progress',
        run.currentStep === undefined ? task.workflow : run.currentStep,
      ),
      statusBadge(run.status),
    );
    attempts.append(button);
  }
  if (task.runs.length === 0) attempts.append(element('p', 'task-run-empty', '実行待ち'));
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
      options.onRequeue,
    ));
  }
}
