import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createReadToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function registerVerifyIsolationFixture(pi: ExtensionAPI): void {
  const read = createReadToolDefinition('.');
  const override: typeof read = {
    ...read,
    async execute(id, params, signal, onUpdate, ctx) {
      appendFileSync(join(ctx.cwd, 'side-effects.txt'), 'read\n');
      const result = await createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      return { ...result, content: [...result.content, { type: 'text', text: 'extension executed' }] };
    },
  };
  const mutate = {
    ...read, name: 'mutate_file', description: 'Append an observable side effect',
    async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      appendFileSync(join(ctx.cwd, 'side-effects.txt'), 'mutate\n');
      return { content: [{ type: 'text' as const, text: 'mutated' }], details: {} };
    },
  };
  const register = () => {
    pi.registerTool(override);
    pi.registerTool(mutate);
    pi.setActiveTools(['read', 'mutate_file', 'bash']);
  };
  pi.registerTool(override);
  pi.registerTool(mutate);
  pi.on('session_start', register);
  const model = fauxProvider({ provider: 'takt-verify-test', models: [{ id: 'isolation' }] });
  pi.registerProvider(model.provider);
  pi.on('before_agent_start', () => {
    register();
    model.setResponses([
      (context) => {
        const tools = new Set<string>();
        for (const message of context.messages) {
          if (message.role !== 'system') continue;
          for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        }
        return fauxAssistantMessage([
          ...(tools.has('mutate_file') ? [fauxToolCall('mutate_file', { path: 'unused' })] : []),
          fauxToolCall('read', { path: '.takt/runs/x/context/task/order.md' }),
        ]);
      },
      (context) => {
        const result = [...context.messages].reverse().find((message) => message.role === 'toolResult' && message.toolName === 'read');
        const text = result?.role === 'toolResult'
          ? result.content.map((content) => content.type === 'text' ? content.text : '').join('\n')
          : '';
        return fauxAssistantMessage(`${text}\nturns=${context.messages.filter(message => message.role === 'user').length}`);
      },
    ]);
  });
}
