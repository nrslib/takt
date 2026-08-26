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
  isCurrentRunRequest as isCurrentRunRequestState,
  isCurrentWorkflowRequest as isCurrentWorkflowRequestState,
  isWorkflowCatalogReady,
  projectSelectionForRefresh,
  sameRunSelection as sameRunSelectionState,
  snapshotExecutionSettings,
  shouldCloseExecutionContext,
} from './ui-state.js';
import {
  applyTranslations,
  getLocale,
  setLocale,
  subscribeLocaleChange,
  t,
} from './i18n.js';

const EMPTY_CHAT_MESSAGE_KEY = 'app.emptyMessage';

const elements = {
  connection: document.querySelector('#connection-status'),
  category: document.querySelector('#category'),
  chatForm: document.querySelector('#chat-form'),
  chatGoButton: document.querySelector('#chat-go-button'),
  chatSetupButton: document.querySelector('#chat-setup-button'),
  chatCollapseButton: document.querySelector('#chat-collapse-button'),
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
  languageToggle: document.querySelector('#language-toggle'),
  newTaskButton: document.querySelector('#new-task-button'),
  viewerNav: document.querySelector('#viewer-nav'),
  viewerScreen: document.querySelector('#viewer-screen'),
  mobileTaskListButton: document.querySelector('#mobile-task-list-button'),
  mobileInspectorButton: document.querySelector('#mobile-inspector-button'),
  taskCount: document.querySelector('#task-count'),
  project: document.querySelector('#project'),
  projectHelp: document.querySelector('#project-help'),
  refresh: document.querySelector('#refresh-button'),
  runDetail: document.querySelector('#run-detail'),
  runInspector: document.querySelector('#run-inspector'),
  runStatusLive: document.querySelector('#run-status-live'),
  runList: document.querySelector('#run-list'),
  runListEmpty: document.querySelector('#run-list-empty'),
  runWarning: document.querySelector('#run-warning'),
  watch: document.querySelector('#watch-button'),
  workflow: document.querySelector('#workflow'),
};

const directoryRequests = createDirectoryRequestTracker();

let selectedRun = null;
let runSelectionGeneration = 0;
let liveSnapshotRevision = 0;
let refreshing = false;
let stopTaskStream = null;
let stopRunStream = null;
let liveStreamGeneration = 0;
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
let taskSurfaceOpen = false;
let screenMode = 'viewer';
let screenTransitionId = 0;
let screenTransitionTimer = null;
let executionEnabled = false;
let chatOperationInProgress = false;
let chatMessageRevision = 0;
let chatStatusDescriptor = null;
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
  inspector: elements.runInspector,
  onSelectRun: selectRun,
  onRequeue: (task, button) => void requeueSelectedTask(task, button),
  onStatusChange: (status) => {
    const label = t(`app.status.${status}`);
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
    elements.executionContextSummary.textContent = t('app.chooseContext');
    return;
  }
  const projectName = projectOption?.textContent?.split(' — ')[0] ?? t('app.executionTarget');
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

function setChatStatusRaw(message) {
  chatStatusDescriptor = null;
  elements.chatStatus.textContent = message;
}

function setChatStatusMessage(key, variables = {}) {
  chatStatusDescriptor = { key, variables };
  elements.chatStatus.textContent = t(key, variables);
}

