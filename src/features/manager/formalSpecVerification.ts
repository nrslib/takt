import type { ManagerConversationPlan } from './conversationPlan.js';
import type { ManagerTurnInput } from './turnExecutor.js';
import { getManagerOutputSchema, parseManagerResponse } from './turnResponse.js';
import type { ResolvedFormalSpecConfiguration } from '../interactive/taskInstructionFormat.js';
import { runFormalSpecVerification, cleanupFormalSpecVerificationArtifacts } from '../interactive/formalSpecVerification.js';
import {
  buildFormalSpecGenerationPrompt, buildFormalSpecGenerationSystemPrompt,
  buildFormalSpecInterpretationPrompt, buildFormalSpecInterpretationSystemPrompt,
  getFormalSpecVerificationArtifactPaths, getFormalSpecRetainedArtifactsMessage,
} from '../interactive/formalSpecPrompts.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { getLabel } from '../../shared/i18n/index.js';
import { createAgentFailureError } from '../../shared/types/agent-failure.js';
import type { AgentResponse } from '../../core/models/response.js';
import { createTurnActivityReporter } from './turnActivity.js';
import { callWithManagerSessionRecovery } from './sessionRecovery.js';
import { withToolActivityCall } from '../../shared/tool-activity/stream.js';

function assertSuccess(response: AgentResponse): void {
  if (response.status === 'done') return;
  if (response.failureCategory !== undefined) throw createAgentFailureError(response.failureCategory, response.error ?? 'Manager provider failed');
  throw new Error(response.error ?? 'Manager provider failed');
}

export async function verifyManagerConversation(
  cwd: string, plan: ManagerConversationPlan, input: ManagerTurnInput, configuration: ResolvedFormalSpecConfiguration & { repositoryDirectory: string },
) {
  const { ctx } = plan;
  const unchanged = { summary: null, sessionId: input.sessionId, assignment: input.assignment };
  if (!configuration.mode) return { ...unchanged, message: getLabel('interactive.ui.verifyUnavailable', ctx.lang) };
  const reporter = createTurnActivityReporter((activity) => input.onActivity?.(activity), (message) => input.onText?.(message));
  const options = {
    cwd, model: ctx.model, providerOptions: ctx.providerOptions, language: ctx.lang,
    sessionId: input.sessionId, abortSignal: input.abortSignal,
    permissionMode: 'readonly' as const, internalAgentIsolation: 'strict-readonly' as const,
    callerManagedSession: true as const,
    onStream: (event: Parameters<typeof reporter.onStream>[0]) => {
      input.onProviderOutput?.();
      if (!input.abortSignal.aborted) reporter.onStream(event);
      if (!input.abortSignal.aborted && (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'tool_output')) {
        input.onToolEvent?.(event);
      }
    },
  };
  const generator = ctx.provider.setup({ name: 'manager', systemPrompt: [
    buildFormalSpecGenerationSystemPrompt(ctx.lang),
    loadTemplate('manager_formal_spec_instructions', ctx.lang, {
      formalSpecComments: configuration.comments, formalSpecVerifierConstraints: '', verificationRepository: JSON.stringify(configuration.repositoryDirectory),
    }),
  ].join('\n\n') });
  const prompt = buildFormalSpecGenerationPrompt(ctx.lang, input.recovery?.context);
  let generated: AgentResponse;
  try {
    generated = await callWithManagerSessionRecovery(generator, { resume: prompt, fresh: prompt }, options,
      input.recovery?.invalidateSession, reporter.discard);
  } finally {
    if (!input.abortSignal.aborted) reporter.flush();
  }
  input.abortSignal.throwIfAborted();
  const verification = await runFormalSpecVerification(generated.content, configuration.repositoryDirectory, {
    abortSignal: input.abortSignal, modelCheckTimeoutSeconds: configuration.modelCheckTimeoutSeconds,
  });
  const retained = getFormalSpecRetainedArtifactsMessage(verification, ctx.lang);
  const verificationResult = `\`\`\`json\n${JSON.stringify(verification, null, 2)}\n\`\`\``;
  let interpreted: AgentResponse | undefined;
  try {
    input.abortSignal.throwIfAborted();
    if (!verification.verificationStarted) return { ...unchanged, sessionId: generated.sessionId,
      message: [generated.content, verification.message, retained].filter(Boolean).join('\n\n') };
    const interpreter = ctx.provider.setup({ name: 'manager', systemPrompt: [
      plan.strategy.systemPrompt,
      buildFormalSpecInterpretationSystemPrompt(ctx.lang, verification.artifactRetention?.status),
    ].join('\n\n') });
    try {
      interpreted = await interpreter.call(buildFormalSpecInterpretationPrompt(verification, generated.content, ctx.lang), {
        ...options, sessionId: generated.sessionId,
        onStream: withToolActivityCall(options.onStream),
        allowedTools: ['Read'], allowReadonlyFileRead: true,
        readonlyFileReadPaths: getFormalSpecVerificationArtifactPaths(verification),
        outputSchema: getManagerOutputSchema(ctx.providerType),
      });
    } finally {
      reporter.discard();
    }
    assertSuccess(interpreted);
    input.abortSignal.throwIfAborted();
    const output = parseManagerResponse(interpreted, ctx.providerType);
    return { ...unchanged, sessionId: interpreted.sessionId ?? generated.sessionId,
      message: [output.message, retained].filter(Boolean).join('\n\n') };
  } catch (error) {
    return { ...unchanged, sessionId: interpreted?.sessionId ?? generated.sessionId,
      message: [
        ...(input.abortSignal.aborted ? [] : [getLabel('manager.verifyInterpretationFailed', ctx.lang, { error: getErrorMessage(error) })]),
        verificationResult,
        retained,
      ].filter(Boolean).join('\n\n') };
  } finally { cleanupFormalSpecVerificationArtifacts(verification); }
}
