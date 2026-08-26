import {
  browseDirectories,
  createChatSession,
  getRun,
  getTasks,
  getProjects,
  getSession,
  getWorkflows,
  pickNativeDirectory,
  requeueTask,
  reconfigureChatSession,
  registerProject,
  restartChatSession,
  sendChatMessage,
  startTask,
} from './api.js';
import { createExecutionView } from './execution-view.js';
import { subscribeRun, subscribeTasks } from './live-stream.js';
import {
  buildExecutionSettingsRequest,
  createDirectoryRequestTracker,
  isCurrentWorkflowRequest as isCurrentWorkflowRequestState,
  isWorkflowCatalogReady,
  projectSelectionForRefresh,
  sameRunSelection as sameRunSelectionState,
  snapshotExecutionSettings,
  shouldCloseExecutionContext,
} from './ui-state.js';

const EMPTY_CHAT_MESSAGE = 'メッセージを入力してください。';
const CHAT_RESIZE_STEP = 16;
const CHAT_DRAWER_MIN_WIDTH = 360;
const CHAT_DRAWER_MAX_WIDTH = 560;

const elements = {
  connection: document.querySelector('#connection-status'),
  category: document.querySelector('#category'),
  chatForm: document.querySelector('#chat-form'),
  chatGoButton: document.querySelector('#chat-go-button'),
  chatSetupButton: document.querySelector('#chat-setup-button'),
  chatCollapseButton: document.querySelector('#chat-collapse-button'),
  chatResizer: document.querySelector('#chat-resizer'),
  chatSurface: document.querySelector('#chat-surface'),
  chatSurfaceDescription: document.querySelector('#chat-surface-description'),
  chatSurfaceLabel: document.querySelector('#chat-surface-label'),
  chatTitle: document.querySelector('#chat-title'),
  chatMessage: document.querySelector('#chat-message'),
  chatMode: document.querySelector('#chat-mode'),
  chatNewButton: document.querySelector('#chat-new-button'),
  chatSendButton: document.querySelector('#chat-send-button'),
  chatSessionMeta: document.querySelector('#chat-session-meta'),
  chatStatus: document.querySelector('#chat-message-status'),
  chatThinking: document.querySelector('#chat-thinking'),
  chatThinkingContent: document.querySelector('#chat-thinking-content'),
  chatThinkingLabel: document.querySelector('#chat-thinking-label'),
  chatThinkingState: document.querySelector('#chat-thinking-state'),
  chatTranscript: document.querySelector('#chat-transcript'),
  directoryCancel: document.querySelector('#directory-cancel-button'),
  directoryClose: document.querySelector('#directory-close-button'),
  directoryCurrentPath: document.querySelector('#directory-current-path'),
  directoryDialog: document.querySelector('#directory-dialog'),
  directoryGo: document.querySelector('#directory-go-button'),
  directoryList: document.querySelector('#directory-list'),
  directoryMessage: document.querySelector('#directory-message'),
  directoryNativePicker: document.querySelector('#directory-native-picker-button'),
  directoryParent: document.querySelector('#directory-parent-button'),
  directoryPicker: document.querySelector('#directory-picker-button'),
  directorySelect: document.querySelector('#directory-select-button'),
  executionContext: document.querySelector('#execution-context'),
  executionContextToggle: document.querySelector('#execution-context > summary'),
  executionContextSummary: document.querySelector('#execution-context-summary'),
  aiConsultButton: document.querySelector('#ai-consult-button'),
  newTaskButton: document.querySelector('#new-task-button'),
  viewerNav: document.querySelector('#viewer-nav'),
  viewerScreen: document.querySelector('#viewer-screen'),
  mobileTaskListButton: document.querySelector('#mobile-task-list-button'),
  taskCount: document.querySelector('#task-count'),
  project: document.querySelector('#project'),
  projectHelp: document.querySelector('#project-help'),
  refresh: document.querySelector('#refresh-button'),
  runDetail: document.querySelector('#run-detail'),
  runStatusLive: document.querySelector('#run-status-live'),
  runList: document.querySelector('#run-list'),
  runListEmpty: document.querySelector('#run-list-empty'),
  runWarning: document.querySelector('#run-warning'),
  watch: document.querySelector('#watch-button'),
  workflow: document.querySelector('#workflow'),
};

const directoryRequests = createDirectoryRequestTracker();

let selectedRun = null;
let refreshing = false;
let stopTaskStream = null;
let stopRunStream = null;
let liveUpdatesEnabled = true;
let taskCollection = { tasks: [], warnings: [] };
let workflowCatalog = [];
let workflowCatalogProjectId = '';
let workflowRequestId = 0;
let projectRefreshGeneration = 0;
let chatSession = null;
let registryWarnings = [];
let workflowWarnings = [];
let browsedDirectory = null;
let chatDrawerWidth = null;
let chatDrawerWidthManuallyAdjusted = false;
let chatDrawerOpen = false;
let screenMode = 'viewer';
let executionEnabled = false;
let chatOperationInProgress = false;
let chatMessageRevision = 0;
let executionSettings = {
  worktreeMode: 'auto',
  worktreePath: '',
  branch: '',
  baseBranch: '',
  autoPr: true,
  draftPr: true,
};

const executionView = createExecutionView({
  runList: elements.runList,
  runListEmpty: elements.runListEmpty,
  taskCount: elements.taskCount,
  runDetail: elements.runDetail,
  onSelectRun: selectRun,
  onRequeue: (task, button) => void requeueSelectedTask(task, button),
  onStatusChange: (status) => {
    const label = status.toUpperCase();
    if (elements.runStatusLive.textContent !== label) elements.runStatusLive.textContent = label;
  },
});

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className !== '') element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function selectedCategory() {
  return workflowCatalog.find((category) => category.id === elements.category.value);
}

function selectedProjectId() {
  return elements.project.value;
}

function workflowCatalogReady(projectId = selectedProjectId()) {
  return isWorkflowCatalogReady(projectId, workflowCatalogProjectId, workflowCatalog);
}

