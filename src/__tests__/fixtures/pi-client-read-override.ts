import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createReadToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const CLIENT_READ_DESCRIPTION = 'TAKT client fixture read override';
export const CLIENT_READ_MARKER = 'TAKT client override executed';

/** Offline model transport; the SDK session, extension lifecycle and tools are real. */
export default function registerClientReadOverride(pi: ExtensionAPI): void {
  const read = createReadToolDefinition('.');
  const override: typeof read = {
    ...read,
    description: CLIENT_READ_DESCRIPTION,
    async execute(id, params, signal, onUpdate, ctx) {
      const result = await createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      return {
        ...result,
        content: [...result.content, { type: 'text', text: CLIENT_READ_MARKER }],
      };
    },
  };
  // Like pi-fff, register before TAKT snapshots provenance, then select at startup.
  pi.registerTool(override);
  pi.on('session_start', () => pi.setActiveTools(['read', 'bash']));

  const model = fauxProvider({ provider: 'takt-override-test', models: [{ id: 'read-fixture' }] });
  pi.registerProvider(model.provider);
  pi.on('before_agent_start', () => {
    // Re-registration exercises the real SDK refresh hook without changing owner.
    pi.registerTool(override);
    pi.setActiveTools(['read', 'bash']);
    model.setResponses([
      (context) => context.tools?.some((tool) => tool.name === 'read')
        ? fauxAssistantMessage(fauxToolCall('read', { path: '.takt/runs/x/context/task/order.md' }))
        : fauxAssistantMessage('read unavailable'),
      (context) => {
        const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
        return fauxAssistantMessage(result?.content
          .map((content) => content.type === 'text' ? content.text : '')
          .join('\n') ?? 'missing tool result');
      },
    ]);
  });
}
