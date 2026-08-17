import { executeStructuredAgent } from '../../../agents/structured-caller/transport.js';
import type { AgentResponse } from '../../models/types.js';
import type { ProviderRoutingEntry } from '../../models/config-types.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import {
  executeCompanionStructuredAgent,
  type CompanionAgentPurpose,
  type CompanionCallAudit,
  type CompanionStructuredResponseValidator,
} from './review-runner.js';

export interface CompanionProviderCallContext {
  readonly purpose: CompanionAgentPurpose;
  readonly agentName: string;
  readonly callSequence: number;
  readonly attempt: number;
  readonly provider: ProviderRoutingEntry;
}

export type CompanionProviderCallCallbacksBuilder = (
  context: CompanionProviderCallContext,
) => Pick<RunAgentOptions, 'onStream' | 'onActivity'> & { readonly finish: () => void };

export class CompanionStructuredCaller {
  private nextCallSequence = 0;

  constructor(private readonly input: {
    readonly cwd: string;
    readonly projectCwd: string;
    readonly failureDir: string;
    readonly language: 'en' | 'ja';
    readonly abortSignal?: AbortSignal;
    readonly buildProviderCallCallbacks: CompanionProviderCallCallbacksBuilder;
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
    const callSequence = ++this.nextCallSequence;
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
        providerOptions: request.provider.providerOptions,
        permissionMode: 'readonly',
      },
      abortSignal: signal,
      validateResponse: request.validateResponse,
      call: async (systemPrompt, prompt, schema, options) => {
        const providerCallbacks = this.input.buildProviderCallCallbacks({
          purpose: request.purpose,
          agentName: request.agentName,
          callSequence,
          attempt: options.attempt,
          provider: request.provider,
        });
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          providerCallbacks.finish();
        };
        const onStream = providerCallbacks.onStream;
        const onActivity = providerCallbacks.onActivity;
        options.registerFinish(finish);
        try {
          return await executeStructuredAgent(prompt, schema, {
            name: request.agentName,
            persona: request.agentName,
            cwd: options.cwd,
            projectCwd: options.projectCwd,
            failureDir: options.failureDir,
            systemPrompt,
            language: this.input.language,
            abortSignal: options.abortSignal,
            onStream: onStream === undefined
              ? undefined
              : (event) => {
                if (!finished) onStream(event);
              },
            onActivity: onActivity === undefined
              ? undefined
              : (activity) => {
                if (!finished) onActivity(activity);
              },
            onPromptResolved: options.onPromptResolved,
            resolution: {
              provider: options.resolution.provider,
              model: options.resolution.model,
              providerOptions: options.resolution.providerOptions,
              permissionMode: 'readonly',
            },
          });
        } finally {
          finish();
        }
      },
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
