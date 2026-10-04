import type { AgentResponse, PermissionMode, StepProviderOptions } from '../../models/index.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { createAbortError } from './abort.js';
import { appendCompanionEvidenceSystemGuard } from './evidence.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import {
  AGENT_FAILURE_CATEGORIES,
  createProviderStreamParseError,
  isProviderStreamParseError,
} from '../../../shared/types/agent-failure.js';

export type CompanionAgentPurpose = 'selector' | 'reviewer' | 'moderator';

interface CompanionAgentResolution {
  readonly provider: ProviderType;
  readonly model?: string;
  readonly providerOptions?: StepProviderOptions;
  readonly permissionMode?: PermissionMode;
}

interface CompanionCallOptions {
  cwd: string;
  projectCwd: string;
  failureDir: string;
  language: string;
  attempt: number;
  resolution: CompanionAgentResolution;
  abortSignal: AbortSignal;
  registerFinish: (finish: () => void) => void;
  onPromptResolved?: (prompt: { systemPrompt: string; userInstruction: string }) => void;
}

export interface CompanionCallAudit {
  readonly purpose: CompanionAgentPurpose;
  readonly agentName: string;
  readonly attempt: number;
  readonly status: 'completed' | 'failed';
  readonly provider: ProviderType;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly prompt?: string;
  readonly promptResolved: boolean;
  readonly response?: AgentResponse;
  readonly error?: string;
}

export type CompanionStructuredResponseValidator = (response: AgentResponse) => void;

const MAX_COMPANION_CALL_ATTEMPTS = 2;

export async function executeCompanionStructuredAgent(input: {
  purpose: CompanionAgentPurpose;
  agentName: string;
  systemPrompt: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  cwd: string;
  projectCwd: string;
  failureDir: string;
  language: string;
  resolution: CompanionAgentResolution;
  abortSignal?: AbortSignal;
  call: (
    systemPrompt: string,
    prompt: string,
    outputSchema: Record<string, unknown>,
    options: CompanionCallOptions,
  ) => Promise<AgentResponse>;
  validateResponse?: CompanionStructuredResponseValidator;
  recordUsage: (event: {
    purpose: CompanionAgentPurpose;
    agentName: string;
    success: boolean;
    usage?: AgentResponse['providerUsage'];
  }) => void;
  recordCall?: (event: CompanionCallAudit) => void;
  onCallAuditPersistenceFailure?: (failure: {
    purpose: CompanionAgentPurpose;
    agentName: string;
    attempt: number;
    error: unknown;
  }) => void;
}): Promise<AgentResponse> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await executeCompanionStructuredAgentInternal(input, attempt);
      if (response.status === 'done') return response;
      if (response.failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR) {
        throw createProviderStreamParseError(response.error ?? response.content ?? response.status);
      }
      if (attempt >= MAX_COMPANION_CALL_ATTEMPTS) {
        throw new Error(companionResponseFailureMessage(input, response));
      }
    } catch (error) {
      if (isProviderStreamParseError(error)) throw error;
      if (input.abortSignal?.aborted || attempt >= MAX_COMPANION_CALL_ATTEMPTS) {
        throw error;
      }
    }
  }
}

function companionResponseFailureMessage(
  input: Parameters<typeof executeCompanionStructuredAgent>[0],
  response: AgentResponse,
): string {
  const detail = safeExternalErrorMessage(response.error ?? response.content).trim();
  return [
    `Companion ${input.purpose} "${input.agentName}" returned status "${response.status}"`,
    ...(detail.length === 0 ? [] : [detail]),
  ].join(': ');
}

