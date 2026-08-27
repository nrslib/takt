import { buildTaskActionRequest } from './task-action-ui.js';

async function readJsonOrNull(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseErrorMessage(response, body) {
  return typeof body?.error === 'string'
    ? body.error
    : `Request failed: ${response.status}`;
}

function responseError(response, body) {
  const error = new Error(responseErrorMessage(response, body));
  error.status = response.status;
  return error;
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  return readJsonResponse(response);
}

async function readJsonResponse(response) {
  const body = await readJsonOrNull(response);
  if (!response.ok) {
    throw responseError(response, body);
  }
  if (body === null) throw new Error(`Invalid response: ${response.status}`);
  return body;
}

let sessionToken;

function requireSessionToken() {
  if (sessionToken === undefined) throw new Error('Web session is not initialized');
  return sessionToken;
}

async function refreshSession() {
  const session = await requestJson('/api/session');
  if (typeof session?.token !== 'string' || session.token === '') {
    throw new Error('Web session token is missing');
  }
  sessionToken = session.token;
  return session;
}

async function fetchMutation(path, body) {
  const response = await fetch(path, mutationOptions(requireSessionToken(), body));
  if (response.status !== 403) return response;

  const errorBody = await readJsonOrNull(response);
  if (errorBody?.error !== 'Session token is invalid') {
    throw responseError(response, errorBody);
  }

  await refreshSession();
  return fetch(path, mutationOptions(requireSessionToken(), body));
}

async function requestMutation(path, body) {
  return readJsonResponse(await fetchMutation(path, body));
}

export function getSession() {
  return refreshSession();
}

export function getTasks() {
  return requestJson('/api/tasks');
}

export function getProjects() {
  return requestJson('/api/projects');
}

export function getWorkflows(projectId) {
  return requestJson(`/api/workflows?project=${encodeURIComponent(projectId)}`);
}

export function getRun(projectId, slug) {
  return requestJson(
    `/api/runs/${encodeURIComponent(slug)}?project=${encodeURIComponent(projectId)}`,
  );
}

export function getRunOccurrenceArtifacts(projectId, slug, occurrenceId, signal) {
  return requestJson(
    `/api/runs/${encodeURIComponent(slug)}/occurrence-artifacts?project=${encodeURIComponent(projectId)}&occurrence=${encodeURIComponent(occurrenceId)}`,
    signal === undefined ? undefined : { signal },
  );
}

export function browseDirectories(path) {
  return requestMutation('/api/directories/browse', path === null ? {} : { path });
}

export function pickNativeDirectory() {
  return requestMutation('/api/directories/native-picker', {});
}

export function registerProject(projectDirectory) {
  return requestMutation('/api/projects', { projectDirectory });
}

export function startTask(request) {
  return requestMutation('/api/tasks', request);
}

export function requeueTask(projectId, taskId) {
  return requestMutation(`/api/tasks/${encodeURIComponent(taskId)}/requeue`, { projectId });
}

export function runTaskAction(projectId, taskId, action, input, conversationId, taskActionOptionId) {
  const request = buildTaskActionRequest(
    projectId,
    taskId,
    action,
    input,
    conversationId,
    taskActionOptionId,
  );
  return requestMutation(
    request.path,
    request.body,
  );
}

function mutationOptions(token, body) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TAKT-Web-Token': token,
    },
    body: JSON.stringify(body),
  };
}

export function createChatSession(request) {
  return requestMutation('/api/chat/sessions', request);
}

export function reconfigureChatSession(sessionId, request) {
  return requestMutation(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/settings`,
    request,
  );
}

export function restartChatSession(sessionId) {
  return requestMutation(`/api/chat/sessions/${encodeURIComponent(sessionId)}/restart`, {});
}

function parseChatStreamRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw new Error('Invalid chat stream response');
  }
  if (record === null || typeof record !== 'object' || typeof record.type !== 'string') {
    throw new Error('Invalid chat stream response');
  }
  return record;
}

async function readChatStream(response, onThinking) {
  if (response.body === null) throw new Error(`Invalid response: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let reply;

  function consumeLine(line) {
    if (line.trim() === '') return;
    const record = parseChatStreamRecord(line);
    if (record.type === 'thinking' && typeof record.content === 'string') {
      onThinking(record.content);
      return;
    }
    if (record.type === 'reply' && record.reply !== undefined) {
      reply = record.reply;
      return;
    }
    if (record.type === 'error' && typeof record.message === 'string') {
      throw new Error(record.message);
    }
    throw new Error('Invalid chat stream response');
  }

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(pending);
  if (reply === undefined) throw new Error('Chat stream ended without a reply');
  return reply;
}

export async function sendChatMessage(sessionId, text, onThinking, taskActionOptionId) {
  const response = await fetchMutation(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      text,
      ...(taskActionOptionId === undefined ? {} : { taskActionOptionId }),
    },
  );
  if (!response.ok) {
    throw responseError(response, await readJsonOrNull(response));
  }
  return readChatStream(response, onThinking);
}