function updateExecutionContextSummary() {
  const projectOption = elements.project.selectedOptions[0];
  const categoryOption = elements.category.selectedOptions[0];
  const workflowOption = elements.workflow.selectedOptions[0];
  if (selectedProjectId() === '' || workflowOption === undefined) {
    elements.executionContextSummary.textContent = 'ディレクトリとworkflowを選択';
    return;
  }
  const projectName = projectOption?.textContent?.split(' — ')[0] ?? '実行先';
  const category = categoryOption?.textContent ?? '';
  elements.executionContextSummary.textContent = [projectName, category, workflowOption.value]
    .filter(Boolean)
    .join(' / ');
}

function updateWarnings(runWarnings = []) {
  elements.runWarning.textContent = [
    ...registryWarnings,
    ...workflowWarnings,
    ...runWarnings,
  ].join('\n');
}

function syncChatControls() {
  const settingsDisabled = !executionEnabled || chatOperationInProgress;
  elements.category.disabled = settingsDisabled;
  elements.workflow.disabled = settingsDisabled;
  elements.chatMode.disabled = settingsDisabled;
  elements.chatMessage.disabled = !executionEnabled;
  elements.chatSendButton.disabled = !executionEnabled || chatOperationInProgress;
  elements.chatGoButton.disabled = !executionEnabled || chatOperationInProgress;
  elements.chatSetupButton.disabled = !executionEnabled || chatOperationInProgress;
  elements.chatNewButton.disabled = chatSession === null || settingsDisabled;
}

function setExecutionEnabled(enabled) {
  executionEnabled = enabled;
  syncChatControls();
}

function setChatOperationInProgress(inProgress) {
  chatOperationInProgress = inProgress;
  syncChatControls();
}

function populateProjects(snapshot, preferredProjectId = '') {
  const previousProjectId = selectedProjectId();
  registryWarnings = [...snapshot.warnings];
  elements.project.replaceChildren();
  const availableProjects = snapshot.projects.filter((candidate) => candidate.available);
  const placeholder = createElement('option', '', '実行ディレクトリを選択');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  elements.project.append(placeholder);
  for (const project of availableProjects) {
    const option = createElement('option', '', `${project.displayName} — ${project.projectDirectory}`);
    option.value = project.id;
    elements.project.append(option);
  }
  const available = availableProjects.length > 0;
  const preferredAvailable = availableProjects.some((project) => project.id === preferredProjectId);
  if (preferredAvailable) elements.project.value = preferredProjectId;
  elements.project.disabled = !available;
  if (selectedProjectId() !== previousProjectId) clearWorkflowCatalog();
  setExecutionEnabled(preferredAvailable && workflowCatalogReady(preferredProjectId));
  elements.projectHelp.textContent = available
    ? 'Chatを始める前に、実行ディレクトリを選択してください。'
    : '登録済みディレクトリがありません。対象ディレクトリでtaktコマンドを一度実行してください。';
  updateExecutionContextSummary();
  updateWarnings();
}

function applyProjectsSnapshot(snapshot, preferredProjectId) {
  populateProjects(snapshot, preferredProjectId);
  if (preferredProjectId !== '' && selectedProjectId() === '') {
    clearWorkflowCatalog();
    resetChatSession();
  }
}

async function refreshProjects(preferredProjectId) {
  const generation = ++projectRefreshGeneration;
  const selectedProjectAtStart = selectedProjectId();
  const preferredProjectAtStart = preferredProjectId === selectedProjectAtStart
    ? preferredProjectId
    : selectedProjectAtStart;
  try {
    const snapshot = await getProjects();
    if (generation !== projectRefreshGeneration) return false;
    const preferredProjectIdForSnapshot = projectSelectionForRefresh(
      preferredProjectAtStart,
      selectedProjectId(),
    );
    applyProjectsSnapshot(snapshot, preferredProjectIdForSnapshot);
    return true;
  } catch (error) {
    if (generation !== projectRefreshGeneration) return false;
    throw error;
  }
}

function syncDirectoryControls() {
  const pending = directoryRequests.hasPendingOperation();
  const browsing = directoryRequests.isCurrentOperation('browse');
  const path = elements.directoryCurrentPath.value.trim();
  elements.directoryCurrentPath.disabled = pending;
  elements.directoryGo.disabled = pending || path === '';
  elements.directoryParent.disabled = pending
    || browsedDirectory === null
    || browsedDirectory.parent === null;
  elements.directoryNativePicker.disabled = pending;
  elements.directorySelect.disabled = pending || browsing || path === '';
  for (const button of elements.directoryList.querySelectorAll('button.directory-entry')) {
    button.disabled = pending;
  }
}

function renderDirectoryEmptyState(message) {
  const item = createElement('div', 'directory-entry-item');
  item.setAttribute('role', 'listitem');
  item.append(createElement('p', 'empty-state', message));
  elements.directoryList.replaceChildren(item);
}

function renderBrowsedDirectory(directory) {
  browsedDirectory = directory;
  elements.directoryCurrentPath.value = directory.path;
  elements.directoryCurrentPath.title = directory.path;
  elements.directoryList.replaceChildren();
  if (directory.directories.length === 0) {
    renderDirectoryEmptyState('子ディレクトリはありません。');
    syncDirectoryControls();
    return;
  }
  for (const child of directory.directories) {
    const item = createElement('div', 'directory-entry-item');
    item.setAttribute('role', 'listitem');
    const button = createElement('button', 'directory-entry', child.name);
    button.type = 'button';
    button.addEventListener('click', () => void loadDirectory(child.path));
    item.append(button);
    elements.directoryList.append(item);
  }
  syncDirectoryControls();
}

async function loadDirectory(path) {
  const directoryRequest = directoryRequests.beginRequest('browse');
  if (directoryRequest === null) return;
  elements.directoryMessage.textContent = 'ディレクトリを読み込んでいます…';
  syncDirectoryControls();
  try {
    const directory = await browseDirectories(path);
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    renderBrowsedDirectory(directory);
    elements.directoryMessage.textContent = '';
  } catch (error) {
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    elements.directoryMessage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (directoryRequests.finishRequest(directoryRequest)) syncDirectoryControls();
  }
}