function populateProjects(snapshot, preferredProjectId = '') {
  const previousProjectId = selectedProjectId();
  registryWarnings = [...snapshot.warnings];
  elements.project.replaceChildren();
  const availableProjects = snapshot.projects.filter((candidate) => candidate.available);
  const placeholder = createElement('option', '', t('app.executionDirectory'));
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
  elements.projectHelp.textContent = t(available ? 'app.projectHelpAvailable' : 'app.projectHelpEmpty');
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
    renderDirectoryEmptyState(t('app.noChildDirectories'));
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
  elements.directoryMessage.textContent = t('app.directoryLoading');
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
  elements.directoryMessage.textContent = t('app.finder');
  try {
    const result = await pickNativeDirectory();
    if (!directoryRequests.isCurrent(directoryRequest)) return;
    if (result.cancelled) {
      elements.directoryMessage.textContent = t('app.directoryCancelled');
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
  elements.directoryMessage.textContent = t('app.directoryRegistered');
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
      elements.directoryMessage.textContent = t('app.directoryUnavailable');
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
    createElement('strong', '', t('app.startConversation')),
    createElement('span', '', t('app.startConversationDescription')),
  );
  elements.chatTranscript.replaceChildren(placeholder);
}

function clearChatThinking() {
  elements.chatThinking.hidden = true;
  elements.chatThinking.open = false;
  elements.chatThinking.dataset.active = 'false';
  elements.chatThinkingContent.textContent = '';
  elements.chatThinking.dataset.stateKey = 'app.waitingResponse';
  elements.chatThinkingLabel.textContent = t('app.thinking');
  elements.chatThinkingState.textContent = t('app.waitingResponse');
}

function beginChatThinking() {
  elements.chatThinking.hidden = false;
  elements.chatThinking.open = false;
  elements.chatThinking.dataset.active = 'true';
  elements.chatThinkingContent.textContent = '';
  elements.chatThinking.dataset.stateKey = 'app.waitingResponse';
  elements.chatThinkingLabel.textContent = t('app.thinking');
  elements.chatThinkingState.textContent = t('app.waitingResponse');
}

function appendChatThinking(content) {
  elements.chatThinking.open = true;
  elements.chatThinkingContent.textContent += content;
  elements.chatThinking.dataset.stateKey = 'app.receiving';
  elements.chatThinkingState.textContent = t('app.receiving');
  elements.chatThinkingContent.scrollTop = elements.chatThinkingContent.scrollHeight;
}

function finishChatThinking(completed) {
  elements.chatThinking.dataset.active = 'false';
  if (elements.chatThinkingContent.textContent === '') {
    clearChatThinking();
    return;
  }
  elements.chatThinking.open = false;
  elements.chatThinking.dataset.stateKey = completed ? 'app.completed' : 'app.interrupted';
  elements.chatThinkingLabel.textContent = t('app.thinkingLabel');
  elements.chatThinkingState.textContent = completed ? t('app.completed') : t('app.interrupted');
}

function resetChatSession() {
  chatSession = null;
  elements.chatSessionMeta.textContent = t('app.startConversation');
  setChatStatusRaw('');
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
  const roleKey = role === 'user'
    ? 'app.roleUser'
    : role === 'assistant' ? 'app.roleAssistant' : 'app.roleSystem';
  const roleLabel = createElement('span', 'chat-role', t(roleKey));
  roleLabel.dataset.i18n = roleKey;
  entry.append(
    roleLabel,
    createElement('p', '', content),
  );
  elements.chatTranscript.querySelector('.chat-placeholder')?.remove();
  elements.chatTranscript.append(entry);
  elements.chatTranscript.scrollTop = elements.chatTranscript.scrollHeight;
}

function createSettingsField(labelKey, control) {
  const field = createElement('label', 'chat-setting-field');
  const label = createElement('span', '', t(labelKey));
  label.dataset.i18n = labelKey;
  field.append(label, control);
  return field;
}

function executionSettingsSummary(settings = executionSettings) {
  const worktree = settings.worktreeMode === 'none'
    ? t('app.worktreeNone')
    : settings.worktreeMode === 'custom'
      ? settings.worktreePath
      : t('app.worktreeAuto');
  return [
    `${t('app.worktree')}: ${worktree}`,
    `${t('app.branchName')}: ${settings.branch || t('app.worktreeAuto')}`,
    `${t('app.baseBranch')}: ${settings.baseBranch || t('app.defaultBranch')}`,
    `${t('app.autoCreatePr')}: ${settings.autoPr ? t('app.yes') : t('app.no')}`,
    `${t('app.createDraft')}: ${settings.draftPr ? t('app.yes') : t('app.no')}`,
  ].join(' · ');
}

function settingsSummaryElement(settings) {
  const summary = createElement('p', 'chat-settings-summary', executionSettingsSummary(settings));
  summary.dataset.settingsSummary = 'true';
  summary.dataset.settingsSnapshot = JSON.stringify(settings);
  return summary;
}

function appendExecutionSettings() {
  const entry = createElement('article', 'chat-entry chat-entry-settings');
  const role = createElement('span', 'chat-role', t('app.roleSetup'));
  role.dataset.i18n = 'app.roleSetup';
  entry.append(
    role,
    (() => {
      const intro = createElement('p', 'chat-settings-intro', t('app.settingsIntro'));
      intro.dataset.i18n = 'app.settingsIntro';
      return intro;
    })(),
  );
  const form = createElement('form', 'chat-settings-form');
  const worktreeMode = document.createElement('select');
  for (const [value, label] of [
    ['auto', 'app.worktreeAuto'],
    ['custom', 'app.worktreeCustom'],
    ['none', 'app.worktreeNone'],
  ]) {
    const option = createElement('option', '', t(label));
    option.dataset.i18n = label;
    option.value = value;
    option.selected = executionSettings.worktreeMode === value;
    worktreeMode.append(option);
  }
  const worktreePath = document.createElement('input');
  worktreePath.type = 'text';
  worktreePath.value = executionSettings.worktreePath;
  worktreePath.placeholder = t('app.worktreePlaceholder');
  worktreePath.dataset.i18nPlaceholder = 'app.worktreePlaceholder';
  const branch = document.createElement('input');
  branch.type = 'text';
  branch.value = executionSettings.branch;
  branch.placeholder = t('app.autoGenerated');
  branch.dataset.i18nPlaceholder = 'app.autoGenerated';
  const baseBranch = document.createElement('input');
  baseBranch.type = 'text';
  baseBranch.value = executionSettings.baseBranch;
  baseBranch.placeholder = t('app.defaultBranch');
  baseBranch.dataset.i18nPlaceholder = 'app.defaultBranch';
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
  const save = createElement('button', 'secondary-button', t('app.saveSettings'));
  save.dataset.i18n = 'app.saveSettings';
  save.type = 'submit';
  form.append(
    createSettingsField('app.worktree', worktreeMode),
    createSettingsField('app.worktreePath', worktreePath),
    createSettingsField('app.branchName', branch),
    createSettingsField('app.baseBranch', baseBranch),
    createSettingsField('app.autoCreatePr', autoPr),
    createSettingsField('app.createDraft', draftPr),
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
      setChatStatusMessage('app.enterWorktreePath');
      worktreePath.focus();
      return;
    }
    executionSettings = next;
    form.replaceChildren(settingsSummaryElement(executionSettings));
    setChatStatusMessage('app.settingsSaved');
  });
  entry.append(form);
  elements.chatTranscript.querySelector('.chat-placeholder')?.remove();
  elements.chatTranscript.append(entry);
  elements.chatTranscript.scrollTop = elements.chatTranscript.scrollHeight;
}

