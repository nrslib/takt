import { executeIsolatedStructuredInternalAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse } from '../../models/types.js';
import type { ProviderRoutingEntry } from '../../models/config-types.js';
import {
  executeCompanionStructuredAgent,
  type CompanionAgentPurpose,
  type CompanionCallAudit,
  type CompanionStructuredResponseValidator,
} from './review-runner.js';

export class CompanionStructuredCaller {
  constructor(private readonly input: {
    readonly cwd: string;
    readonly projectCwd: string;
    readonly failureDir: string;
    readonly language: 'en' | 'ja';
    readonly abortSignal?: AbortSignal;
    readonly recordUsage: (
      name: string,
      provider: ProviderRoutingEntry,
      success: boolean,
      usage: AgentResponse['providerUsage'],
    ) => void;
    readonly recordCall: (event: CompanionCallAudit) => void;
    readonly onCallAuditPersistenceFailure?: (failure: {
      purpose: CompanionAgentPurpose;
      agentName: string;
      attempt: number;
      error: unknown;
    }) => void;
  }) {}

  call(request: {
    readonly purpose: CompanionAgentPurpose;
    readonly agentName: string;
    readonly provider: ProviderRoutingEntry;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly outputSchema: Record<string, unknown>;
    readonly abortSignal?: AbortSignal;
    readonly validateResponse?: CompanionStructuredResponseValidator;
  }): Promise<AgentResponse> {
    if (request.provider.provider === undefined) {
      throw new Error(`Companion "${request.agentName}" has no provider`);
    }
    const signal = request.abortSignal ?? this.input.abortSignal;
    return executeCompanionStructuredAgent({
      purpose: request.purpose,
      agentName: request.agentName,
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      outputSchema: request.outputSchema,
      cwd: this.input.cwd,
      projectCwd: this.input.projectCwd,
      failureDir: this.input.failureDir,
      language: this.input.language,
      resolution: {
        provider: request.provider.provider,
        model: request.provider.model,
        providerOptions: request.provider.providerOptions ?? {},
      },
      abortSignal: signal,
      validateResponse: request.validateResponse,
      call: (systemPrompt, prompt, schema, options) => executeIsolatedStructuredInternalAgent(
        systemPrompt,
        prompt,
        schema,
        {
          cwd: options.cwd,
          projectCwd: options.projectCwd,
          failureDir: options.failureDir,
          agentName: request.agentName,
          language: this.input.language,
          abortSignal: options.abortSignal,
          onPromptResolved: options.onPromptResolved,
          resolution: {
            provider: options.resolution.provider,
            model: options.resolution.model,
            providerOptions: options.resolution.providerOptions ?? {},
          },
        },
      ),
      recordUsage: ({ success, usage }) => {
        this.input.recordUsage(request.agentName, request.provider, success, usage);
      },
      recordCall: (event) => {
        this.input.recordCall(event);
      },
      ...(this.input.onCallAuditPersistenceFailure === undefined
        ? {}
        : { onCallAuditPersistenceFailure: this.input.onCallAuditPersistenceFailure }),
    });
  }
}
