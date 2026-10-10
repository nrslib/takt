import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.env.TAKT_DSH_PROBE_MODE;
const pidFile = process.env.TAKT_DSH_PROBE_RUNTIME_PID_FILE;
const childPidFile = process.env.TAKT_DSH_PROBE_TOOL_PID_FILE;
const startedFile = process.env.TAKT_DSH_PROBE_STARTED_FILE;
const historyFile = process.env.TAKT_DSH_PROBE_HISTORY_FILE;
let input = '';
let messageSerial = 0;

if (pidFile !== undefined) {
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

if (mode === 'stderr-exit') {
  process.stderr.write('TAKT_DSH_PROBE_STDERR_SENTINEL\n');
  setTimeout(() => process.exit(21), 10);
}

if (mode === 'spawn-child' || mode === 'hang-after-receipt' || mode === 'shutdown-hang-child' || mode === 'cleanup-failure' || mode === 'cleanup-child-only') {
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], { stdio: 'ignore' });
  if (childPidFile !== undefined && child.pid !== undefined) {
    writeFileSync(childPidFile, String(child.pid), 'utf8');
  }
}

/** Write a JSON-RPC success response for a fixture request ID. */
function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

/** Write a JSON-RPC notification without an ID to the fixture client. */
function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

/** Append a fixture history entry only when a history path is configured. */
function appendHistory(entry) {
  if (historyFile === undefined) return;
  appendFileSync(historyFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Handle probe initialization/session/shutdown requests and inject the selected failure or timeout behavior. */
function handleRequest(message) {
  if (message.method === 'initialize') {
    if (mode === 'initialize-timeout' || mode === 'stderr-exit') return;
    if (mode === 'initialize-failure' || mode === 'cleanup-failure') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32001, message: 'probe initialization failure' },
      })}\n`);
      return;
    }
    respond(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'probe' } });
    return;
  }

  if (message.method === 'session/prompt') {
    if (startedFile !== undefined) writeFileSync(startedFile, 'prompt received', 'utf8');
    if (mode === 'turn-timeout') return;

    messageSerial += 1;
    const params = message.params;
    const sessionId = params?.sessionId;
    const prompt = params?.contentBlocks?.[0]?.text;
    const messageId = `probe-message-${messageSerial}`;
    appendHistory({ sessionId, prompt });
    respond(message.id, { messageId });
    notify('session.event', {
      sessionId,
      event: {
        type: 'agent/inbox/spliced',
        data: { inserted: [{ id: messageId }] },
      },
    });
    if (mode === 'hang-after-receipt') return;

    notify('session.event', {
      sessionId,
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: `probe response ${messageSerial}` }] } },
      },
    });
    notify('session.status', { sessionId, status: 'idle' });
    return;
  }

  if (message.method === 'shutdown') {
    if (mode === 'shutdown-hang' || mode === 'shutdown-hang-child' || mode === 'cleanup-failure') return;
    respond(message.id, {});
    setTimeout(() => process.exit(0), 10);
    return;
  }

  appendHistory({ unsupportedMethod: message.method });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let lineEnd = input.indexOf('\n');
  while (lineEnd >= 0) {
    const line = input.slice(0, lineEnd);
    input = input.slice(lineEnd + 1);
    if (line.length > 0) handleRequest(JSON.parse(line));
    lineEnd = input.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  if (mode !== 'shutdown-hang' && mode !== 'shutdown-hang-child' && mode !== 'cleanup-failure') {
    process.exit(0);
  }
  if (mode === 'cleanup-failure') setInterval(() => {}, 1_000);
});