function appendTaskInstruction(task) {
  const settings = snapshotExecutionSettings(executionSettings);
  const entry = createElement('article', 'chat-entry chat-entry-task');
  const role = createElement('span', 'chat-role', t('app.roleTask'));
  role.dataset.i18n = 'app.roleTask';
  const settingsSummary = settingsSummaryElement(settings);
  entry.append(
    role,
    createElement('pre', '', task),
    settingsSummary,
  );
  const button = createElement('button', 'secondary-button', t('app.runFromInstruction'));
  button.dataset.i18n = 'app.runFromInstruction';
  button.dataset.i18nAriaLabel = 'app.runFromInstructionAria';
  button.setAttribute('aria-label', t('app.runFromInstructionAria'));
  button.type = 'button';
  button.addEventListener('click', () => void launchTaskInstruction(task, settings, button));
  entry.append(button);
  elements.chatTranscript.append(entry);
  elements.chatTranscript.scrollTop = elements.chatTranscript.scrollHeight;
}

async function launchTaskInstruction(task, settings, button) {
  button.disabled = true;
  setChatStatusMessage('app.taskStarting');
  try {
    const result = await startTask({
      projectId: selectedProjectId(),
      prompt: task,
      workflow: elements.workflow.value,
      ...buildExecutionSettingsRequest(settings),
    });
    const modeLabel = result.mode === 'watch' ? 'watch' : 'run';
    const dispositionLabel = result.disposition === 'reused'
      ? t('app.startDispositionQueued')
      : t('app.startDispositionStarted');
    setChatStatusMessage('app.taskStartedStatus', {
      message: dispositionLabel,
      mode: modeLabel,
      pid: result.pid,
    });
    button.textContent = `${result.disposition === 'reused' ? t('app.queued') : t('app.started')} · ${modeLabel} · PID ${result.pid}`;
    button.dataset.launchDisposition = result.disposition;
    button.dataset.launchMode = modeLabel;
    button.dataset.launchPid = String(result.pid);
    await refreshRuns();
  } catch (error) {
    setChatStatusRaw(error instanceof Error ? error.message : String(error));
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
  if (elements.chatStatus.textContent === t(EMPTY_CHAT_MESSAGE_KEY)) {
    setChatStatusRaw('');
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

function setTaskSurfaceOpen(open) {
  taskSurfaceOpen = open;
  elements.chatSurface.dataset.open = String(open);
  elements.chatSurface.setAttribute('aria-hidden', String(!open));
  elements.chatSurface.inert = !open;
  elements.chatCollapseButton.setAttribute('aria-expanded', String(open));
}

function setScreen(nextScreen) {
  if (nextScreen !== 'viewer' && nextScreen !== 'task') return;
  if (screenMode === nextScreen && screenTransitionTimer === null) return;
  screenTransitionId += 1;
  const transitionId = screenTransitionId;
  if (screenTransitionTimer !== null) window.clearTimeout(screenTransitionTimer);
  screenTransitionTimer = null;
  screenMode = nextScreen;
  const isTaskScreen = nextScreen === 'task';
  elements.viewerNav.classList.toggle('nav-button-active', !isTaskScreen);
  elements.viewerNav.setAttribute('aria-current', isTaskScreen ? 'false' : 'page');
  elements.newTaskButton.classList.toggle('nav-button-active', isTaskScreen);
  elements.newTaskButton.setAttribute('aria-current', isTaskScreen ? 'page' : 'false');
  elements.viewerScreen.inert = isTaskScreen;
  elements.viewerScreen.setAttribute('aria-hidden', String(isTaskScreen));
  elements.chatCollapseButton.hidden = false;
  elements.chatSurfaceLabel.textContent = t('app.newTask');
  elements.chatTitle.textContent = t('app.createTask');
  elements.chatSurfaceDescription.textContent = t('app.startConversationDescription');
  elements.chatSurface.dataset.transition = isTaskScreen ? 'entering' : 'exiting';
  if (isTaskScreen) {
    document.body.dataset.screen = 'task';
    setTaskSurfaceOpen(true);
    requestAnimationFrame(() => {
      if (transitionId !== screenTransitionId) return;
      elements.chatSurface.dataset.transition = 'entered';
      elements.chatMessage.focus();
    });
  } else {
    // Keep the surface interactive until the right-origin exit transition has
    // completed. This prevents an abrupt focus/inert change halfway through
    // the animation and lets repeated navigation settle on the latest state.
    taskSurfaceOpen = false;
    elements.chatSurface.dataset.open = 'false';
    elements.chatSurface.setAttribute('aria-hidden', 'false');
    elements.chatSurface.inert = false;
    elements.chatCollapseButton.setAttribute('aria-expanded', 'false');
    const finish = () => {
      if (transitionId !== screenTransitionId) return;
      screenTransitionTimer = null;
      elements.chatSurface.dataset.transition = 'exited';
      elements.chatSurface.inert = true;
      elements.chatSurface.setAttribute('aria-hidden', 'true');
      document.body.dataset.screen = 'viewer';
      elements.viewerScreen.inert = false;
      elements.viewerScreen.setAttribute('aria-hidden', 'false');
      elements.newTaskButton.focus();
    };
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) finish();
    else screenTransitionTimer = window.setTimeout(finish, 200);
  }
}

function closeTaskSurface() {
  if (screenMode === 'task') {
    setScreen('viewer');
  }
}

function initializeTaskSurface() {
  setTaskSurfaceOpen(false);
  elements.chatSurface.inert = true;
  elements.viewerScreen.inert = false;
  setScreen('viewer');
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
    changes.push(t('app.workflowChanged', { from: previous.workflow, to: next.workflow }));
  }
  if (previous.mode !== next.mode) {
    changes.push(t('app.modeChanged', { from: previous.mode, to: next.mode }));
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
  setChatStatusMessage('app.chatSwitching');
  try {
    const next = await reconfigureChatSession(previous.id, request);
    chatSession = next;
    updateChatSessionDescription(next);
    appendChatEntry(
      'system',
    `${describeChatSettingsChange(previous, next)} · ${t('app.chatHandoff')}`,
    );
    setChatStatusRaw('');
  } catch (error) {
    restoreChatSettings(previous);
    setChatStatusRaw(error instanceof Error ? error.message : String(error));
  } finally {
    setChatOperationInProgress(false);
  }
}

async function startNewConversation() {
  if (chatSession === null || chatOperationInProgress) return;
  setChatOperationInProgress(true);
  setChatStatusMessage('app.chatPreparing');
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
    setChatStatusMessage('app.chatStarted');
    elements.chatMessage.focus();
  } catch (error) {
    setChatStatusRaw(error instanceof Error ? error.message : String(error));
  } finally {
    setChatOperationInProgress(false);
  }
}

async function submitChat(event) {
  event.preventDefault();
  if (elements.chatSendButton.disabled) return;
  const text = elements.chatMessage.value.trim();
  if (text === '') {
    setChatStatusMessage(EMPTY_CHAT_MESSAGE_KEY);
    return;
  }
  if (text === '/setup') {
    appendChatEntry('user', text);
    elements.chatMessage.value = '';
    chatMessageRevision += 1;
    resizeChatMessage();
    appendExecutionSettings();
    setChatStatusRaw('');
    return;
  }
  const messageRevision = chatMessageRevision;
  let messageWasCleared = false;
  let responseCompleted = false;
  setChatOperationInProgress(true);
  beginChatThinking();
  elements.chatStatus.dataset.busy = 'true';
  setChatStatusMessage('app.thinking');
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
    setChatStatusRaw('');
  } catch (error) {
    if (
      messageWasCleared
      && chatMessageRevision === messageRevision
      && elements.chatMessage.value === ''
    ) {
      elements.chatMessage.value = text;
      resizeChatMessage();
    }
    setChatStatusRaw(error instanceof Error ? error.message : String(error));
  } finally {
    finishChatThinking(responseCompleted);
    delete elements.chatStatus.dataset.busy;
    setChatOperationInProgress(false);
  }
}

