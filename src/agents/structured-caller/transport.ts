import type { AgentResponse, Language, PermissionMode } from '../../core/models/types.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import { validateStructuredOutputAgainstSchema } from '../../core/workflow/engine/structured-output-schema-validator.js';
import { resolveAllowedToolsForProvider } from '../../core/workflow/engine/engine-provider-options.js';
import { providerSupportsStructuredOutput } from '../../infra/providers/provider-capabilities.js';
import { buildStructuredJsonSchemaInstruction } from '../../shared/prompts/index.js';
import { createAgentResponseFailureError } from '../../shared/types/agent-failure.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type { RunAgentOptions } from '../runner.js';
import { executeAgent } from '../agent-usecases.js';
import { parseStructuredOutputObject } from './shared.js';

export interface StructuredAgentResolution {
  readonly provider: ProviderType;
  readonly model?: string;
  readonly providerOptions?: StepProviderOptions;
  readonly permissionMode?: PermissionMode;
}

export interface StructuredAgentCallOptions {
  readonly name: string;
  readonly cwd: string;
  readonly projectCwd?: string;
  readonly persona?: string;
  readonly personaPath?: string;
  readonly workflowBundleResourceRoot?: string;
  readonly systemPrompt?: string;
  readonly resolution: StructuredAgentResolution;
  readonly maxTurns?: number;
  readonly language?: Language;
  readonly abortSignal?: AbortSignal;
  readonly childProcessEnv?: Readonly<Record<string, string>>;
  readonly failureDir?: RunAgentOptions['failureDir'];
  readonly onStream?: RunAgentOptions['onStream'];
  readonly onActivity?: RunAgentOptions['onActivity'];
  readonly onPromptResolved?: RunAgentOptions['onPromptResolved'];
  readonly onDispatch?: RunAgentOptions['onDispatch'];
  readonly workflowMeta?: RunAgentOptions['workflowMeta'];
  readonly allowedTools?: RunAgentOptions['allowedTools'];
  readonly mcpServers?: RunAgentOptions['mcpServers'];
  readonly outputSchema?: RunAgentOptions['outputSchema'];
}

export interface StructuredAgentResponse<T extends Record<string, unknown>> extends AgentResponse {
  structuredOutput: T;
}

export class StructuredAgentResponseError extends Error {
  constructor(
    message: string,
    readonly response: AgentResponse,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StructuredAgentResponseError';
  }
}

export class StructuredAgentContractError extends StructuredAgentResponseError {
  constructor(
    message: string,
    response: AgentResponse,
    options?: ErrorOptions,
  ) {
    super(message, response, options);
    this.name = 'StructuredAgentContractError';
  }
}

export function requireStructuredAgentProvider(
  provider: ProviderType | undefined,
  name: string,
): ProviderType {
  if (provider === undefined) {
    throw new Error(`Structured agent "${name}" requires a resolved provider`);
  }
  return provider;
}

/** Fresh-session provider-neutral transport shared by every TAKT-owned synthetic agent. */
async function executeFreshAgent(
  instruction: string,
  options: StructuredAgentCallOptions,
): Promise<AgentResponse> {
  const profileAllowedTools = resolveAllowedToolsForProvider(
    options.resolution.providerOptions,
    false,
    undefined,
    options.resolution.provider,
  );
  return executeAgent(options.persona, instruction, {
    cwd: options.cwd,
    projectCwd: options.projectCwd,
    personaPath: options.personaPath,
    workflowBundleResourceRoot: options.workflowBundleResourceRoot,
    ...(options.systemPrompt === undefined
      ? {}
      : { internalSystemPrompt: options.systemPrompt, internalAgentName: options.name }),
    resolvedExecution: {
      provider: options.resolution.provider,
      model: options.resolution.model,
      providerOptions: options.resolution.providerOptions,
      permissionMode: options.resolution.permissionMode,
    },
    ...(options.allowedTools !== undefined
      ? { allowedTools: options.allowedTools }
      : profileAllowedTools === undefined ? {} : { allowedTools: profileAllowedTools }),
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    ...(options.childProcessEnv === undefined ? {} : { childProcessEnv: options.childProcessEnv }),
    ...(options.failureDir === undefined ? {} : { failureDir: options.failureDir }),
    ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
    ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }),
    ...(options.onPromptResolved === undefined ? {} : { onPromptResolved: options.onPromptResolved }),
    ...(options.onDispatch === undefined ? {} : { onDispatch: options.onDispatch }),
    ...(options.workflowMeta === undefined ? {} : { workflowMeta: options.workflowMeta }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    sessionId: undefined,
  });
}

const STRUCTURED_TEXT_SCHEMA = {
  type: 'object',
  properties: { content: { type: 'string' } },
  required: ['content'],
  additionalProperties: false,
} as const;

/** Typed text-result adapter for synthetic agents whose domain output remains natural language. */
export async function executeStructuredTextAgent(
  instruction: string,
  options: StructuredAgentCallOptions,
): Promise<AgentResponse> {
  const response = await executeStructuredAgent<{ content: string }>(
    instruction,
    STRUCTURED_TEXT_SCHEMA,
    options,
  );
  const { structuredOutput, ...domainResponse } = response;
  return { ...domainResponse, content: structuredOutput.content };
}

/**
 * Provider-neutral transport for TAKT-owned structured agents.
 *
 * The transport owns only fresh-session execution and the structured response contract. Runtime
 * permissions, tools, MCP, network, sandbox, skills, and bypass policy are passed through only
 * when their caller's resolved profile supplied them.
 */
export async function executeStructuredAgent<T extends Record<string, unknown>>(
  instruction: string,
  schema: Record<string, unknown>,
  options: StructuredAgentCallOptions,
): Promise<StructuredAgentResponse<T>> {
  const nativeStructuredOutput = providerSupportsStructuredOutput(options.resolution.provider) === true;
  const response = await executeFreshAgent(
    nativeStructuredOutput
      ? instruction
      : buildStructuredJsonSchemaInstruction(instruction, schema, options.language ?? 'en'),
    {
      ...options,
      ...(nativeStructuredOutput ? { outputSchema: schema } : {}),
    },
  );

  if (response.status !== 'done') {
    if (response.failureCategory !== undefined) {
      throw createAgentResponseFailureError(response, `Structured agent "${options.name}" did not complete`);
    }
    throw new StructuredAgentResponseError(
      response.error || response.content || `Structured agent "${options.name}" did not complete`,
      response,
    );
  }
  let structuredOutput: Record<string, unknown>;
  try {
    structuredOutput = response.structuredOutput
      ?? parseStructuredOutputObject(response.content);
    validateStructuredOutputAgainstSchema(structuredOutput, schema);
  } catch (error) {
    throw new StructuredAgentContractError(
      error instanceof Error ? error.message : 'Structured output validation failed',
      response,
      { cause: error },
    );
  }
  return {
    ...response,
    structuredOutput: structuredOutput as T,
  };
}
