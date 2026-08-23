import { randomUUID } from 'node:crypto';
import { getLabelObject } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { prependInitialPromptContext, formatSourceContextSection } from './promptSections.js';
import {
  buildTaskInstructionFormat,
  formatStepPreviews,
  selectSummaryAction,
} from './interactive-summary.js';
import type { SummaryPromptOptions } from './conversationLoop.js';
import type { PostSummaryAction } from './interactive-summary-types.js';
import type { InteractiveImageAttachment } from './imageAttachments.js';
import { ensureOrderAttachmentContent } from '../tasks/orderRevision.js';

interface OrderRevisionUIText {
  proposed: string;
  actionPrompt: string;
  actions: {
    approve: string;
    reject: string;
  };
}

function formatConversation(options: SummaryPromptOptions): string {
  if (options.history.length > 0) {
    const history = options.history
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
      .join('\n\n');
    return `${options.conversationLabel}\n${history}`;
  }
  if (options.hasSession) {
    return `${options.conversationLabel}\n${options.noTranscriptNote}`;
  }
  return '';
}

function canonicalOrderMarker(kind: 'BEGIN' | 'END', nonce: string): string {
  return `--- ${kind} CANONICAL ORDER.MD ${nonce} ---`;
}

function formatCanonicalOrderContent(canonicalOrderContent: string): string {
  let nonce = randomUUID();
  while (
    canonicalOrderContent.includes(canonicalOrderMarker('BEGIN', nonce))
    || canonicalOrderContent.includes(canonicalOrderMarker('END', nonce))
  ) {
    nonce = randomUUID();
  }

  return [
    canonicalOrderMarker('BEGIN', nonce),
    canonicalOrderContent,
    canonicalOrderMarker('END', nonce),
  ].join('\n');
}

export function buildOrderRevisionPrompt(
  options: SummaryPromptOptions,
  canonicalOrderContent: string,
): string {
  const conversation = formatConversation(options);
  const sourceContext = formatSourceContextSection(options.lang, options.sourceContext);
  if (!conversation && !sourceContext && !options.userNote) {
    return '';
  }

  const hasWorkflowPreview = !!options.workflowContext?.stepPreviews?.length;
  const prompt = loadTemplate('score_order_revision_system_prompt', options.lang, {
    canonicalOrderContent: formatCanonicalOrderContent(canonicalOrderContent),
    conversation,
    sourceContext,
    userNote: options.userNote,
    hasWorkflowPreview,
    workflowStructure: options.workflowContext?.workflowStructure ?? '',
    stepDetails: hasWorkflowPreview
      ? formatStepPreviews(options.workflowContext!.stepPreviews!, options.lang)
      : '',
    taskInstructionFormat: buildTaskInstructionFormat(options.lang, options.formalSpec),
  });
  return prependInitialPromptContext(prompt, options.promptContext);
}

export function createOrderRevisionSelector(
): (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null> {
  return async (task: string, lang: 'en' | 'ja'): Promise<PostSummaryAction | null> => {
    const ui = getLabelObject<OrderRevisionUIText>('orderRevision.ui', lang);
    return selectSummaryAction(
      task,
      ui.proposed,
      ui.actionPrompt,
      [
        { label: ui.actions.approve, value: 'execute' },
        { label: ui.actions.reject, value: 'continue' },
      ],
    );
  };
}

export function normalizeOrderRevisionSummary(
  task: string,
  attachments: readonly InteractiveImageAttachment[],
  lang: 'en' | 'ja',
): { task: string; attachments: readonly InteractiveImageAttachment[] } {
  return {
    task: ensureOrderAttachmentContent(task, attachments, lang),
    attachments,
  };
}