function stopLiveRunStream() {
  liveStreamGeneration += 1;
  if (stopRunStream === null) return;
  stopRunStream();
  stopRunStream = null;
}

function isCurrentRunSelection(expectedRun, generation) {
  return generation === runSelectionGeneration
    && sameRunSelectionState(selectedRun, expectedRun);
}

function beginRunSelection(nextRun) {
  selectedRun = nextRun;
  runSelectionGeneration += 1;
  return runSelectionGeneration;
}

function startLiveRunStream(generation = runSelectionGeneration) {
  stopLiveRunStream();
  if (!liveUpdatesEnabled || selectedRun === null) return;
  const expectedRun = { ...selectedRun };
  const streamGeneration = liveStreamGeneration;
  executionView.setLiveState('connecting');
  stopRunStream = subscribeRun(expectedRun.projectId, expectedRun.slug, {
    onSnapshot(detail) {
      if (streamGeneration !== liveStreamGeneration
        || !isCurrentRunSelection(expectedRun, generation)) return;
      liveSnapshotRevision += 1;
      executionView.renderDetail(detail, expectedRun);
    },
    onConnectionChange(state) {
      if (streamGeneration !== liveStreamGeneration
        || !isCurrentRunSelection(expectedRun, generation)) return;
      executionView.setLiveState(state);
      elements.connection.textContent = state === 'live' ? t('app.live') : t('app.statusReconnecting');
    },
    onError(error) {
      if (streamGeneration !== liveStreamGeneration
        || !isCurrentRunSelection(expectedRun, generation)) return;
      elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
    },
  });
}

