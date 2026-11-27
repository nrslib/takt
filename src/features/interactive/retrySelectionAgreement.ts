import { loadTemplate } from '../../shared/prompts/index.js';
import { callAIWithRetry, type SessionContext } from './aiCaller.js';
import { withHandoffProgress } from './handoffProgress.js';
import type { ConversationMessage } from './interactive-summary-types.js';

interface RetrySelectionAgreementOptions {
  readonly cwd: string;
  readonly lang: 'en' | 'ja';
  readonly history: readonly ConversationMessage[];
  readonly sessionContext: SessionContext;
  readonly showProgress?: boolean;
}

export async function extractRetrySelectionAgreement(options: RetrySelectionAgreementOptions): Promise<string> {
  if (options.history.length === 0 && options.sessionContext.sessionId === undefined) {
    return '';
  }
  const instruction = loadTemplate('score_assistant_retry_agreement_prompt', options.lang);
  const prompt = JSON.stringify({
    instruction,
    conversation: options.history.map(({ role, content }) => ({ role, content })),
  });
  const { result, error } = await withHandoffProgress(
    options.showProgress === true,
    'extractRetryAgreement',
    options.lang,
    () => callAIWithRetry(prompt, instruction, [], options.cwd, {
      ...options.sessionContext,
      sessionId: options.history.length === 0 ? options.sessionContext.sessionId : undefined,
      mcpServers: undefined,
      taskStateMcpServers: undefined,
      disableSessionRetry: true,
    }, {
      outputMode: 'silent',
      persistSession: false,
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    }),
  );
  if (result === null || !result.success || !result.content.trim()) {
    throw new Error(error ?? (result?.content.trim() || 'The conversation agreement could not be extracted.'));
  }
  return result.content.trim();
}
