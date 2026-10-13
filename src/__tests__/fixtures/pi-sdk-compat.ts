import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { createReadToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const COMPAT_MODEL = 'takt-compat-test/offline';
export const EXECUTION_FILE = 'tool-executions.txt';

/** Extracts text consistently from user, assistant, and tool-result messages. */
function messageText(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => block.type === 'text' ? block.text : '').join('');
}

/** Registers offline history and nested-tool probes through the real SDK API. */
export default function registerCompatibilityProbe(pi: ExtensionAPI): void {
  const parameters = createReadToolDefinition('.').parameters;
  /** Adds a deferred tool whose file marker proves execution, not just selection. */
  const registerProbe = (name: string) => pi.registerTool({
    name,
    label: name,
    description: 'Offline tool execution probe',
    parameters,
    exposure: 'deferred',
    /** Records an actual deferred tool execution in the fixture's isolated cwd. */
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      appendFileSync(join(ctx.cwd, EXECUTION_FILE), `${name}\n`);
      return { content: [{ type: 'text', text: name }], details: {} };
    },
  });
  registerProbe('allowed_probe');
  registerProbe('write');
  pi.registerTool({
    name: 'orchestrator',
    label: 'orchestrator',
    description: 'Calls tools through the real SDK nested execution pipeline',
    parameters,
    /** Exercises the SDK's nested pipeline and returns per-tool denials. */
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const outcomes: Record<string, boolean> = {};
      for (const name of ['allowed_probe', 'dynamic_probe', 'write', 'ambient_deferred', 'ambient_codemode']) {
        const outcome = await ctx.executeTool(name, { path: 'probe' });
        outcomes[name] = outcome.isError;
      }
      return { content: [{ type: 'text', text: JSON.stringify(outcomes) }], details: outcomes };
    },
  });

  const model = fauxProvider({ provider: 'takt-compat-test', models: [{ id: 'offline', reasoning: true }] });
  pi.registerProvider(model.provider);
  pi.on('session_shutdown', () => undefined);
  pi.on('before_agent_start', (event) => {
    registerProbe('dynamic_probe');
    if (!event.prompt.includes('codemode')) {
      pi.setActiveTools(['orchestrator', 'write', 'ambient_deferred', 'ambient_codemode']);
    }
    if (event.prompt.startsWith('remember:')) {
      model.setResponses([fauxAssistantMessage(`saved:${event.prompt.slice('remember:'.length)}`)]);
    } else if (event.prompt === 'recall') {
      model.setResponses([(context) => fauxAssistantMessage(JSON.stringify(
        context.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map(messageText),
      ))]);
    } else if (event.prompt === 'selected tools') {
      model.setResponses([
        fauxAssistantMessage(fauxToolCall('write', { path: 'probe' })),
        fauxAssistantMessage('selected tool executed'),
      ]);
    } else if (event.prompt === 'codemode policy') {
      model.setResponses([
        fauxAssistantMessage(fauxToolCall('codemode', {
          code: 'const results = await Promise.allSettled([tools.allowed_probe({ path: "allowed" }), tools.ambient_codemode({ path: "denied" })]); return JSON.stringify(results.map((result) => result.status));',
        })),
        (context) => {
          const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
          if (result === undefined) throw new Error('Missing SDK tool result');
          return fauxAssistantMessage(messageText(result));
        },
      ]);
    } else if (event.prompt === 'codemode result selection') {
      model.setResponses([
        fauxAssistantMessage(fauxToolCall('codemode', {
          code: 'await tools.allowed_probe({ path: "first" }); return await tools.dynamic_probe({ path: "selected" });',
        })),
        (context) => {
          const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
          if (result === undefined) throw new Error('Missing SDK tool result');
          return fauxAssistantMessage(messageText(result));
        },
      ]);
    } else {
      model.setResponses([
        fauxAssistantMessage(fauxToolCall('orchestrator', { path: 'probe' })),
        (context) => {
          const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
          if (result === undefined) throw new Error('Missing SDK tool result');
          return fauxAssistantMessage(messageText(result));
        },
      ]);
    }
  });
}
