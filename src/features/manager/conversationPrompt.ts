import type { TurnEvent } from '../../core/daemon/events.js';
import { loadTemplate, renderTemplate } from '../../shared/prompts/index.js';
import { buildManagerEventPrompt } from '../daemon/inboxEvent.js';

interface ManagerSystemPromptInput {
  lang: 'ja' | 'en';
  facets: { persona: string; policy: string; knowledge: string; instruction: string };
  specificationConfiguration: { mode: boolean; comments: boolean } | readonly { repositoryDirectory: string; mode: boolean; comments: boolean }[];
  formalSpecVerifierConstraints: string;
  repository: string;
  mainMerge: string;
  concurrency: number;
}

export function buildManagerSystemPrompt(input: ManagerSystemPromptInput): string {
  const { lang, facets, specificationConfiguration } = input;
  const settings = Array.isArray(specificationConfiguration) ? specificationConfiguration : [specificationConfiguration];
  return [
    loadTemplate('manager_system_context', lang).trim(),
    facets.persona.trim(), facets.policy.trim(), facets.knowledge.trim(),
    renderTemplate(facets.instruction.trim(), {
      formalSpec: settings.some((setting) => setting.mode),
      formalSpecCommentsEnabled: settings.some((setting) => setting.mode && setting.comments),
      formalSpecVerifierConstraints: input.formalSpecVerifierConstraints,
    }),
    loadTemplate('manager_runtime_settings', lang, {
      repository: JSON.stringify(input.repository),
      specificationConfiguration: JSON.stringify(specificationConfiguration),
      mainMerge: JSON.stringify(input.mainMerge),
      concurrency: String(input.concurrency),
    }).trim(),
  ].join('\n\n');
}

export function buildManagerTurnPrompt(input: {
  lang: 'ja' | 'en';
  event: TurnEvent & { unreadableGoalIds?: readonly string[] };
  question?: string;
  interruptedMessage?: string | null;
}): string {
  const { lang, event } = input;
  let kind: string = event.kind;
  let body: string;
  switch (event.kind) {
    case 'human_command':
      if (event.command.kind !== 'message') throw new Error('Only message commands start model turns');
      body = JSON.stringify({ speaker: event.speaker, text: event.command.text });
      break;
    case 'director_message':
      kind = event.inquiryAnswer === undefined ? `director_message_${event.origin ?? 'unknown'}` : 'inquiry_answered';
      body = JSON.stringify(event.inquiryAnswer === undefined ? { text: event.text, origin: event.origin ?? 'unknown', directorConversationId: event.directorConversationId }
        : { goalId: null, ...event.inquiryAnswer });
      break;
    case 'goal_resumed':
      kind = `goal_resumed_${event.origin ?? 'unknown'}`;
      body = buildManagerEventPrompt(event);
      break;
    case 'inquiry_answered':
      body = JSON.stringify({ ...event, ...(input.question === undefined ? {} : { question: input.question }) });
      break;
    case 'inquiry_answer': throw new Error('Inquiry answers must be saved before model delivery');
    default: body = buildManagerEventPrompt(event);
  }
  return [
    ...(input.interruptedMessage == null ? [] : [renderTemplate(loadTemplate('manager_turn_interrupted', lang).trim(), { body: input.interruptedMessage })]),
    loadTemplate('manager_turn', lang, { [kind]: true, body }).trim(),
  ].join('\n\n');
}
