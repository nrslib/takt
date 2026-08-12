import type { AgentResponse, Language, PermissionMode } from '../../core/models/types.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import { validateStructuredOutputAgainstSchema } from '../../core/workflow/engine/structured-output-schema-validator.js';
import { resolveAllowedToolsForProvider } from '../../core/workflow/engine/engine-provider-options.js';
import { providerSupportsStructuredOutput } from '../../infra/providers/provider-capabilities.js';
import { buildStructuredJsonSchemaInstruction } from '../../shared/prompts/index.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type { RunAgentOptions } from '../runner.js';
import { executeAgent } from '../agent-usecases.js';
import { parseStructuredOutputObject } from './shared.js';

export interface StructuredAgentResolution {
  readonly provider?: ProviderType;
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
  readonly onStream?: RunAgentOptions['onStream'];
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

export class StructuredAgentContractError extends Error {
  constructor(
    message: string,
    readonly response: AgentResponse,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StructuredAgentContractError';
  }
}

/** Fresh-session provider-neutral transport shared by every TAKT-owned synthetic agent. */
export async function executeFreshAgent(
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
    resolvedProvider: options.resolution.provider,
    resolvedModel: options.resolution.model,
    ...(options.resolution.providerOptions === undefined
      ? {}
      : { resolvedProviderOptions: options.resolution.providerOptions }),
    ...(options.resolution.permissionMode === undefined
      ? {}
      : { permissionMode: options.resolution.permissionMode }),
    ...(options.allowedTools !== undefined
      ? { allowedTools: options.allowedTools }
      : profileAllowedTools === undefined ? {} : { allowedTools: profileAllowedTools }),
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    ...(options.childProcessEnv === undefined ? {} : { childProcessEnv: options.childProcessEnv }),
    ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
    ...(options.onPromptResolved === undefined ? {} : { onPromptResolved: options.onPromptResolved }),
    ...(options.onDispatch === undefined ? {} : { onDispatch: options.onDispatch }),
    ...(options.workflowMeta === undefined ? {} : { workflowMeta: options.workflowMeta }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    sessionId: undefined,
  });
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
    throw new StructuredAgentContractError(
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
