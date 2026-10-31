import { loadTemplate } from '../../../shared/prompts/index.js';
import type { Language } from '../../models/types.js';
import type {
  LiveInterventionChannel,
  LiveInterventionInstruction,
  LiveInterventionState,
  PreparedLiveInterventionDelivery,
} from './types.js';

export function buildLiveInterventionPrompt(
  instructions: readonly LiveInterventionInstruction[],
  language: Language | undefined,
): string {
  if (instructions.length === 0) {
    return '';
  }

  return loadTemplate('live_intervention_instructions', language ?? 'en', {
    instructions: instructions.map((instruction, index) => `${index + 1}. ${instruction.content}`).join('\n'),
  });
}

export function resolveLiveInterventionPrompt(
  channel: LiveInterventionChannel | undefined,
  delivery: PreparedLiveInterventionDelivery | undefined,
  language: Language | undefined,
): string {
  if (delivery !== undefined) {
    return delivery.prompt;
  }
  if (channel === undefined) {
    return '';
  }
  return buildLiveInterventionPrompt(channel.read().instructions.filter((instruction) => (
    instruction.state === 'deliveredSameSession' || instruction.state === 'deliveredNextStep'
  )), language);
}

export function formatLiveInterventionStateForPrompt(
  state: LiveInterventionState,
): string {
  if (state.instructions.length === 0) {
    return '';
  }

  return JSON.stringify({
    instructions: state.instructions.map((instruction) => ({
      instructionId: instruction.instructionId,
      issuedAt: instruction.issuedAt,
      content: instruction.content,
      state: instruction.state,
      ...(instruction.deliveryMode === undefined
        ? {}
        : { deliveryMode: instruction.deliveryMode }),
    })),
    pending: state.pending,
    issuedTotal: state.issuedTotal,
    deliveredSameSession: state.deliveredSameSession,
    deliveredNextStep: state.deliveredNextStep,
    unconsumedWarned: state.unconsumedWarned,
    warned: state.warned,
    ...(state.terminalStatus === undefined ? {} : { terminalStatus: state.terminalStatus }),
    ...(state.lastDelivery === undefined ? {} : { lastDelivery: state.lastDelivery }),
  });
}
