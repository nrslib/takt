import type { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { loadManagedSdk } from '../managed-providers/loader.js';
import type { ManagedOpenCodeTransport, OpenCodeResolvedModel } from './transport.js';
import { registerModelSelectionSessionCleanup } from './model-selection-session-cleanup.js';

const MODEL_SELECTION_CLEANUP_TIMEOUT_MS = 5_000;

type V1Client = ReturnType<typeof createOpencodeClient>;
type ModelRef = OpenCodeResolvedModel;

function readModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const model = value as { providerID?: unknown; modelID?: unknown; id?: unknown; variant?: unknown };
  const modelID = typeof model.modelID === 'string' ? model.modelID : model.id;
  if (typeof model.providerID !== 'string' || typeof modelID !== 'string') return undefined;
  return {
    providerID: model.providerID,
    modelID,
    ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
  };
}

export async function createV1Transport(baseUrl: string): Promise<ManagedOpenCodeTransport> {
  const { modules, directory, stale } = await loadManagedSdk('opencode');
  const { createOpencodeClient } = modules[0];
  const client = Object.assign(createOpencodeClient({ baseUrl }), { sdkState: { directory, stale } }) as V1Client & Partial<ManagedOpenCodeTransport>;
  client.resolveModel = async (input, options): Promise<OpenCodeResolvedModel> => {
    if (input.agent !== undefined) {
      const agents = await client.app.agents({ directory: input.directory }, options);
      const agent = agents.data?.find((item) => item.name === input.agent);
      if (agent === undefined) throw new Error(`OpenCode v1 agent not found: ${input.agent}`);
      const agentModel = readModelRef(agent.model);
      if (agentModel !== undefined) return agentModel;
    }

    if (input.sessionID !== undefined) {
      const session = await client.session.get({ sessionID: input.sessionID, directory: input.directory }, options);
      const storedModel = readModelRef((session.data as unknown as { model?: unknown } | undefined)?.model);
      if (storedModel !== undefined) return storedModel;

      const messages = await client.session.messages({ sessionID: input.sessionID, directory: input.directory }, options);
      const previousModel = [...(messages.data ?? [])].reverse().find((message) => {
        const info = (message as unknown as { info?: { role?: unknown; model?: unknown } }).info;
        return info?.role === 'user' && readModelRef(info.model) !== undefined;
      });
      const info = (previousModel as unknown as { info?: { model?: unknown } } | undefined)?.info;
      const previousModelRef = readModelRef(info?.model);
      if (previousModelRef !== undefined) return previousModelRef;
    }

    let resolveCreatedSessionID!: (sessionID: string | undefined) => void;
    let createdSessionIDSettled = false;
    const createdSessionID = new Promise<string | undefined>((resolve) => {
      resolveCreatedSessionID = resolve;
    });
    const settleCreatedSessionID = (sessionID: string | undefined): void => {
      if (createdSessionIDSettled) return;
      createdSessionIDSettled = true;
      resolveCreatedSessionID(sessionID);
    };
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        const cleanupSignal = AbortSignal.timeout(MODEL_SELECTION_CLEANUP_TIMEOUT_MS);
        const sessionID = await new Promise<string | undefined>((resolve, reject) => {
          const onTimeout = (): void => reject(cleanupSignal.reason ?? new Error('OpenCode model-selection cleanup timed out'));
          if (cleanupSignal.aborted) {
            onTimeout();
            return;
          }
          cleanupSignal.addEventListener('abort', onTimeout, { once: true });
          void createdSessionID.then((resolvedSessionID) => {
            cleanupSignal.removeEventListener('abort', onTimeout);
            resolve(resolvedSessionID);
          });
        });
        if (sessionID === undefined) return;
        const deleted = await client.session.delete(
          { sessionID, directory: input.directory },
          { signal: cleanupSignal },
        );
        if (deleted.data !== true) throw new Error('OpenCode v1 model-selection session was not deleted');
      })();
      return cleanupPromise;
    };
    const unregisterCleanup = registerModelSelectionSessionCleanup(cleanup);

    let model: OpenCodeResolvedModel | undefined;
    let promptError: unknown;
    try {
      const created = await client.session.create({ directory: input.directory }, options);
      const sessionID = created.data?.id;
      settleCreatedSessionID(sessionID);
      if (sessionID === undefined) throw new Error('Failed to create OpenCode v1 model-selection session');

      const result = await client.session.prompt({
        sessionID,
        directory: input.directory,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        noReply: true,
        parts: [],
      }, options);
      const message = result.data as unknown as { info?: { model?: unknown } } | undefined;
      const selectedModel = readModelRef(message?.info?.model);
      if (selectedModel === undefined) {
        throw new Error('OpenCode v1 model-selection prompt did not return a selected model');
      }
      model = selectedModel;
    } catch (error) {
      settleCreatedSessionID(undefined);
      promptError = error;
    }

    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    } finally {
      unregisterCleanup();
    }

    if (promptError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([promptError, cleanupError], 'OpenCode v1 model selection and temporary session cleanup failed');
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (promptError !== undefined) throw promptError;
    if (model === undefined) throw new Error('OpenCode v1 model selection returned no model');
    return model;
  };
  return client as ManagedOpenCodeTransport;
}