async function selectRun(nextRun) {
  const generation = beginRunSelection(nextRun);
  elements.viewerScreen.dataset.mobileView = 'detail';
  executionView.renderTaskList(taskCollection.tasks, selectedRun);
  startLiveRunStream(generation);
  const request = {
    generation,
    snapshotRevision: liveSnapshotRevision,
    selection: { ...nextRun },
  };
  try {
    const detail = await getRun(nextRun.projectId, nextRun.slug);
    if (isCurrentRunRequestState(
      request,
      runSelectionGeneration,
      selectedRun,
      liveSnapshotRevision,
    )) {
      executionView.renderDetail(detail, nextRun);
    }
  } catch (error) {
    if (isCurrentRunRequestState(
      request,
      runSelectionGeneration,
      selectedRun,
      liveSnapshotRevision,
    )) {
      elements.runWarning.textContent = error instanceof Error ? error.message : String(error);
    }
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
    const nextRun = firstTask === undefined || latestRun === undefined
      ? null
      : { projectId: firstTask.projectId, taskId: firstTask.taskId, slug: latestRun.slug };
    if (!sameRunSelectionState(previous, nextRun)) beginRunSelection(nextRun);
    else selectedRun = nextRun;
  }
  executionView.renderTaskList(collection.tasks, selectedRun);
  elements.viewerScreen.dataset.mobileView = selectedRun === null ? 'list' : 'detail';
  updateWarnings(collection.warnings);
  if (selectedRun === null) {
    stopLiveRunStream();
    executionView.renderPlaceholder();
    return;
  }
  if (!sameRunSelectionState(previous, selectedRun)) startLiveRunStream(runSelectionGeneration);
}

