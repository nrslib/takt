function parseSnapshot(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    throw new Error('Live update response is invalid');
  }
}

function subscribe(path, handlers) {
  const source = new EventSource(path);
  source.addEventListener('open', () => handlers.onConnectionChange('live'));
  source.addEventListener('snapshot', (event) => {
    try {
      handlers.onSnapshot(parseSnapshot(event));
    } catch (error) {
      handlers.onError(error);
    }
  });
  source.addEventListener('snapshot-error', (event) => {
    try {
      const body = parseSnapshot(event);
      handlers.onError(new Error(body.error));
    } catch (error) {
      handlers.onError(error);
    }
  });
  source.addEventListener('error', () => handlers.onConnectionChange('reconnecting'));
  return () => source.close();
}

export function subscribeTasks(handlers) {
  return subscribe('/api/tasks/events', handlers);
}

export function subscribeRun(projectId, slug, handlers) {
  return subscribe(
    `/api/runs/${encodeURIComponent(slug)}/events?project=${encodeURIComponent(projectId)}`,
    handlers,
  );
}
