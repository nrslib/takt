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

export type CompanionAgentPurpose = 'selector' | 'reviewer' | 'moderator' | 'judge';

interface CompanionAgentResolution {
  readonly provider: ProviderType;
  readonly model?: string;
  readonly providerOptions?: StepProviderOptions;
}

interface CompanionCallOptions {
  cwd: string;
  projectCwd: string;
  failureDir: string;
  language: string;
  resolution: CompanionAgentResolution;
  permissionMode: PermissionMode;
  allowedTools: string[];
  mcpServers: Record<string, never>;
  sessionId: undefined;
  abortSignal: AbortSignal;
}

export type CompanionStructuredResponseValidator = (response: AgentResponse) => void;

const COMPANION_CALL_TIMEOUT_MS = 300_000;
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
  timeoutMs?: number;
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
}): Promise<AgentResponse> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await executeCompanionStructuredAgentInternal(input);
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
>[0]): Promise<AgentResponse> {
  const controller = new AbortController();
  let rejectParentAbort: ((error: Error) => void) | undefined;
  let parentAborted = false;
  const parentAbort = new Promise<never>((_resolve, reject) => {
    rejectParentAbort = reject;
  });
  const abortFromParent = () => {
    parentAborted = true;
    controller.abort(input.abortSignal?.reason);
    rejectParentAbort?.(createAbortError(input.abortSignal?.reason));
  };
  if (input.abortSignal?.aborted) throw createAbortError(input.abortSignal.reason);
  input.abortSignal?.addEventListener('abort', abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: AgentResponse | undefined;
  try {
    const timeoutMs = input.timeoutMs ?? COMPANION_CALL_TIMEOUT_MS;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Companion ${input.purpose} call timed out after ${timeoutMs}ms`));
        controller.abort();
      }, timeoutMs);
    });
    void timeout.catch(() => undefined);
    const call = input.call(
      appendCompanionEvidenceSystemGuard(input.systemPrompt),
      input.prompt,
      input.outputSchema,
      {
        cwd: input.cwd,
        projectCwd: input.projectCwd,
        failureDir: input.failureDir,
        language: input.language,
        resolution: input.resolution,
        permissionMode: 'readonly',
        allowedTools: [],
        mcpServers: {},
        sessionId: undefined,
        abortSignal: controller.signal,
      },
    );
    void call.catch(() => undefined);
    response = await Promise.race([
      call,
      timeout,
      parentAbort,
    ]);
    if (response.status === 'done') {
      input.validateResponse?.(response);
    }
    input.recordUsage({
      purpose: input.purpose,
      agentName: input.agentName,
      success: response.status === 'done',
      usage: response.providerUsage,
    });
    return response;
  } catch (error) {
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
    if (timer !== undefined) clearTimeout(timer);
    input.abortSignal?.removeEventListener('abort', abortFromParent);
  }
}