async function executeCompanionStructuredAgentInternal(input: Parameters<
  typeof executeCompanionStructuredAgent
>[0], attempt: number): Promise<AgentResponse> {
  const controller = new AbortController();
  let rejectParentAbort: ((error: Error) => void) | undefined;
  let parentAborted = false;
  let finishCall: (() => void) | undefined;
  const parentAbort = new Promise<never>((_resolve, reject) => {
    rejectParentAbort = reject;
  });
  const abortFromParent = () => {
    parentAborted = true;
    finishCall?.();
    controller.abort(input.abortSignal?.reason);
    rejectParentAbort?.(createAbortError(input.abortSignal?.reason));
  };
  if (input.abortSignal?.aborted) throw createAbortError(input.abortSignal.reason);
  input.abortSignal?.addEventListener('abort', abortFromParent, { once: true });
  let response: AgentResponse | undefined;
  let callAuditRecorded = false;
  const guardedSystemPrompt = appendCompanionEvidenceSystemGuard(input.systemPrompt);
  let actualSystemPrompt: string | undefined;
  let actualPrompt: string | undefined;
  let promptResolved = false;
  const recordCall = (audit: Omit<CompanionCallAudit, 'purpose' | 'agentName' | 'attempt' | 'provider' | 'model' | 'systemPrompt'> & {
    readonly systemPrompt?: string;
  }): void => {
    if (input.recordCall === undefined) return;
    callAuditRecorded = true;
    try {
      input.recordCall({
        purpose: input.purpose,
        agentName: input.agentName,
        attempt,
        provider: input.resolution.provider,
        ...(input.resolution.model === undefined ? {} : { model: input.resolution.model }),
        ...(audit.promptResolved
          ? {
            promptResolved: true,
            ...(audit.systemPrompt === undefined && actualSystemPrompt === undefined
              ? {}
              : { systemPrompt: audit.systemPrompt ?? actualSystemPrompt }),
            ...(audit.prompt === undefined && actualPrompt === undefined
              ? {}
              : { prompt: audit.prompt ?? actualPrompt }),
          }
          : { promptResolved: false }),
        status: audit.status,
        ...(audit.response === undefined ? {} : { response: audit.response }),
        ...(audit.error === undefined ? {} : { error: audit.error }),
      });
    } catch (error) {
      try {
        input.onCallAuditPersistenceFailure?.({
          purpose: input.purpose,
          agentName: input.agentName,
          attempt,
          error,
        });
      } catch {
        // Audit diagnostics must not change the provider result or retry policy.
      }
    }
  };
  try {
    const call = input.call(
      guardedSystemPrompt,
      input.prompt,
      input.outputSchema,
      {
        cwd: input.cwd,
        projectCwd: input.projectCwd,
        failureDir: input.failureDir,
        language: input.language,
        attempt,
        resolution: input.resolution,
        abortSignal: controller.signal,
        registerFinish: (finish) => {
          finishCall = finish;
          if (parentAborted) finish();
        },
        onPromptResolved: ({ systemPrompt, userInstruction }) => {
          actualSystemPrompt = systemPrompt;
          actualPrompt = userInstruction;
          promptResolved = true;
        },
      },
    );
    void call.catch(() => undefined);
    response = await Promise.race([
      call,
      parentAbort,
    ]);
    if (response.status === 'done') {
      input.validateResponse?.(response);
    }
    recordCall({
      ...(promptResolved ? {
        promptResolved: true,
        systemPrompt: actualSystemPrompt,
        prompt: actualPrompt,
      } : { promptResolved: false }),
      status: response.status === 'done' ? 'completed' : 'failed',
      response,
      ...(response.status === 'done'
        ? {}
        : { error: safeExternalErrorMessage(response.error ?? response.content) }),
    });
    input.recordUsage({
      purpose: input.purpose,
      agentName: input.agentName,
      success: response.status === 'done',
      usage: response.providerUsage,
    });
    return response;
  } catch (error) {
    if (!callAuditRecorded) {
      recordCall({
        ...(promptResolved ? {
          promptResolved: true,
          systemPrompt: actualSystemPrompt,
          prompt: actualPrompt,
        } : { promptResolved: false }),
        status: 'failed',
        ...(response === undefined ? {} : { response }),
        error: safeExternalErrorMessage(error),
      });
    }
    if (!parentAborted) {
      input.recordUsage({
        purpose: input.purpose,
        agentName: input.agentName,
        success: false,
        usage: response?.providerUsage,
      });
    }
    throw error;
  } finally {
    finishCall?.();
    input.abortSignal?.removeEventListener('abort', abortFromParent);
  }
}