async function requeueSelectedTask(task, button) {
  button.disabled = true;
  elements.runWarning.textContent = '';
  try {
    const result = await requeueTask(task.projectId, task.taskId);
    if (result.disposition === 'reused') {
      setChatStatusMessage('app.failedRequeued');
    } else {
      setChatStatusMessage('app.newTaskRunStarted', { pid: result.pid });
    }
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
      const request = {
        generation: runSelectionGeneration,
        snapshotRevision: liveSnapshotRevision,
        selection: requestedRun,
      };
      try {
        const detail = await getRun(requestedRun.projectId, requestedRun.slug);
        if (isCurrentRunRequestState(
          request,
          runSelectionGeneration,
          selectedRun,
          liveSnapshotRevision,
        )) {
          executionView.renderDetail(detail, requestedRun);
        }
      } catch (error) {
        if (isCurrentRunRequestState(
          request,
          runSelectionGeneration,
          selectedRun,
          liveSnapshotRevision,
        )) {
          throw error;
        }
      }
    }
    elements.connection.textContent = liveUpdatesEnabled ? t('app.live') : t('app.statusConnected');
  } catch (error) {
    elements.connection.textContent = t('app.statusError');
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
      elements.connection.textContent = state === 'live' ? t('app.live') : t('app.statusReconnecting');
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
    elements.connection.textContent = t('app.manualRefresh');
  }
  elements.watch.setAttribute('aria-pressed', String(enabled));
  elements.watch.textContent = enabled ? t('app.liveOn') : t('app.liveOff');
}

