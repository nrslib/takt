import type { Language, PartDefinition } from '../core/models/types.js';
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
  inspectTools?: string[];
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

export type MorePartsOptions = Omit<DecomposeTaskOptions, 'inspectTools' | 'onPromptResolved'>;

export interface MorePartsResponse {
  done: boolean;
  reasoning: string;
  parts: PartDefinition[];
}

export async function decomposeTask(
  instruction: string,
  maxTotalParts: number,
  options: DecomposeTaskOptions,
): Promise<PartDefinition[]> {
  const response = await runAgent(options.persona, buildDecomposePrompt(
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
    permissionMode: 'readonly',
    outputSchema: loadDecompositionSchema(maxTotalParts),
    onStream: options.onStream,
    workflowMeta: options.workflowMeta,
    childProcessEnv: options.childProcessEnv,
    onPromptResolved: options.onPromptResolved,
  });

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader failed: ${detail}`);
  }

  const parts = response.structuredOutput?.parts;
  if (parts != null) {
    return toPartDefinitions(parts, maxTotalParts);
  }

  return parseParts(response.content, maxTotalParts);
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

  const response = await runAgent(options.persona, prompt, {
    cwd: options.cwd,
    personaPath: options.personaPath,
    language: options.language,
    model: options.model,
    provider: options.provider,
    resolvedModel: options.resolvedModel,
    resolvedProvider: options.resolvedProvider,
    allowedTools: [],
    permissionMode: 'readonly',
    outputSchema: loadMorePartsSchema(maxAdditionalParts),
    onStream: options.onStream,
    workflowMeta: options.workflowMeta,
    childProcessEnv: options.childProcessEnv,
  });

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader feedback failed: ${detail}`);
  }

  return toMorePartsResponse(response.structuredOutput, maxAdditionalParts);
}
