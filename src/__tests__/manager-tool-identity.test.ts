import { expect, it, vi } from 'vitest';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import type { ToolActivityEvent } from '../shared/tool-activity/types.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';

it('assigns missing tool identities in the provider adapter before reporting starts, outputs and results', async () => {
  const events: ToolActivityEvent[] = [];
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: '', tool: 'Bash', input: {} } });
    options.onStream!({ type: 'tool_output', data: { tool: 'Bash', output: 'safe\n' } });
    options.onStream!({ type: 'tool_result', data: { content: 'done', isError: false } });
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(), structuredOutput: { message: 'done', summary: null } };
  });
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  await executor.execute({ prompt: 'run', sessionId: undefined, abortSignal: new AbortController().signal, assignment: undefined,
    onToolEvent: (event) => { events.push(event); } });
  expect(events.map((event) => event.type)).toEqual(['tool_use', 'tool_output', 'tool_result']);
  const id = events[0]!.data.id;
  expect(id).toBeTruthy();
  expect(events.every((event) => event.data.id === id)).toBe(true);
  expect(events.every((event) => event.toolActivity?.callId === events[0]!.toolActivity?.callId)).toBe(true);
});

it('does not leave duplicate pending identities when a start follows identified output', async () => {
  const events: ToolActivityEvent[] = [];
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'ready\n' } });
    options.onStream!({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    options.onStream!({ type: 'tool_result', data: { id: 'a', content: 'done', isError: false } });
    options.onStream!({ type: 'tool_use', data: { id: 'b', tool: 'Bash', input: {} } });
    options.onStream!({ type: 'tool_result', data: { content: 'done', isError: false } });
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(), structuredOutput: { message: 'done', summary: null } };
  });
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  await executor.execute({ prompt: 'run', sessionId: undefined, abortSignal: new AbortController().signal, assignment: undefined,
    onToolEvent: (event) => { events.push(event); } });
  expect(events.map((event) => event.data.id)).toEqual(['a', 'a', 'a', 'b', 'b']);
});
