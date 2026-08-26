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

async function requestJson(path, options) {
  const response = await fetch(path, options);
  const body = await readJsonOrNull(response);
  if (!response.ok) {
    throw new Error(responseErrorMessage(response, body));
  }
  if (body === null) throw new Error(`Invalid response: ${response.status}`);
  return body;
}

export function getSession() {
  return requestJson('/api/session');
}

export function getRuns() {
  return requestJson('/api/runs');
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

export function browseDirectories(token, path) {
  return requestJson(
    '/api/directories/browse',
    mutationOptions(token, path === null ? {} : { path }),
  );
}

export function pickNativeDirectory(token) {
  return requestJson(
    '/api/directories/native-picker',
    mutationOptions(token, {}),
  );
}

export function registerProject(token, projectDirectory) {
  return requestJson(
    '/api/projects',
    mutationOptions(token, { projectDirectory }),
  );
}

export function startRun(token, request) {
  return requestJson('/api/runs', mutationOptions(token, request));
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

export function createChatSession(token, request) {
  return requestJson('/api/chat/sessions', mutationOptions(token, request));
}

export function reconfigureChatSession(token, sessionId, request) {
  return requestJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/settings`,
    mutationOptions(token, request),
  );
}

export function restartChatSession(token, sessionId) {
  return requestJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/restart`,
    mutationOptions(token, {}),
  );
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

export async function sendChatMessage(token, sessionId, text, onThinking) {
  const response = await fetch(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    mutationOptions(token, { text }),
  );
  if (!response.ok) {
    throw new Error(responseErrorMessage(response, await readJsonOrNull(response)));
  }
  return readChatStream(response, onThinking);
}
