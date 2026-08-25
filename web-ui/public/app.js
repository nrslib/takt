import {
  browseDirectories,
  createChatSession,
  getRun,
  getRuns,
  getProjects,
  getSession,
  getWorkflows,
  pickNativeDirectory,
  reconfigureChatSession,
  registerProject,
  restartChatSession,
  sendChatMessage,
  startRun,
} from './api.js';
import {
  clampChatPaneWidth,
  captureRunDetailViewState,
  createDirectoryRequestTracker,
  getChatPaneWidthBounds,
  isCurrentWorkflowRequest as isCurrentWorkflowRequestState,
  isWorkflowCatalogReady,
  projectSelectionForRefresh,
  resolveChatPaneWidth,
  restoreRunDetailViewState,
  sameRunSelection as sameRunSelectionState,
  shouldCloseExecutionContext,
} from './ui-state.js';

const EMPTY_CHAT_MESSAGE = 'メッセージを入力してください。';
const CHAT_RESIZE_STEP = 16;

const elements = {
  connection: document.querySelector('#connection-status'),
  category: document.querySelector('#category'),
  chatForm: document.querySelector('#chat-form'),
  chatCollapseButton: document.querySelector('#chat-collapse-button'),
  chatResizer: document.querySelector('#chat-resizer'),
  chatMessage: document.querySelector('#chat-message'),
  chatMode: document.querySelector('#chat-mode'),
  chatNewButton: document.querySelector('#chat-new-button'),
  chatSendButton: document.querySelector('#chat-send-button'),
  chatSessionMeta: document.querySelector('#chat-session-meta'),
  chatStatus: document.querySelector('#chat-message-status'),
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
  project: document.querySelector('#project'),
  projectHelp: document.querySelector('#project-help'),
  refresh: document.querySelector('#refresh-button'),
  runDetail: document.querySelector('#run-detail'),
  runStatusLive: document.querySelector('#run-status-live'),
  runList: document.querySelector('#run-list'),
  runListEmpty: document.querySelector('#run-list-empty'),
  runWarning: document.querySelector('#run-warning'),
  workflow: document.querySelector('#workflow'),
  workspace: document.querySelector('.workspace'),
};

const directoryRequests = createDirectoryRequestTracker();

let sessionToken = '';
let selectedRun = null;
let refreshing = false;
let workflowCatalog = [];
let workflowCatalogProjectId = '';
let workflowRequestId = 0;
let projectRefreshGeneration = 0;
let chatSession = null;
let registryWarnings = [];
let workflowWarnings = [];
let browsedDirectory = null;
let chatPaneWidth = null;
let chatPaneWidthManuallyAdjusted = false;
let executionEnabled = false;
let chatOperationInProgress = false;
let chatMessageRevision = 0;

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className !== '') element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatDate(value) {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP');
}

