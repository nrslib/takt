import { OpenCode, type SessionMessageInfo, type FormInfo } from '@opencode/client';
import { setTimeout as delay } from 'node:timers/promises';
import type { OpenCodeTransport, OpenCodeMessage, OpenCodeResolvedModel } from './transport.js';
import type { OpenCodeStreamEvent } from './OpenCodeStreamHandler.js';
import { TAKT_V2_METADATA_KEY, TAKT_V2_PLUGIN_ID, toV2Tools } from './v2-contract.js';
import { v2EventTranslator } from './v2-events.js';
import { OPEN_CODE_MANAGED_TOOL_IDS } from './types.js';

const managedTools = new Set(OPEN_CODE_MANAGED_TOOL_IDS);
// v2 records session state changes as messages. They carry no model-facing
// content and have no v1 counterpart; mapping them to `user` would make the
// trailing `idle` after every assistant turn hide the latest assistant message.
const sessionStateMessageTypes = new Set<string>(['agent-switched', 'model-switched', 'location-switched', 'idle']);

interface RegisteredTool { id: string; namespace?: string }

function toolInventory(output: unknown): RegisteredTool[] {
  if (!Array.isArray(output) || !output.every((tool): tool is RegisteredTool => (
    typeof tool === 'object' && tool !== null && typeof tool.id === 'string'
    && (tool.namespace === undefined || typeof tool.namespace === 'string')
  ))) {
    throw new Error('Invalid TAKT OpenCode v2 plugin tool inventory');
  }
  return output;
}

function messageFromV2(message: SessionMessageInfo): OpenCodeMessage {
  const info = {
    id: message.id, role: message.type === 'assistant' || message.type === 'compaction' ? 'assistant' : 'user',
    time: { created: message.time.created, ...('completed' in message.time ? { completed: message.time.completed } : {}) },
    ...('error' in message ? { error: message.error } : {}),
    ...(message.type === 'compaction' ? { summary: true } : {}),
  };
  if (message.type === 'compaction' && message.status === 'completed') info.time.completed = message.time.created;
  return {
    info,
    parts: message.type === 'assistant' ? message.content.map((part) => ({ ...part })) : [],
  };
}

