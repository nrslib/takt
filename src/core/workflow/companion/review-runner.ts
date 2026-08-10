import type { AgentResponse, PermissionMode, StepProviderOptions } from '../../models/index.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { createAbortError } from './abort.js';
import { appendCompanionEvidenceSystemGuard } from './evidence.js';

export type CompanionAgentPurpose = 'selector' | 'reviewer' | 'moderator' | 'judge';

interface CompanionAgentResolution {
  readonly provider: ProviderType;
  readonly model?: string;
  readonly providerOptions?: StepProviderOptions;
}

interface CompanionCallOptions {
  cwd: string;
  projectCwd: string;
  language: string;
  resolution: CompanionAgentResolution;
  permissionMode: PermissionMode;
  allowedTools: string[];
  mcpServers: Record<string, never>;
  sessionId: undefined;
  abortSignal: AbortSignal;
}

const COMPANION_CALL_TIMEOUT_MS = 300_000;

export function executeCompanionStructuredAgent(input: {
  purpose: CompanionAgentPurpose;
  agentName: string;
  systemPrompt: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  cwd: string;
  projectCwd: string;
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
  recordUsage: (event: {
    purpose: CompanionAgentPurpose;
    agentName: string;
    success: boolean;
    usage?: AgentResponse['providerUsage'];
  }) => void;
}): Promise<AgentResponse> {
  const execution = executeCompanionStructuredAgentInternal(input);
  void execution.catch(() => undefined);
  return execution;
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
  try {
    const timeoutMs = input.timeoutMs ?? COMPANION_CALL_TIMEOUT_MS;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Companion ${input.purpose} call timed out after ${timeoutMs}ms`));
        controller.abort();
      }, timeoutMs);
    });
    const call = input.call(
      appendCompanionEvidenceSystemGuard(input.systemPrompt),
      input.prompt,
      input.outputSchema,
      {
        cwd: input.cwd,
        projectCwd: input.projectCwd,
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
    const response = await Promise.race([
      call,
      timeout,
      parentAbort,
    ]);
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
      });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.abortSignal?.removeEventListener('abort', abortFromParent);
  }
}
