import type { Plugin } from '@opencode/plugin';
import { TAKT_V2_METADATA_KEY, TAKT_V2_PLUGIN_ID } from '../../v2-contract.js';

const plugin: Plugin.Plugin = {
  id: TAKT_V2_PLUGIN_ID,
  async setup(context) {
    const registration = await context.session.hook('context', async (request) => {
      const session = await context.session.get({ sessionID: request.sessionID });
      const settings = session.metadata?.[TAKT_V2_METADATA_KEY];
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        throw new Error('TAKT session policy is missing');
      }
      const system = settings.system;
      const tools = settings.tools;
      if (typeof system !== 'string' || typeof tools !== 'object' || tools === null || Array.isArray(tools)) {
        throw new Error('TAKT session policy is invalid');
      }
      if (system !== '') request.system.push({ type: 'text', text: system });
      for (const name of Object.keys(request.tools)) {
        if (tools[name] !== true) delete request.tools[name];
      }
    });
    const coercion = await context.tool.hook('execute.before', (request) => {
      if (!['read', 'grep', 'glob'].includes(request.tool)) return;
      if (typeof request.input !== 'object' || request.input === null || Array.isArray(request.input)) return;
      const args = request.input as Record<string, unknown>;
      const fields = request.tool === 'read' ? ['offset', 'limit'] : ['limit'];
      for (const field of fields) {
        const value = args[field];
        if (typeof value !== 'string' || !/^[+-]?\d+(?:\.0+)?$/.test(value.trim())) continue;
        const number = Number(value);
        if (Number.isSafeInteger(number)) args[field] = number;
      }
    });
    const inventory = await context.rpc.register({
      id: TAKT_V2_PLUGIN_ID, events: {}, methods: {
        tools: { input: { type: 'null' }, output: { type: 'array', items: {
          type: 'object', properties: { id: { type: 'string' }, namespace: { type: 'string' } }, required: ['id'],
        } } },
      },
    }, { tools: async () => (await context.tool.list()).map((tool) => ({
      id: tool.id, ...(tool.options?.namespace === undefined ? {} : { namespace: tool.options.namespace }),
    })) });
    return async () => {
      await registration.dispose();
      await coercion.dispose();
      await inventory.dispose();
    };
  },
};

export default plugin;