export function createV2Transport(baseUrl: string, password: string, mcpServerNames: readonly string[] = []): OpenCodeTransport {
  const client = OpenCode.make({ baseUrl, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  const forms = new Map<string, FormInfo>();

  return {
    nativeStructuredOutput: false,
    requiresExplicitMcpTools: true,
    async resolveModel(input, options): Promise<OpenCodeResolvedModel> {
      const location = { directory: input.directory };
      if (input.agent !== undefined) {
        const agents = await client.agent.list({ location }, options);
        const agent = agents.data.find((item) => item.name === input.agent || item.id === input.agent);
        if (agent === undefined) throw new Error(`OpenCode v2 agent not found: ${input.agent}`);
        if (agent.model !== undefined) {
          return {
            providerID: agent.model.providerID,
            modelID: agent.model.id,
            ...(agent.model.variant === undefined ? {} : { variant: agent.model.variant }),
          };
        }
      }
      if (input.sessionID !== undefined) {
        const session = await client.session.get({ sessionID: input.sessionID }, options);
        if (session.location.directory !== input.directory) throw new Error('OpenCode v2 session belongs to a different directory');
        if (session.model !== undefined) {
          return {
            providerID: session.model.providerID,
            modelID: session.model.id,
            ...(session.model.variant === undefined ? {} : { variant: session.model.variant }),
          };
        }
      }
      const result = await client.model.default({ location }, options);
      if (result.data === null) throw new Error('OpenCode v2 has no default model');
      return { providerID: result.data.providerID, modelID: result.data.id };
    },
    session: {
      async create(input, options) {
        if (input.directory === undefined) throw new Error('OpenCode v2 requires a session directory');
        const session = await client.session.create({ location: { directory: input.directory }, agent: 'takt' }, options);
        return { data: { id: session.id } };
      },
      async get(input, options) {
        return { data: await client.session.get({ sessionID: input.sessionID }, options) };
      },
      async messages(input, options) {
        const messages: OpenCodeMessage[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.message.list({ sessionID: input.sessionID, limit: 100, ...(cursor === undefined ? { order: 'asc' as const } : { cursor }) }, options);
          messages.push(...page.data.filter((message) => !sessionStateMessageTypes.has(message.type)).map(messageFromV2));
          cursor = page.cursor.next ?? undefined;
        } while (cursor !== undefined);
        return { data: messages };
      },
      async promptAsync(input, options) {
        if (input.directory === undefined) throw new Error('OpenCode v2 requires a prompt directory');
        const location = { directory: input.directory };
        // The v2 inventory does not await cold-location plugin activation.
        const activationSignal = options?.signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
        while (true) {
          const plugins = await client.plugin.list({ location }, { ...options, signal: activationSignal });
          const plugin = plugins.data.find((item) => item.id === TAKT_V2_PLUGIN_ID);
          if (plugin?.state.status === 'active') break;
          if (plugins.data.length > 0 || activationSignal.aborted) {
            throw new Error('The TAKT OpenCode v2 session plugin is not active; refusing to send an unrestricted prompt');
          }
          await delay(50, undefined, { signal: activationSignal });
        }
        if (input.tools === undefined || input.model === undefined || input.agent === undefined || input.parts === undefined) {
          throw new Error('OpenCode v2 requires explicit tools, model and agent');
        }
        if (input.format !== undefined) throw new Error('OpenCode v2 requires formatless structured output');
        const tools = toV2Tools(input.tools);
        const expectedMcpTools = Object.entries(input.tools).filter(([name, enabled]) => enabled && !managedTools.has(name)).map(([name]) => name);
        if (expectedMcpTools.length > 0 || input.allowConfiguredMcpTools === true) {
          // v2 connects MCP asynchronously and debounces tool registration after discovery.
          // Wait for the actual registry, not merely the server's connected status.
          const readySignal = options?.signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
          while (true) {
            const inventory = await client.rpc.call({ rpcID: TAKT_V2_PLUGIN_ID, method: 'tools', location, input: null }, { signal: readySignal });
            const registered = toolInventory(inventory.output);
            const servers = input.allowConfiguredMcpTools === true ? (await client.mcp.list({ location }, { signal: readySignal })).data : [];
            const enabled = servers.filter((server) => mcpServerNames.includes(server.name) && server.status.status !== 'disabled');
            const failed = enabled.find((server) => server.status.status === 'failed' || server.status.status === 'needs_auth');
            if (failed !== undefined) throw new Error(`OpenCode v2 MCP server ${failed.name} is ${failed.status.status}`);
            const namespaces = (input.allowConfiguredMcpTools === true ? mcpServerNames.filter((name) => !servers.some((server) => server.name === name && server.status.status === 'disabled')) : [])
              .map((name) => name.replace(/[^a-zA-Z0-9_-]/g, '_'));
            if (expectedMcpTools.every((name) => registered.some((tool) => tool.id === name)) && namespaces.every((namespace) => registered.some((tool) => tool.namespace === namespace))) {
              for (const tool of registered) {
                if (tool.namespace !== undefined && namespaces.includes(tool.namespace)) tools[tool.id] = true;
              }
              break;
            }
            await delay(50, undefined, { signal: readySignal });
          }
        }
        const actions = new Set(Object.entries(tools).filter(([tool, enabled]) => enabled && tool !== 'skill')
          .map(([tool]) => tool === 'write' || tool === 'patch' ? 'edit' : tool));
        const deniedActions = new Set(Object.keys(tools).filter((tool) => tool !== 'skill')
          .map((tool) => tool === 'write' || tool === 'patch' ? 'edit' : tool)
          .filter((action) => !actions.has(action)));
        const session = await client.session.get({ sessionID: input.sessionID }, options);
        if (session.location.directory !== input.directory) throw new Error('OpenCode v2 session belongs to a different directory');
        await client.session.update({
          sessionID: input.sessionID,
          permissions: [
            ...(tools.skill === true
              ? [...deniedActions].map((action) => ({ action, resource: '*', effect: 'deny' as const }))
              : [{ action: '*', resource: '*', effect: 'deny' as const }]),
            ...[...actions].map((action) => ({ action, resource: '*', effect: 'allow' as const })),
            { action: 'external_directory', resource: '*', effect: 'deny' },
          ],
          metadata: { ...session.metadata, [TAKT_V2_METADATA_KEY]: { system: input.system ?? '', tools } },
        }, options);
        await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }, options);
        await client.session.switchModel({ sessionID: input.sessionID, model: {
          providerID: input.model.providerID, id: input.model.modelID, ...(input.variant === undefined ? {} : { variant: input.variant }),
        } }, options);
        const text = input.parts.map((part) => {
          if (part.type !== 'text') throw new Error('TAKT OpenCode v2 prompts must contain text parts');
          return part.text;
        }).join('\n');
        await client.session.prompt({ sessionID: input.sessionID, text }, options);
      },
      async abort(input, options) {
        await client.session.interrupt({ sessionID: input.sessionID }, options);
        await client.session.wait({ sessionID: input.sessionID }, options);
        return { data: true };
      },
      async summarize(input, options) {
        if (input.providerID === undefined || input.modelID === undefined) throw new Error('OpenCode v2 compaction requires a model');
        await client.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.providerID, id: input.modelID } }, options);
        await client.session.compact({ sessionID: input.sessionID }, options);
      },
    },
    event: {
      async subscribe(input, options) {
        const source = client.event.subscribe(options)[Symbol.asyncIterator]();
        const first = await source.next();
        if (first.done || first.value.type !== 'server.connected') {
          await source.return?.();
          throw new Error('OpenCode v2 event stream did not establish a connection');
        }
        const translate = v2EventTranslator();
        const stream = (async function* (): AsyncGenerator<OpenCodeStreamEvent> {
          try {
            while (true) {
              const item = await source.next();
              if (item.done) return;
              const data = 'data' in item.value ? item.value.data : undefined;
              const sessionID = item.value.type === 'form.created'
                ? item.value.data.form.sessionID
                : data !== undefined && 'sessionID' in data ? data.sessionID : undefined;
              if (sessionID !== input.sessionID) continue;
              if (item.value.type === 'form.created') {
                const form = item.value.data.form;
                forms.set(form.id, form);
                yield { type: 'question.asked', properties: {
                  id: form.id, sessionID: form.sessionID,
                  questions: form.fields.map((field) => ({
                    header: field.title ?? field.key, question: field.description ?? field.title ?? field.key,
                    options: 'options' in field ? field.options?.map((option) => ({ label: option.value, description: option.description ?? option.label })) ?? [] : [],
                    multiple: field.type === 'multiselect',
                  })),
                } };
                continue;
              }
              const event = translate(item.value);
              if (event !== undefined) yield event;
            }
          } finally {
            for (const [id, form] of forms) {
              if (form.sessionID === input.sessionID) forms.delete(id);
            }
            await source.return?.();
          }
        })();
        return { stream };
      },
    },
    permission: {
      reply: (input, options) => client.permission.reply({ sessionID: input.sessionID, requestID: input.requestID, decision: input.reply }, options),
    },
    question: {
      async reply(input, options) {
        const form = forms.get(input.requestID);
        if (form === undefined) throw new Error('OpenCode v2 question form was not observed');
        const answer = Object.fromEntries(form.fields.map((field, index) => {
          const values = input.answers[index];
          if (values === undefined) throw new Error('OpenCode v2 question answer is missing');
          return [field.key, field.type === 'multiselect' ? values : values.join(', ')];
        }));
        await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer }, options);
        forms.delete(form.id);
      },
      async reject(input, options) {
        const form = forms.get(input.requestID);
        if (form === undefined) throw new Error('OpenCode v2 question form was not observed');
        await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, options);
        forms.delete(form.id);
      },
    },
  };
}
