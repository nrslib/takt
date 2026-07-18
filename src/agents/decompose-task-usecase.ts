import type { AgentResponse, Language, PartDefinition } from '../core/models/types.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';
import type { ProviderType } from '../core/workflow/types.js';
import { runAgent, type RunAgentOptions, type StreamCallback } from './runner.js';
import { parseParts } from '../core/workflow/engine/task-decomposer.js';
import { loadDecompositionSchema, loadMorePartsSchema } from '../infra/resources/schema-loader.js';
import {
  buildDecomposePrompt,
  buildMorePartsPrompt,
  toMorePartsResponse,
  toPartDefinitions,
} from './team-leader-structured-output.js';

export interface DecomposeTaskOptions {
  cwd: string;
  persona?: string;
  personaPath?: string;
  language?: Language;
  model?: string;
  provider?: ProviderType;
  resolvedModel?: string;
  resolvedProvider?: ProviderType;
  onStream?: StreamCallback;
  workflowMeta?: RunAgentOptions['workflowMeta'];
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: RunAgentOptions['abortSignal'];
  mcpServers?: RunAgentOptions['mcpServers'];
  inspectTools?: string[];
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
  onAgentResponse?: (response: AgentResponse) => void;
  onAgentError?: (error: unknown) => void;
}

export type MorePartsOptions = Omit<DecomposeTaskOptions, 'inspectTools' | 'onPromptResolved'>;

export interface MorePartsResponse {
  done: boolean;
  reasoning: string;
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
}

export interface DecomposeTaskResponse {
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
}

export async function decomposeTask(
  instruction: string,
  maxTotalParts: number,
  options: DecomposeTaskOptions,
): Promise<DecomposeTaskResponse> {
  let response: AgentResponse;
  try {
    response = await runAgent(options.persona, buildDecomposePrompt(
      instruction,
      maxTotalParts,
      options.language,
      options.inspectTools,
    ), {
      cwd: options.cwd,
      personaPath: options.personaPath,
      language: options.language,
      model: options.model,
      provider: options.provider,
      resolvedModel: options.resolvedModel,
      resolvedProvider: options.resolvedProvider,
      allowedTools: options.inspectTools ?? [],
      mcpServers: options.mcpServers,
      permissionMode: 'readonly',
      outputSchema: loadDecompositionSchema(maxTotalParts),
      onStream: options.onStream,
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      onPromptResolved: options.onPromptResolved,
    });
  } catch (error) {
    options.onAgentError?.(error);
    throw error;
  }
  options.onAgentResponse?.(response);

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader failed: ${detail}`);
  }

  const parts = response.structuredOutput?.parts;
  if (parts != null) {
    return {
      parts: toPartDefinitions(parts, maxTotalParts),
      ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
    };
  }

  return {
    parts: parseParts(response.content, maxTotalParts),
    ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
  };
}

export async function requestMoreParts(
  originalInstruction: string,
  allResults: Array<{ id: string; title: string; status: string; content: string }>,
  existingIds: string[],
  maxAdditionalParts: number,
  options: MorePartsOptions,
): Promise<MorePartsResponse> {
  const prompt = buildMorePartsPrompt(
    originalInstruction,
    allResults,
    existingIds,
    maxAdditionalParts,
    options.language,
  );

  let response: AgentResponse;
  try {
    response = await runAgent(options.persona, prompt, {
      cwd: options.cwd,
      personaPath: options.personaPath,
      language: options.language,
      model: options.model,
      provider: options.provider,
      resolvedModel: options.resolvedModel,
      resolvedProvider: options.resolvedProvider,
      allowedTools: [],
      mcpServers: options.mcpServers,
      permissionMode: 'readonly',
      outputSchema: loadMorePartsSchema(maxAdditionalParts),
      onStream: options.onStream,
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
    });
  } catch (error) {
    options.onAgentError?.(error);
    throw error;
  }
  options.onAgentResponse?.(response);

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader feedback failed: ${detail}`);
  }

  return {
    ...toMorePartsResponse(response.structuredOutput, maxAdditionalParts),
    ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
  };
}