async function openNativeDirectoryPicker() {
  const directoryRequest = directoryRequests.beginPendingOperation('native-picker');
  if (directoryRequest === null) return;
  syncDirectoryControls();
  elements.directoryMessage.textContent = 'Finderでディレクトリを選択してください。';
  try {
    const result = await pickNativeDirectory();
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    if (result.cancelled) {
      elements.directoryMessage.textContent = 'ディレクトリ選択をキャンセルしました。';
      return;
    }
    renderBrowsedDirectory(result.directory);
    elements.directoryMessage.textContent = '';
  } catch (error) {
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    elements.directoryMessage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (directoryRequests.finishPendingOperation(directoryRequest)) syncDirectoryControls();
  }
}

function closeDirectoryPicker() {
  directoryRequests.closeDialog();
  syncDirectoryControls();
  if (elements.directoryDialog.open) elements.directoryDialog.close();
}

function openDirectoryPicker() {
  directoryRequests.openDialog();
  browsedDirectory = null;
  elements.directoryCurrentPath.value = '';
  elements.directoryList.replaceChildren();
  elements.directoryMessage.textContent = '';
  syncDirectoryControls();
  elements.directoryDialog.showModal();
  void loadDirectory(null);
}

function clearWorkflowCatalog() {
  workflowRequestId += 1;
  workflowCatalog = [];
  workflowCatalogProjectId = '';
  workflowWarnings = [];
  elements.category.replaceChildren();
  elements.workflow.replaceChildren();
}

function beginWorkflowRequest(projectId) {
  workflowRequestId += 1;
  return { projectId, requestId: workflowRequestId };
}

function isCurrentWorkflowRequest(request) {
  return isCurrentWorkflowRequestState(request, workflowRequestId, selectedProjectId());
}

async function selectBrowsedDirectory() {
  const requestedPath = elements.directoryCurrentPath.value.trim();
  if (requestedPath === '') return;
  const directoryRequest = directoryRequests.beginPendingOperation('select');
  if (directoryRequest === null) return;
  syncDirectoryControls();
  elements.directoryMessage.textContent = 'ディレクトリを登録しています…';
  let workflowRequest = null;
  try {
    const directory = await browseDirectories(requestedPath);
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    renderBrowsedDirectory(directory);
    const project = await registerProject(directory.path);
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    const snapshot = await getProjects();
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    applyProjectsSnapshot(snapshot, project.id);
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    setExecutionEnabled(false);
    clearWorkflowCatalog();
    workflowRequest = beginWorkflowRequest(project.id);
    const catalog = await getWorkflows(project.id);
    if (!directoryRequests.isCurrent(directoryRequest) || !isCurrentWorkflowRequest(workflowRequest)) return;
    if (selectedProjectId() !== project.id) {
      elements.directoryMessage.textContent = '登録したディレクトリを選択できませんでした。';
      return;
    }
    populateWorkflowCatalog(catalog, project.id);
    if (!directoryRequests.isCurrent(directoryRequest) || !isCurrentWorkflowRequest(workflowRequest)) return;
    setExecutionEnabled(workflowCatalogReady(project.id));
    resetChatSession();
    closeDirectoryPicker();
  } catch (error) {
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    if (workflowRequest !== null && !isCurrentWorkflowRequest(workflowRequest)) return;
    elements.directoryMessage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (directoryRequests.finishPendingOperation(directoryRequest)) syncDirectoryControls();
  }
}

function populateWorkflowSelect(preferredWorkflow = '') {
  const category = selectedCategory();
  elements.workflow.replaceChildren();
  for (const workflow of category?.workflows ?? []) {
    const option = createElement('option', '', workflow.id);
    option.value = workflow.id;
    option.title = workflow.description;
    elements.workflow.append(option);
  }
  const hasPreferred = [...elements.workflow.options]
    .some((option) => option.value === preferredWorkflow);
  if (hasPreferred) elements.workflow.value = preferredWorkflow;
  updateExecutionContextSummary();
}

function populateWorkflowCatalog(catalog, projectId = selectedProjectId()) {
  workflowCatalog = catalog.categories;
  workflowCatalogProjectId = projectId;
  elements.category.replaceChildren();
  for (const category of workflowCatalog) {
    const option = createElement('option', '', category.label);
    option.value = category.id;
    elements.category.append(option);
  }
  const defaultCategory = workflowCatalog.find((category) =>
    category.workflows.some((workflow) => workflow.id === 'default'));
  if (defaultCategory !== undefined) elements.category.value = defaultCategory.id;
  populateWorkflowSelect('default');
  workflowWarnings = [...catalog.warnings];
  updateWarnings();
}

async function loadWorkflowsForProject() {
  const projectId = selectedProjectId();
  clearWorkflowCatalog();
  const request = beginWorkflowRequest(projectId);
  if (projectId === '') return { request, ok: true };
  try {
    const catalog = await getWorkflows(projectId);
    if (isCurrentWorkflowRequest(request)) populateWorkflowCatalog(catalog, projectId);
    return { request, ok: true };
  } catch (error) {
    return { request, ok: false, error };
  }
}

function renderChatPlaceholder() {
  const placeholder = createElement('div', 'chat-placeholder');
  placeholder.append(
    createElement('strong', '', '会話を開始'),
    createElement('span', '', '選択したworkflowを前提にAIと相談できます。'),
  );
  elements.chatTranscript.replaceChildren(placeholder);
}

function clearChatThinking() {
  elements.chatThinking.hidden = true;
  elements.chatThinking.open = false;
  elements.chatThinking.dataset.active = 'false';
  elements.chatThinkingContent.textContent = '';
  elements.chatThinkingLabel.textContent = '考え中';
  elements.chatThinkingState.textContent = '応答を待っています';
}

