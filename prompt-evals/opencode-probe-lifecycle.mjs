export const OPENCODE_PROBE_STARTUP_TIMEOUT_MS = 30_000;

function isTerminalSessionEvent(event, sessionId) {
  const properties = event?.properties ?? {};
  if (event?.type === 'session.error') {
    return properties.sessionID === undefined || properties.sessionID === sessionId;
  }
  if (properties.sessionID !== sessionId) {
    return false;
  }
  return event?.type === 'session.idle'
    || (event?.type === 'session.status' && properties.status?.type === 'idle');
}

async function consumeSessionEvents(stream, sessionId, onReady, onEvent) {
  let ready = false;
  for await (const event of stream) {
    if (!ready && event?.properties?.sessionID === sessionId) {
      onReady();
      ready = true;
    }
    await onEvent(event);
    if (isTerminalSessionEvent(event, sessionId)) {
      return;
    }
  }
  throw new Error(`OpenCode event stream ended before session ${sessionId} reached a terminal state`);
}

export async function runOpenCodeSessionWithEvents({
  client,
  directory,
  sessionId,
  start,
  onReady,
  onEvent,
}) {
  const controller = new AbortController();
  const { stream } = await client.event.subscribe(
    { directory },
    { signal: controller.signal, throwOnError: true },
  );
  try {
    const execution = Promise.resolve().then(start);
    const [, result] = await Promise.all([
      consumeSessionEvents(stream, sessionId, onReady, onEvent),
      execution,
    ]);
    return result;
  } finally {
    controller.abort();
  }
}

export function promptOpenCodeSession(client, input) {
  return client.session.prompt(input, { throwOnError: true });
}

export function promptOpenCodeSessionAsync(client, input) {
  return client.session.promptAsync(input, { throwOnError: true });
}

export function summarizeOpenCodeSession(client, input) {
  return client.session.summarize(input, { throwOnError: true });
}

export function listOpenCodeSessionMessages(client, input) {
  return client.session.messages(input, { throwOnError: true });
}

export async function cleanupOpenCodeClient({ client, sessionId, directory }) {
  const errors = [];
  if (client !== undefined && sessionId !== undefined) {
    try {
      await client.session.delete(
        { sessionID: sessionId, directory },
        { throwOnError: true },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (client !== undefined) {
    try {
      await client.global.dispose({ throwOnError: true });
    } catch (error) {
      errors.push(error);
    }
  }
  throwCleanupErrors(errors);
}

export async function cleanupOpenCodeProbe({ client, server, sessionId, directory }) {
  const errors = [];
  try {
    await cleanupOpenCodeClient({ client, sessionId, directory });
  } catch (error) {
    errors.push(error);
  }
  try {
    await server?.close?.();
  } catch (error) {
    errors.push(error);
  }
  throwCleanupErrors(errors);
}

export async function runOpenCodeProbe({ createProbe, directory, execute, onPhase }) {
  let client;
  let server;
  let sessionId;
  let result;
  let ready = false;
  let executionError;
  try {
    const created = await createProbe();
    client = created.client;
    server = created.server;
    const session = await client.session.create({ directory }, { throwOnError: true });
    const createdSessionId = session.data.id;
    if (typeof createdSessionId !== 'string' || createdSessionId.length === 0) {
      throw new Error('OpenCode probe session did not expose an ID');
    }
    sessionId = createdSessionId;
    const markReady = () => {
      if (ready) {
        throw new Error('OpenCode probe reported readiness more than once');
      }
      onPhase('ready');
      ready = true;
    };
    result = await execute({ client, sessionId, markReady });
    if (!ready) {
      throw new Error('OpenCode probe execution completed before reporting readiness');
    }
  } catch (error) {
    executionError = error;
  }

  onPhase(executionError === undefined ? 'cleanupStart' : 'failureCleanupStart');
  let cleanupError;
  try {
    await cleanupOpenCodeProbe({ client, server, sessionId, directory });
  } catch (error) {
    cleanupError = error;
  }
  if (executionError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [executionError, cleanupError],
      'OpenCode probe execution and cleanup failed',
    );
  }
  if (executionError !== undefined) {
    throw executionError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return result;
}

function throwCleanupErrors(errors) {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'OpenCode probe cleanup failed');
  }
}