async function initialize() {
  initializeTaskSurface();
  resizeChatMessage();
  try {
    const session = await getSession();
    elements.directoryNativePicker.hidden = !session.capabilities.nativeDirectoryPicker;
    elements.directoryPicker.disabled = false;
    await refreshProjects('');
    await refreshRuns();
    startTaskStream();
  } catch (error) {
    elements.connection.textContent = t('app.statusInitializing');
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
  if (screenMode === 'task' && taskSurfaceOpen) {
    event.preventDefault();
    closeTaskSurface();
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
elements.viewerNav.addEventListener('click', () => setScreen('viewer'));
elements.newTaskButton.addEventListener('click', () => setScreen('task'));
elements.mobileTaskListButton.addEventListener('click', () => {
  elements.viewerScreen.dataset.mobileView = 'list';
});
elements.mobileInspectorButton.addEventListener('click', () => {
  elements.viewerScreen.dataset.mobileView = 'inspector';
});
elements.chatCollapseButton.addEventListener('click', closeTaskSurface);
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
    renderDirectoryEmptyState(t('app.directoryEnter'));
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

function updateLanguageToggle() {
  const english = getLocale() === 'en';
  elements.languageToggle.textContent = english ? t('app.languageJapanese') : t('app.languageEnglish');
  const label = english ? t('app.languageSwitchToJa') : t('app.languageSwitch');
  elements.languageToggle.setAttribute('aria-label', label);
  elements.languageToggle.title = label;
  elements.languageToggle.setAttribute('aria-pressed', String(english));
}

function refreshChatLocale() {
  if (chatSession !== null) updateChatSessionDescription(chatSession);
  for (const summary of elements.chatTranscript.querySelectorAll('[data-settings-summary="true"]')) {
    let settings = executionSettings;
    try {
      const snapshot = JSON.parse(summary.dataset.settingsSnapshot ?? '');
      if (snapshot !== null && typeof snapshot === 'object') settings = snapshot;
    } catch {
      // A stale transcript entry falls back to the current settings safely.
    }
    summary.textContent = executionSettingsSummary(settings);
  }
  for (const button of elements.chatTranscript.querySelectorAll('[data-launch-disposition]')) {
    const label = button.dataset.launchDisposition === 'reused' ? t('app.queued') : t('app.started');
    button.textContent = `${label} · ${button.dataset.launchMode} · PID ${button.dataset.launchPid}`;
  }
  if (chatStatusDescriptor !== null) {
    elements.chatStatus.textContent = t(
      chatStatusDescriptor.key,
      chatStatusDescriptor.variables,
    );
  }
  elements.chatThinkingLabel.textContent = t(
    elements.chatThinking.dataset.active === 'true' ? 'app.thinking' : 'app.thinkingLabel',
  );
  elements.chatThinkingState.textContent = t(
    elements.chatThinking.dataset.stateKey ?? 'app.waitingResponse',
  );
}

elements.languageToggle.addEventListener('click', () => {
  setLocale(getLocale() === 'ja' ? 'en' : 'ja');
});
subscribeLocaleChange(() => {
  applyTranslations();
  updateLanguageToggle();
  updateExecutionContextSummary();
  elements.chatSurfaceLabel.textContent = t('app.newTask');
  elements.chatTitle.textContent = t('app.createTask');
  elements.chatSurfaceDescription.textContent = t('app.startConversationDescription');
  refreshChatLocale();
  executionView.refreshLocale();
});
applyTranslations();
updateLanguageToggle();
void initialize();