function beginChatThinking() {
  elements.chatThinking.hidden = false;
  elements.chatThinking.open = false;
  elements.chatThinking.dataset.active = 'true';
  elements.chatThinkingContent.textContent = '';
  elements.chatThinkingLabel.textContent = '考え中';
  elements.chatThinkingState.textContent = '応答を待っています';
}

function appendChatThinking(content) {
  elements.chatThinking.open = true;
  elements.chatThinkingContent.textContent += content;
  elements.chatThinkingState.textContent = '受信中';
  elements.chatThinkingContent.scrollTop = elements.chatThinkingContent.scrollHeight;
}

function finishChatThinking(completed) {
  elements.chatThinking.dataset.active = 'false';
  if (elements.chatThinkingContent.textContent === '') {
    clearChatThinking();
    return;
  }
  elements.chatThinking.open = false;
  elements.chatThinkingLabel.textContent = 'Thinking';
  elements.chatThinkingState.textContent = completed ? '完了' : '中断';
}

function resetChatSession() {
  chatSession = null;
  elements.chatSessionMeta.textContent = '会話はまだ始まっていません。';
  elements.chatStatus.textContent = '';
  clearChatThinking();
  renderChatPlaceholder();
  syncChatControls();
}

function updateChatSessionDescription(session) {
  elements.chatSessionMeta.textContent = [
    session.workflow,
    session.mode,
    session.provider,
    session.model,
  ].filter(Boolean).join(' · ');
  syncChatControls();
}

function appendChatEntry(role, content) {
  const entry = createElement('article', `chat-entry chat-entry-${role}`);
  entry.append(
    createElement('span', 'chat-role', role === 'user' ? 'YOU' : role === 'assistant' ? 'AI' : 'SYSTEM'),
    createElement('p', '', content),
  );
  elements.chatTranscript.querySelector('.chat-placeholder')?.remove();
  elements.chatTranscript.append(entry);
  elements.chatTranscript.scrollTop = elements.chatTranscript.scrollHeight;
}

function createSettingsField(label, control) {
  const field = createElement('label', 'chat-setting-field');
  field.append(createElement('span', '', label), control);
  return field;
}

function executionSettingsSummary(settings = executionSettings) {
  const worktree = settings.worktreeMode === 'none'
    ? 'なし'
    : settings.worktreeMode === 'custom'
      ? settings.worktreePath
      : '自動';
  return [
    `Worktree: ${worktree}`,
    `Branch: ${settings.branch || '自動'}`,
    `Base branch: ${settings.baseBranch || '既定'}`,
    `Auto PR: ${settings.autoPr ? 'yes' : 'no'}`,
    `Draft PR: ${settings.draftPr ? 'yes' : 'no'}`,
  ].join(' · ');
}

function appendExecutionSettings() {
  const entry = createElement('article', 'chat-entry chat-entry-settings');
  entry.append(
    createElement('span', 'chat-role', 'SETUP'),
    createElement('p', 'chat-settings-intro', 'この会話から実行するタスクの設定です。'),
  );
  const form = createElement('form', 'chat-settings-form');
  const worktreeMode = document.createElement('select');
  for (const [value, label] of [['auto', '自動'], ['custom', 'パスを指定'], ['none', '使用しない']]) {
    const option = createElement('option', '', label);
    option.value = value;
    option.selected = executionSettings.worktreeMode === value;
    worktreeMode.append(option);
  }
  const worktreePath = document.createElement('input');
  worktreePath.type = 'text';
  worktreePath.value = executionSettings.worktreePath;
  worktreePath.placeholder = '/path/to/task-worktree';
  const branch = document.createElement('input');
  branch.type = 'text';
  branch.value = executionSettings.branch;
  branch.placeholder = '自動生成';
  const baseBranch = document.createElement('input');
  baseBranch.type = 'text';
  baseBranch.value = executionSettings.baseBranch;
  baseBranch.placeholder = 'リポジトリの既定ブランチ';
  const autoPr = document.createElement('input');
  autoPr.type = 'checkbox';
  autoPr.checked = executionSettings.autoPr;
  const draftPr = document.createElement('input');
  draftPr.type = 'checkbox';
  draftPr.checked = executionSettings.draftPr;
  const syncDependencies = () => {
    worktreePath.disabled = worktreeMode.value !== 'custom';
    branch.disabled = worktreeMode.value === 'none';
    baseBranch.disabled = worktreeMode.value === 'none';
    autoPr.disabled = worktreeMode.value === 'none';
    if (autoPr.disabled) autoPr.checked = false;
    draftPr.disabled = !autoPr.checked;
    if (draftPr.disabled) draftPr.checked = false;
  };
  worktreeMode.addEventListener('change', syncDependencies);
  autoPr.addEventListener('change', syncDependencies);
  syncDependencies();
  const save = createElement('button', 'secondary-button', '設定を保存');
  save.type = 'submit';
  form.append(
    createSettingsField('Worktree', worktreeMode),
    createSettingsField('Worktree path', worktreePath),
    createSettingsField('Branch name', branch),
    createSettingsField('Base branch', baseBranch),
    createSettingsField('Auto-create PR', autoPr),
    createSettingsField('Create as draft', draftPr),
    save,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const next = {
      worktreeMode: worktreeMode.value,
      worktreePath: worktreePath.value.trim(),
      branch: worktreeMode.value === 'none' ? '' : branch.value.trim(),
      baseBranch: worktreeMode.value === 'none' ? '' : baseBranch.value.trim(),
      autoPr: autoPr.checked,
      draftPr: draftPr.checked,
    };
    if (next.worktreeMode === 'custom' && next.worktreePath === '') {
      elements.chatStatus.textContent = 'Worktree pathを入力してください。';
      worktreePath.focus();
      return;
    }
    executionSettings = next;
    form.replaceChildren(createElement('p', 'chat-settings-summary', executionSettingsSummary()));
    elements.chatStatus.textContent = '実行設定を保存しました。';
  });
  entry.append(form);
  elements.chatTranscript.querySelector('.chat-placeholder')?.remove();
  elements.chatTranscript.append(entry);
  elements.chatTranscript.scrollTop = elements.chatTranscript.scrollHeight;
}

