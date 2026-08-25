async function requestJson(path, options) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = typeof body?.error === 'string'
      ? body.error
      : `Request failed: ${response.status}`;
    throw new Error(message);
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

export function sendChatMessage(token, sessionId, text) {
  return requestJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    mutationOptions(token, { text }),
  );
}
