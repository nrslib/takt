import assert from 'node:assert/strict';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';

const mode = process.env.PI_SMOKE_FIXTURE_MODE;
assert.ok(mode === 'normal' || mode === 'sdk-hang' || mode === 'cleanup-hang');
assert.ok(process.send);

/** Reports child lifecycle evidence to the deadline test over isolated IPC. */
function event(name: string, detail: object = {}): void {
  process.send!({ event: name, ...detail });
}

// Keep real timer handles and cancellation, but advance the long smoke timers
// in this child. Yield between callbacks as Node does, so abort cleanup starts
// before the watchdog can terminate it.
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map<ReturnType<typeof setTimeout>, { at: number; fire: () => void }>();
let now = 0;
globalThis.setTimeout = Object.assign((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  const handle = originalSetTimeout(callback, delay, ...args);
  if (delay === 120_000) timers.set(handle, { at: now + delay, fire: () => callback(...args) });
  return handle;
}, originalSetTimeout);
globalThis.clearTimeout = (handle) => {
  if (typeof handle === 'object' && handle !== null) timers.delete(handle);
  originalClearTimeout(handle);
};
process.on('message', async (message: unknown) => {
  assert.ok(message !== null && typeof message === 'object' && 'advanceMs' in message);
  assert.equal(typeof message.advanceMs, 'number');
  now += message.advanceMs as number;
  for (const [handle, timer] of timers) {
    if (timer.at > now) continue;
    timers.delete(handle);
    originalClearTimeout(handle);
    timer.fire();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  event('clock-advanced');
});

const offline = fauxProvider({ models: [{ id: 'offline', reasoning: true }] }).models[0];
const model = { ...offline, provider: 'openai-codex', id: 'gpt-6.1-sol', api: 'openai-codex-responses' as const };
const originalGetModel = ModelRuntime.prototype.getModel;
ModelRuntime.prototype.getModel = function (provider: string, id: string) {
  return provider === model.provider && id === model.id ? model : originalGetModel.call(this, provider, id);
};
ModelRuntime.prototype.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' } });
ModelRuntime.prototype.checkAuth = async () => ({ type: 'api_key', source: 'offline-fixture' });

globalThis.fetch = async () => {
  event('submission');
  return new Response('{}', { status: 200 });
};

const originalPrompt = AgentSession.prototype.prompt;
let prompts = 0;
AgentSession.prototype.prompt = async function (prompt, options) {
  prompts += 1;
  event('prompt', {
    sessionId: this.sessionId,
    activeTools: this.getActiveToolNames(),
    codemodeSource: this.getAllTools().find((tool) => tool.name === 'codemode')?.sourceInfo,
  });
  await originalPrompt.call(this, prompt, options);
  event('prompt-finished');
  if (mode === 'normal' && prompts === 2) process.channel?.unref();
};
const originalAbort = AgentSession.prototype.abort;
AgentSession.prototype.abort = async function () {
  event('abort');
  if (mode === 'cleanup-hang') return new Promise<void>(() => undefined);
  return originalAbort.call(this);
};
const originalDispose = AgentSession.prototype.dispose;
AgentSession.prototype.dispose = function () {
  event('dispose');
  originalDispose.call(this);
};

ModelRuntime.prototype.streamSimple = function (requestModel, context, options) {
  const stream = createAssistantMessageEventStream();
  event('request');
  assert.ok(options?.fetch);
  assert.ok(options.signal);
  const signal = options.signal;
  signal.addEventListener('abort', () => {
    event('signal-aborted');
    if (mode === 'cleanup-hang') {
      const response = {
        ...fauxAssistantMessage('', { stopReason: 'aborted' }),
        model: requestModel.id, provider: requestModel.provider, api: requestModel.api,
      };
      stream.push({ type: 'error', reason: 'aborted', error: response });
      stream.end(response);
    }
  }, { once: true });
  /** Simulates a bounded HTTP submission or a stalled SDK without network access. */
  const submit = async (): Promise<void> => {
    await options.fetch!('https://chatgpt.com/backend-api/codex/responses', { signal });
    if (mode !== 'normal') {
      event('pending');
      return;
    }
    const user = context.messages.find((message) => message.role === 'user');
    assert.ok(user && user.role === 'user');
    const text = typeof user.content === 'string'
      ? user.content
      : user.content.map((part) => part.type === 'text' ? part.text : '').join('');
    const probe = text.match(/takt-probe-[a-zA-Z0-9-]+/u)?.[0];
    assert.ok(probe);
    const response = { ...fauxAssistantMessage(probe), model: requestModel.id, provider: requestModel.provider, api: requestModel.api };
    stream.push({ type: 'done', reason: 'stop', message: response });
    stream.end(response);
  };
  void submit().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
  return stream;
};