function statusLabel(status) {
  const labels = {
    running: 'RUNNING',
    completed: 'COMPLETED',
    aborted: 'ABORTED',
    failed: 'FAILED',
  };
  return labels[status];
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
    const directory = await browseDirectories(sessionToken, path);
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
    const result = await pickNativeDirectory(sessionToken);
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
    const directory = await browseDirectories(sessionToken, requestedPath);
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    renderBrowsedDirectory(directory);
    const project = await registerProject(sessionToken, directory.path);
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

function resetChatSession() {
  chatSession = null;
  elements.chatSessionMeta.textContent = '会話はまだ始まっていません。';
  elements.chatStatus.textContent = '';
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

function appendTaskInstruction(task) {
  const entry = createElement('article', 'chat-entry chat-entry-task');
  entry.append(
    createElement('span', 'chat-role', 'TASK'),
    createElement('pre', '', task),
  );
  const button = createElement('button', 'secondary-button', 'この指示で実行');
  button.type = 'button';
  button.addEventListener('click', () => void launchTaskInstruction(task, button));
  entry.append(button);
  elements.chatTranscript.append(entry);
  elements.chatTranscript.scrollTop = elements.chatTranscript.scrollHeight;
}

async function launchTaskInstruction(task, button) {
  button.disabled = true;
  elements.chatStatus.textContent = 'runを開始しています…';
  try {
    const result = await startRun(sessionToken, {
      projectId: selectedProjectId(),
      prompt: task,
      workflow: elements.workflow.value,
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

function setChatPaneWidth(requestedWidth) {
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  const bounds = getChatPaneWidthBounds(workspaceWidth);
  chatPaneWidth = clampChatPaneWidth(requestedWidth, workspaceWidth);
  elements.workspace.style.setProperty('--chat-pane-width', `${chatPaneWidth}px`);
  elements.chatResizer.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
  elements.chatResizer.setAttribute('aria-valuenow', String(Math.round(chatPaneWidth)));
}

function setChatPaneWidthFromUser(requestedWidth) {
  chatPaneWidthManuallyAdjusted = true;
  setChatPaneWidth(requestedWidth);
}

function setChatPaneCollapsed(collapsed) {
  elements.workspace.dataset.chatCollapsed = String(collapsed);
  elements.chatCollapseButton.setAttribute('aria-expanded', String(!collapsed));
  elements.chatCollapseButton.setAttribute(
    'aria-label',
    collapsed ? 'Chatを展開' : 'Chatを折りたたむ',
  );
  elements.chatCollapseButton.title = collapsed ? 'Chatを展開' : 'Chatを折りたたむ';
  elements.chatCollapseButton.textContent = collapsed ? '›' : '‹';
  elements.chatResizer.tabIndex = collapsed ? -1 : 0;
}

function resizeChatPaneFromPointer(event) {
  const workspaceLeft = elements.workspace.getBoundingClientRect().left;
  setChatPaneWidthFromUser(event.clientX - workspaceLeft);
}

function startChatPaneResize(event) {
  if (event.button !== 0 || elements.workspace.dataset.chatCollapsed === 'true') return;
  event.preventDefault();
  elements.chatResizer.setPointerCapture(event.pointerId);
  elements.workspace.dataset.resizingChat = 'true';
  resizeChatPaneFromPointer(event);
}

function stopChatPaneResize(event) {
  if (elements.chatResizer.hasPointerCapture(event.pointerId)) {
    elements.chatResizer.releasePointerCapture(event.pointerId);
  }
  delete elements.workspace.dataset.resizingChat;
}

function resizeChatPaneWithKeyboard(event) {
  if (elements.workspace.dataset.chatCollapsed === 'true') return;
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  const bounds = getChatPaneWidthBounds(workspaceWidth);
  if (chatPaneWidth === null) return;
  const currentWidth = chatPaneWidth;
  const widths = {
    ArrowLeft: currentWidth - CHAT_RESIZE_STEP,
    ArrowRight: currentWidth + CHAT_RESIZE_STEP,
    Home: bounds.min,
    End: bounds.max,
  };
  const requestedWidth = widths[event.key];
  if (requestedWidth === undefined) return;
  event.preventDefault();
  setChatPaneWidthFromUser(requestedWidth);
}

function initializeChatPane() {
  chatPaneWidthManuallyAdjusted = false;
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  setChatPaneWidth(resolveChatPaneWidth(
    workspaceWidth,
    workspaceWidth / 2,
    false,
  ));
  setChatPaneCollapsed(false);
}

function updateChatPaneWidthForLayout() {
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  if (chatPaneWidthManuallyAdjusted && chatPaneWidth !== null) {
    setChatPaneWidth(resolveChatPaneWidth(workspaceWidth, chatPaneWidth, true));
    return;
  }
  setChatPaneWidth(resolveChatPaneWidth(workspaceWidth, workspaceWidth / 2, false));
}

async function ensureChatSession() {
  if (chatSession !== null) return chatSession;
  const session = await createChatSession(sessionToken, {
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
    const next = await reconfigureChatSession(sessionToken, previous.id, request);
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
    const session = await restartChatSession(sessionToken, chatSession.id);
    chatSession = session;
    updateChatSessionDescription(session);
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
  const messageRevision = chatMessageRevision;
  let messageWasCleared = false;
  setChatOperationInProgress(true);
  elements.chatStatus.textContent = 'AIが応答を作成しています…';
  try {
    const session = await ensureChatSession();
    appendChatEntry('user', text);
    if (chatMessageRevision === messageRevision && elements.chatMessage.value.trim() === text) {
      elements.chatMessage.value = '';
      resizeChatMessage();
      messageWasCleared = true;
    }
    const reply = await sendChatMessage(sessionToken, session.id, text);
    if (reply.kind === 'assistant_response') {
      appendChatEntry('assistant', reply.content);
    } else if (reply.kind === 'task_instruction') {
      appendTaskInstruction(reply.task);
    } else {
      appendChatEntry('system', reply.message);
    }
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
    setChatOperationInProgress(false);
  }
}

function renderRunList(runs) {
  elements.runList.replaceChildren();
  elements.runListEmpty.hidden = runs.length !== 0;
  for (const run of runs) {
    const button = createElement('button', 'run-card');
    button.type = 'button';
    button.dataset.selected = String(
      run.slug === selectedRun?.slug && run.projectId === selectedRun?.projectId,
    );
    button.addEventListener('click', () => {
      selectedRun = { projectId: run.projectId, slug: run.slug };
      void refreshRuns();
    });

    const top = createElement('span', 'run-card-top');
    top.append(
      createElement('span', `status-badge status-${run.status}`, statusLabel(run.status)),
      createElement('time', 'run-time', formatDate(run.startTime)),
    );
    button.append(
      top,
      createElement('strong', 'run-task', run.task),
      createElement(
        'span',
        'run-meta',
        `${run.projectName} · ${run.workflow} · ${run.currentStep ?? '待機中'}`,
      ),
    );
    elements.runList.append(button);
  }
}

function detailRow(label, value) {
  const row = createElement('div', 'detail-row');
  row.append(createElement('dt', '', label), createElement('dd', '', value));
  return row;
}

function renderReports(reports) {
  const section = createElement('section', 'reports');
  section.append(createElement('h3', '', `Reports (${reports.length})`));
  if (reports.length === 0) {
    section.append(createElement('p', 'empty-state', 'reportはまだありません。'));
    return section;
  }
  for (const report of reports) {
    const details = createElement('details', 'report');
    details.dataset.reportFilename = report.filename;
    details.append(createElement('summary', '', report.filename));
    details.append(createElement(
      'pre',
      '',
      report.omitted ? 'ファイルサイズが表示上限を超えています。' : report.content,
    ));
    section.append(details);
  }
  return section;
}

function eventTitle(event) {
  const location = [event.step, event.phaseName].filter(Boolean).join(' / ');
  return location === '' ? event.type : `${event.type} · ${location}`;
}

function renderLogEvents(events) {
  const section = createElement('section', 'run-log');
  section.append(createElement('h3', '', `Live log (${events.length})`));
  if (events.length === 0) {
    section.append(createElement('p', 'empty-state', '実行ログはまだありません。'));
    return section;
  }
  const list = createElement('ol', 'log-events');
  for (const event of events) {
    const item = createElement('li', 'log-event');
    const header = createElement('div', 'log-event-header');
    header.append(
      createElement('strong', '', eventTitle(event)),
      createElement('time', '', formatDate(event.timestamp)),
    );
    item.append(header);
    if (event.status !== undefined) {
      item.append(createElement('span', 'log-event-status', event.status));
    }
    if (event.content !== undefined) {
      item.append(createElement('pre', '', event.content));
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderRunDetail(detail, expectedRun) {
  const { meta, reports, events, project } = detail;
  if (!sameRunSelectionState(
    { projectId: project.id, slug: meta.runSlug },
    expectedRun,
  )) return false;
  const viewState = elements.runDetail.dataset.projectId === expectedRun.projectId
    && elements.runDetail.dataset.runSlug === expectedRun.slug
    ? captureRunDetailViewState(elements.runDetail)
    : null;
  const header = createElement('header', 'detail-header');
  header.append(
    createElement('span', `status-badge status-${meta.status}`, statusLabel(meta.status)),
    createElement('h2', '', meta.workflow),
    createElement('p', 'detail-slug', `${project.projectDirectory} · ${meta.runSlug}`),
  );

  const progress = createElement('dl', 'detail-grid');
  progress.append(
    detailRow('Current step', meta.currentStep ?? '待機中'),
    detailRow('Iteration', meta.currentIteration === undefined ? '—' : String(meta.currentIteration)),
    detailRow('Phase', meta.phase === undefined ? '—' : String(meta.phase)),
    detailRow('Updated', formatDate(meta.updatedAt)),
  );

  const task = createElement('section', 'task-detail');
  task.append(createElement('h3', '', 'Task'), createElement('pre', '', meta.task));
  elements.runDetail.dataset.projectId = expectedRun.projectId;
  elements.runDetail.dataset.runSlug = expectedRun.slug;
  elements.runDetail.replaceChildren(
    header,
    progress,
    task,
    renderLogEvents(events),
    renderReports(reports),
  );
  if (viewState !== null) restoreRunDetailViewState(elements.runDetail, viewState);
  const status = statusLabel(meta.status);
  if (elements.runStatusLive.textContent !== status) elements.runStatusLive.textContent = status;
  return true;
}

async function refreshRuns() {
  if (refreshing || document.visibilityState === 'hidden') return;
  refreshing = true;
  try {
    const collection = await getRuns();
    const hasSelected = selectedRun !== null && collection.runs.some(
      (run) => run.slug === selectedRun.slug && run.projectId === selectedRun.projectId,
    );
    if (!hasSelected) {
      const first = collection.runs[0];
      selectedRun = first === undefined ? null : { projectId: first.projectId, slug: first.slug };
    }
    renderRunList(collection.runs);
    updateWarnings(collection.warnings);
    if (selectedRun !== null) {
      const requestedRun = { ...selectedRun };
      try {
        const detail = await getRun(requestedRun.projectId, requestedRun.slug);
        if (sameRunSelectionState(selectedRun, requestedRun)) {
          renderRunDetail(detail, requestedRun);
        }
      } catch (error) {
        if (sameRunSelectionState(selectedRun, requestedRun)) throw error;
      }
    }
    elements.connection.textContent = '接続済み';
  } catch (error) {
    elements.connection.textContent = '接続エラー';
    elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    refreshing = false;
  }
}

async function initialize() {
  initializeChatPane();
  resizeChatMessage();
  try {
    const session = await getSession();
    sessionToken = session.token;
    elements.directoryNativePicker.hidden = !session.capabilities.nativeDirectoryPicker;
    elements.directoryPicker.disabled = false;
    await refreshProjects('');
    await refreshRuns();
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
  if (event.key !== 'Escape' || !elements.executionContext.open) return;
  const eventPath = typeof event.composedPath === 'function'
    ? event.composedPath()
    : [event.target];
  if (elements.directoryDialog.open && eventPath.includes(elements.directoryDialog)) return;
  event.preventDefault();
  closeExecutionContext();
});

elements.chatForm.addEventListener('submit', (event) => void submitChat(event));
elements.chatNewButton.addEventListener('click', () => void startNewConversation());
elements.chatCollapseButton.addEventListener('click', () => {
  setChatPaneCollapsed(elements.workspace.dataset.chatCollapsed !== 'true');
});
elements.chatResizer.addEventListener('pointerdown', startChatPaneResize);
elements.chatResizer.addEventListener('pointermove', (event) => {
  if (elements.chatResizer.hasPointerCapture(event.pointerId)) resizeChatPaneFromPointer(event);
});
elements.chatResizer.addEventListener('pointerup', stopChatPaneResize);
elements.chatResizer.addEventListener('pointercancel', stopChatPaneResize);
elements.chatResizer.addEventListener('lostpointercapture', () => {
  delete elements.workspace.dataset.resizingChat;
});
elements.chatResizer.addEventListener('keydown', resizeChatPaneWithKeyboard);
elements.chatMessage.addEventListener('input', handleChatMessageInput);
elements.chatMessage.addEventListener('keydown', submitChatWithShortcut);
elements.directoryPicker.addEventListener('click', openDirectoryPicker);
elements.directoryClose.addEventListener('click', closeDirectoryPicker);
elements.directoryCancel.addEventListener('click', closeDirectoryPicker);
elements.directoryDialog.addEventListener('close', () => {
  directoryRequests.closeDialog();
  syncDirectoryControls();
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshRuns();
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 900) {
    updateChatPaneWidthForLayout();
  }
});
setInterval(() => void refreshRuns(), 2000);
void initialize();