function appendTaskInstruction(task) {
  const settings = snapshotExecutionSettings(executionSettings);
  const entry = createElement('article', 'chat-entry chat-entry-task');
  entry.append(
    createElement('span', 'chat-role', 'TASK'),
    createElement('pre', '', task),
    createElement('p', 'chat-settings-summary', executionSettingsSummary(settings)),
  );
  const button = createElement('button', 'secondary-button', 'この指示で実行');
  button.type = 'button';
  button.addEventListener('click', () => void launchTaskInstruction(task, settings, button));
  entry.append(button);
  elements.chatTranscript.append(entry);
  elements.chatTranscript.scrollTop = elements.chatTranscript.scrollHeight;
}

async function launchTaskInstruction(task, settings, button) {
  button.disabled = true;
  elements.chatStatus.textContent = 'runを開始しています…';
  try {
    const result = await startTask({
      projectId: selectedProjectId(),
      prompt: task,
      workflow: elements.workflow.value,
      ...buildExecutionSettingsRequest(settings),
    });
    const modeLabel = result.mode === 'watch' ? 'watch' : 'run';
    const dispositionLabel = result.disposition === 'reused'
      ? '実行中のone-shot taskにキューしました'
      : 'TAKTを起動しました';
    elements.chatStatus.textContent = `${dispositionLabel}（${modeLabel}）。PID: ${result.pid}`;
    button.textContent = `${result.disposition === 'reused' ? 'キュー済み' : '起動済み'} · ${modeLabel} · PID ${result.pid}`;
    await refreshRuns();
  } catch (error) {
    elements.chatStatus.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
}

function resizeChatMessage() {
  const styles = getComputedStyle(elements.chatMessage);
  const minHeight = Number.parseFloat(styles.minHeight);
  const maxHeight = Number.parseFloat(styles.maxHeight);
  elements.chatMessage.style.height = 'auto';
  const height = Math.min(Math.max(elements.chatMessage.scrollHeight, minHeight), maxHeight);
  elements.chatMessage.style.height = `${height}px`;
  elements.chatMessage.style.overflowY = elements.chatMessage.scrollHeight > maxHeight
    ? 'auto'
    : 'hidden';
}

function submitChatWithShortcut(event) {
  if (event.isComposing || event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  if (!elements.chatSendButton.disabled) elements.chatForm.requestSubmit();
}

function handleChatMessageInput() {
  chatMessageRevision += 1;
  resizeChatMessage();
  if (elements.chatStatus.textContent === EMPTY_CHAT_MESSAGE) {
    elements.chatStatus.textContent = '';
  }
}

function submitGoCommand() {
  if (elements.chatGoButton.disabled) return;
  const draft = elements.chatMessage.value.trim();
  elements.chatMessage.value = draft === '' ? '/go' : `${draft} /go`;
  chatMessageRevision += 1;
  resizeChatMessage();
  elements.chatForm.requestSubmit();
}

function submitSetupCommand() {
  if (elements.chatSetupButton.disabled) return;
  elements.chatMessage.value = '/setup';
  chatMessageRevision += 1;
  resizeChatMessage();
  elements.chatForm.requestSubmit();
}

function chatDrawerWidthBounds() {
  const max = Math.min(CHAT_DRAWER_MAX_WIDTH, Math.round(window.innerWidth * 0.48));
  return {
    min: CHAT_DRAWER_MIN_WIDTH,
    max: Math.max(CHAT_DRAWER_MIN_WIDTH, max),
  };
}

function setChatDrawerWidth(requestedWidth) {
  const bounds = chatDrawerWidthBounds();
  chatDrawerWidth = Math.min(Math.max(requestedWidth, bounds.min), bounds.max);
  elements.chatSurface.style.setProperty('--chat-drawer-width', String(chatDrawerWidth) + 'px');
  elements.chatResizer.setAttribute('aria-valuemin', String(Math.round(bounds.min)));
  elements.chatResizer.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
  elements.chatResizer.setAttribute('aria-valuenow', String(Math.round(chatDrawerWidth)));
}

function setChatDrawerWidthFromUser(requestedWidth) {
  chatDrawerWidthManuallyAdjusted = true;
  setChatDrawerWidth(requestedWidth);
}

function setChatDrawerOpen(open) {
  chatDrawerOpen = open;
  elements.chatSurface.dataset.open = String(open);
  elements.chatSurface.setAttribute('aria-hidden', String(!open));
  elements.chatSurface.inert = !open;
  elements.aiConsultButton.setAttribute('aria-expanded', String(open));
  elements.chatCollapseButton.setAttribute('aria-expanded', String(open));
  elements.chatResizer.tabIndex = open && screenMode === 'viewer' ? 0 : -1;
}

function setScreen(nextScreen) {
  screenMode = nextScreen;
  document.body.dataset.screen = nextScreen;
  const isTaskScreen = nextScreen === 'task';
  elements.viewerNav.classList.toggle('nav-button-active', !isTaskScreen);
  elements.viewerNav.setAttribute('aria-current', isTaskScreen ? 'false' : 'page');
  elements.newTaskButton.classList.toggle('nav-button-active', isTaskScreen);
  elements.newTaskButton.setAttribute('aria-current', isTaskScreen ? 'page' : 'false');
  elements.viewerScreen.setAttribute('aria-hidden', String(isTaskScreen));
  elements.aiConsultButton.hidden = isTaskScreen;
  elements.chatSurface.dataset.mode = isTaskScreen ? 'task' : 'drawer';
  elements.chatCollapseButton.hidden = isTaskScreen;
  elements.chatSurfaceLabel.textContent = isTaskScreen ? 'New task' : 'Assistant';
  elements.chatTitle.textContent = isTaskScreen ? 'タスクを作成' : 'AIに相談';
  elements.chatSurfaceDescription.textContent = isTaskScreen
    ? 'AIと相談しながら、実行する内容を組み立てます。'
    : 'Viewerを見ながら、TAKTに相談できます。';
  if (isTaskScreen) {
    setChatDrawerOpen(true);
    requestAnimationFrame(() => elements.chatMessage.focus());
  } else {
    setChatDrawerOpen(false);
  }
}

function openChatDrawer() {
  if (screenMode !== 'viewer') return;
  elements.chatSurface.dataset.mode = 'drawer';
  elements.chatCollapseButton.hidden = false;
  setChatDrawerOpen(true);
  requestAnimationFrame(() => elements.chatMessage.focus());
}

function closeChatDrawer() {
  if (screenMode !== 'viewer') return;
  setChatDrawerOpen(false);
  elements.aiConsultButton.focus();
}

function resizeChatDrawerFromPointer(event) {
  setChatDrawerWidthFromUser(window.innerWidth - event.clientX);
}

function startChatDrawerResize(event) {
  if (event.button !== 0 || screenMode !== 'viewer' || !chatDrawerOpen) return;
  event.preventDefault();
  elements.chatResizer.setPointerCapture(event.pointerId);
  elements.chatSurface.dataset.resizing = 'true';
  resizeChatDrawerFromPointer(event);
}

function stopChatDrawerResize(event) {
  if (elements.chatResizer.hasPointerCapture(event.pointerId)) {
    elements.chatResizer.releasePointerCapture(event.pointerId);
  }
  delete elements.chatSurface.dataset.resizing;
}

function resizeChatDrawerWithKeyboard(event) {
  if (!chatDrawerOpen || screenMode !== 'viewer' || chatDrawerWidth === null) return;
  const bounds = chatDrawerWidthBounds();
  const widths = {
    ArrowLeft: chatDrawerWidth + CHAT_RESIZE_STEP,
    ArrowRight: chatDrawerWidth - CHAT_RESIZE_STEP,
    Home: bounds.min,
    End: bounds.max,
  };
  const requestedWidth = widths[event.key];
  if (requestedWidth === undefined) return;
  event.preventDefault();
  setChatDrawerWidthFromUser(requestedWidth);
}

function initializeChatDrawer() {
  chatDrawerWidthManuallyAdjusted = false;
  const bounds = chatDrawerWidthBounds();
  setChatDrawerWidth(Math.min(
    bounds.max,
    Math.max(bounds.min, Math.round(window.innerWidth * 0.38)),
  ));
  setScreen('viewer');
}

function updateChatDrawerWidthForLayout() {
  const bounds = chatDrawerWidthBounds();
  if (chatDrawerWidthManuallyAdjusted && chatDrawerWidth !== null) {
    setChatDrawerWidth(chatDrawerWidth);
    return;
  }
  setChatDrawerWidth(Math.min(
    bounds.max,
    Math.max(bounds.min, Math.round(window.innerWidth * 0.38)),
  ));
}

async function ensureChatSession() {
  if (chatSession !== null) return chatSession;
  const session = await createChatSession({
    projectId: selectedProjectId(),
    workflow: elements.workflow.value,
    mode: elements.chatMode.value,
  });
  chatSession = session;
  updateChatSessionDescription(session);
  if (session.intro !== '') appendChatEntry('assistant', session.intro);
  return session;
}

function restoreChatSettings(session) {
  const category = workflowCatalog.find((candidate) =>
    candidate.workflows.some((workflow) => workflow.id === session.workflow));
  if (category !== undefined) {
    elements.category.value = category.id;
    populateWorkflowSelect(session.workflow);
  }
  elements.chatMode.value = session.mode;
  updateExecutionContextSummary();
}

function describeChatSettingsChange(previous, next) {
  const changes = [];
  if (previous.workflow !== next.workflow) {
    changes.push(`workflow: ${previous.workflow} → ${next.workflow}`);
  }
  if (previous.mode !== next.mode) {
    changes.push(`mode: ${previous.mode} → ${next.mode}`);
  }
  return changes.join(' · ');
}

async function reconfigureActiveChatSession() {
  updateExecutionContextSummary();
  if (chatSession === null) return;
  const previous = chatSession;
  const request = {
    workflow: elements.workflow.value,
    mode: elements.chatMode.value,
  };
  if (previous.workflow === request.workflow && previous.mode === request.mode) return;

  setChatOperationInProgress(true);
  elements.chatStatus.textContent = '会話を引き継いで設定を切り替えています…';
  try {
    const next = await reconfigureChatSession(previous.id, request);
    chatSession = next;
    updateChatSessionDescription(next);
    appendChatEntry(
      'system',
      `${describeChatSettingsChange(previous, next)} · これまでの会話を引き継ぎました。`,
    );
    elements.chatStatus.textContent = '';
  } catch (error) {
    restoreChatSettings(previous);
    elements.chatStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setChatOperationInProgress(false);
  }
}

async function startNewConversation() {
  if (chatSession === null || chatOperationInProgress) return;
  setChatOperationInProgress(true);
  elements.chatStatus.textContent = '新しい会話を準備しています…';
  try {
    const session = await restartChatSession(chatSession.id);
    chatSession = session;
    updateChatSessionDescription(session);
    clearChatThinking();
    elements.chatTranscript.replaceChildren();
    if (session.intro === '') {
      renderChatPlaceholder();
    } else {
      appendChatEntry('assistant', session.intro);
    }
    elements.chatStatus.textContent = '新しい会話を開始しました。';
    elements.chatMessage.focus();
  } catch (error) {
    elements.chatStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setChatOperationInProgress(false);
  }
}

async function submitChat(event) {
  event.preventDefault();
  if (elements.chatSendButton.disabled) return;
  const text = elements.chatMessage.value.trim();
  if (text === '') {
    elements.chatStatus.textContent = EMPTY_CHAT_MESSAGE;
    return;
  }
  if (text === '/setup') {
    appendChatEntry('user', text);
    elements.chatMessage.value = '';
    chatMessageRevision += 1;
    resizeChatMessage();
    appendExecutionSettings();
    elements.chatStatus.textContent = '';
    return;
  }
  const messageRevision = chatMessageRevision;
  let messageWasCleared = false;
  let responseCompleted = false;
  setChatOperationInProgress(true);
  beginChatThinking();
  elements.chatStatus.dataset.busy = 'true';
  elements.chatStatus.textContent = 'AIが応答を作成しています…';
  try {
    const session = await ensureChatSession();
    appendChatEntry('user', text);
    if (chatMessageRevision === messageRevision && elements.chatMessage.value.trim() === text) {
      elements.chatMessage.value = '';
      resizeChatMessage();
      messageWasCleared = true;
    }
    const reply = await sendChatMessage(
      session.id,
      text,
      appendChatThinking,
    );
    if (reply.kind === 'assistant_response') {
      appendChatEntry('assistant', reply.content);
    } else if (reply.kind === 'task_instruction') {
      appendTaskInstruction(reply.task);
    } else {
      appendChatEntry('system', reply.message);
    }
    responseCompleted = reply.kind !== 'error';
    elements.chatStatus.textContent = '';
  } catch (error) {
    if (
      messageWasCleared
      && chatMessageRevision === messageRevision
      && elements.chatMessage.value === ''
    ) {
      elements.chatMessage.value = text;
      resizeChatMessage();
    }
    elements.chatStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    finishChatThinking(responseCompleted);
    delete elements.chatStatus.dataset.busy;
    setChatOperationInProgress(false);
  }
}

function stopLiveRunStream() {
  if (stopRunStream === null) return;
  stopRunStream();
  stopRunStream = null;
}

function startLiveRunStream() {
  stopLiveRunStream();
  if (!liveUpdatesEnabled || selectedRun === null) return;
  const expectedRun = { ...selectedRun };
  executionView.setLiveState('connecting');
  stopRunStream = subscribeRun(expectedRun.projectId, expectedRun.slug, {
    onSnapshot(detail) {
      if (sameRunSelectionState(selectedRun, expectedRun)) {
        executionView.renderDetail(detail, expectedRun);
      }
    },
    onConnectionChange(state) {
      if (!sameRunSelectionState(selectedRun, expectedRun)) return;
      executionView.setLiveState(state);
      elements.connection.textContent = state === 'live' ? 'Live' : '再接続中';
    },
    onError(error) {
      if (!sameRunSelectionState(selectedRun, expectedRun)) return;
      elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
    },
  });
}

async function selectRun(nextRun) {
  selectedRun = nextRun;
  elements.viewerScreen.dataset.mobileView = 'detail';
  executionView.renderTaskList(taskCollection.tasks, selectedRun);
  startLiveRunStream();
  if (liveUpdatesEnabled) return;
  try {
    const detail = await getRun(nextRun.projectId, nextRun.slug);
    executionView.renderDetail(detail, nextRun);
  } catch (error) {
    elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
  }
}

function applyTaskCollection(collection) {
  taskCollection = collection;
  const hasSelected = selectedRun !== null && collection.tasks.some(
    (task) => task.projectId === selectedRun.projectId
      && task.taskId === selectedRun.taskId
      && task.runs.some((run) => run.slug === selectedRun.slug),
  );
  const previous = selectedRun;
  if (!hasSelected) {
    const firstTask = collection.tasks.find((task) => task.runs.length > 0);
    const latestRun = firstTask?.runs.at(-1);
    selectedRun = firstTask === undefined || latestRun === undefined
      ? null
      : { projectId: firstTask.projectId, taskId: firstTask.taskId, slug: latestRun.slug };
  }
  executionView.renderTaskList(collection.tasks, selectedRun);
  elements.viewerScreen.dataset.mobileView = selectedRun === null ? 'list' : 'detail';
  updateWarnings(collection.warnings);
  if (selectedRun === null) {
    stopLiveRunStream();
    executionView.renderPlaceholder();
    return;
  }
  if (!sameRunSelectionState(previous, selectedRun)) startLiveRunStream();
}

async function requeueSelectedTask(task, button) {
  button.disabled = true;
  elements.runWarning.textContent = '';
  try {
    const result = await requeueTask(task.projectId, task.taskId);
    elements.chatStatus.textContent = result.disposition === 'reused'
      ? '失敗したtaskをキューへ戻しました。'
      : `taskの新しいrunを開始しました。PID: ${result.pid}`;
    await refreshRuns();
  } catch (error) {
    elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
}

async function refreshRuns() {
  if (refreshing || document.visibilityState === 'hidden') return;
  refreshing = true;
  try {
    const collection = await getTasks();
    applyTaskCollection(collection);
    if (selectedRun !== null) {
      const requestedRun = { ...selectedRun };
      try {
        const detail = await getRun(requestedRun.projectId, requestedRun.slug);
        if (sameRunSelectionState(selectedRun, requestedRun)) {
          executionView.renderDetail(detail, requestedRun);
        }
      } catch (error) {
        if (sameRunSelectionState(selectedRun, requestedRun)) throw error;
      }
    }
    elements.connection.textContent = liveUpdatesEnabled ? 'Live' : '接続済み';
  } catch (error) {
    elements.connection.textContent = '接続エラー';
    elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    refreshing = false;
  }
}

function startTaskStream() {
  if (!liveUpdatesEnabled || stopTaskStream !== null) return;
  stopTaskStream = subscribeTasks({
    onSnapshot(collection) {
      applyTaskCollection(collection);
    },
    onConnectionChange(state) {
      elements.connection.textContent = state === 'live' ? 'Live' : '再接続中';
    },
    onError(error) {
      elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
    },
  });
}

function setLiveUpdatesEnabled(enabled) {
  if (enabled === liveUpdatesEnabled && (enabled ? stopTaskStream !== null : true)) return;
  liveUpdatesEnabled = enabled;
  if (enabled) {
    startTaskStream();
    startLiveRunStream();
  } else {
    if (stopTaskStream !== null) stopTaskStream();
    stopTaskStream = null;
    stopLiveRunStream();
    executionView.setLiveState('paused');
    elements.connection.textContent = '手動更新';
  }
  elements.watch.setAttribute('aria-pressed', String(enabled));
  elements.watch.textContent = enabled ? 'Live on' : 'Live off';
}

async function initialize() {
  initializeChatDrawer();
  resizeChatMessage();
  try {
    const session = await getSession();
    elements.directoryNativePicker.hidden = !session.capabilities.nativeDirectoryPicker;
    elements.directoryPicker.disabled = false;
    await refreshProjects('');
    await refreshRuns();
    startTaskStream();
  } catch (error) {
    elements.connection.textContent = '初期化エラー';
    elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
  }
}

function closeExecutionContext() {
  if (!elements.executionContext.open) return;
  elements.executionContext.open = false;
  elements.executionContextToggle.focus();
}

function closeExecutionContextFromOutside(event) {
  if (elements.executionContext.open && shouldCloseExecutionContext(
    event,
    elements.executionContext,
    elements.directoryDialog,
  )) {
    closeExecutionContext();
  }
}

document.addEventListener('pointerdown', closeExecutionContextFromOutside);
document.addEventListener('click', closeExecutionContextFromOutside);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (screenMode === 'viewer' && chatDrawerOpen) {
    event.preventDefault();
    closeChatDrawer();
    return;
  }
  if (!elements.executionContext.open) return;
  const eventPath = typeof event.composedPath === 'function'
    ? event.composedPath()
    : [event.target];
  if (elements.directoryDialog.open && eventPath.includes(elements.directoryDialog)) return;
  event.preventDefault();
  closeExecutionContext();
});

elements.chatForm.addEventListener('submit', (event) => void submitChat(event));
elements.chatSetupButton.addEventListener('click', submitSetupCommand);
elements.chatGoButton.addEventListener('click', submitGoCommand);
elements.chatNewButton.addEventListener('click', () => void startNewConversation());
elements.aiConsultButton.addEventListener('click', openChatDrawer);
elements.viewerNav.addEventListener('click', () => setScreen('viewer'));
elements.newTaskButton.addEventListener('click', () => setScreen('task'));
elements.mobileTaskListButton.addEventListener('click', () => {
  elements.viewerScreen.dataset.mobileView = 'list';
});
elements.chatCollapseButton.addEventListener('click', closeChatDrawer);
elements.chatResizer.addEventListener('pointerdown', startChatDrawerResize);
elements.chatResizer.addEventListener('pointermove', (event) => {
  if (elements.chatResizer.hasPointerCapture(event.pointerId)) resizeChatDrawerFromPointer(event);
});
elements.chatResizer.addEventListener('pointerup', stopChatDrawerResize);
elements.chatResizer.addEventListener('pointercancel', stopChatDrawerResize);
elements.chatResizer.addEventListener('lostpointercapture', () => {
  delete elements.chatSurface.dataset.resizing;
});
elements.chatResizer.addEventListener('keydown', resizeChatDrawerWithKeyboard);
elements.chatMessage.addEventListener('input', handleChatMessageInput);
elements.chatMessage.addEventListener('keydown', submitChatWithShortcut);
elements.directoryPicker.addEventListener('click', openDirectoryPicker);
elements.directoryClose.addEventListener('click', closeDirectoryPicker);
elements.directoryCancel.addEventListener('click', closeDirectoryPicker);
elements.directoryDialog.addEventListener('close', () => {
  directoryRequests.closeDialog();
  syncDirectoryControls();
});
elements.directoryDialog.addEventListener('click', (event) => {
  if (event.target === elements.directoryDialog) closeDirectoryPicker();
});
elements.directoryNativePicker.addEventListener('click', () => void openNativeDirectoryPicker());
elements.directoryGo.addEventListener('click', () => {
  void loadDirectory(elements.directoryCurrentPath.value.trim());
});
elements.directoryCurrentPath.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void loadDirectory(elements.directoryCurrentPath.value.trim());
});
elements.directoryCurrentPath.addEventListener('input', () => {
  const path = elements.directoryCurrentPath.value.trim();
  if (!directoryRequests.hasPendingOperation() && browsedDirectory?.path === path) {
    syncDirectoryControls();
    return;
  }
  directoryRequests.invalidateRequest();
  browsedDirectory = null;
  renderDirectoryEmptyState('Enterまたは「移動」でディレクトリを開きます。');
  syncDirectoryControls();
});
elements.directoryParent.addEventListener('click', () => {
  if (browsedDirectory !== null && browsedDirectory.parent !== null) {
    void loadDirectory(browsedDirectory.parent);
  }
});
elements.directorySelect.addEventListener('click', () => void selectBrowsedDirectory());
elements.category.addEventListener('change', () => {
  populateWorkflowSelect();
  void reconfigureActiveChatSession();
});
elements.project.addEventListener('change', () => {
  const requestedProjectId = selectedProjectId();
  resetChatSession();
  setExecutionEnabled(false);
  void loadWorkflowsForProject()
    .then(({ request, ok, error }) => {
      if (!isCurrentWorkflowRequest(request) || selectedProjectId() !== requestedProjectId) return;
      if (!ok) {
        setExecutionEnabled(false);
        elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
        return;
      }
      setExecutionEnabled(workflowCatalogReady(requestedProjectId));
      updateExecutionContextSummary();
    });
});
elements.workflow.addEventListener('change', () => {
  void reconfigureActiveChatSession();
});
elements.chatMode.addEventListener('change', () => void reconfigureActiveChatSession());
elements.refresh.addEventListener('click', () => {
  void refreshProjects(selectedProjectId()).then((applied) => {
    if (applied) return refreshRuns();
    return undefined;
  }).catch((error) => {
    elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
  });
});
elements.watch.addEventListener('click', () => {
  setLiveUpdatesEnabled(!liveUpdatesEnabled);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && liveUpdatesEnabled) void refreshRuns();
});
window.addEventListener('beforeunload', () => {
  if (stopTaskStream !== null) stopTaskStream();
  stopLiveRunStream();
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 760) {
    updateChatDrawerWidthForLayout();
  }
});
void initialize();
