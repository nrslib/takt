/**
 * Blocked state handler for workflow execution
 *
 * Handles the case when an agent returns a blocked status,
 * requesting user input to continue.
 */

import type { WorkflowStep, AgentResponse } from '../../models/types.js';
import type { UserInputRequest, WorkflowEngineOptions } from '../types.js';
import { extractBlockedPrompt } from './transitions.js';

/**
 * Result of handling a blocked state.
 */
export interface BlockedHandlerResult {
  /** Whether the workflow should continue */
  shouldContinue: boolean;
  /** The user input provided (if any) */
  userInput?: string;
}

/**
 * Handle blocked status by requesting user input.
 *
 * @param step - The step that is blocked
 * @param response - The blocked response from the agent
 * @param options - Workflow engine options containing callbacks
 * @returns Result indicating whether to continue and any user input
 */
export async function handleBlocked(
  step: WorkflowStep,
  response: AgentResponse,
  options: WorkflowEngineOptions
): Promise<BlockedHandlerResult> {
  // If no user input callback is provided, cannot continue
  if (!options.onUserInput) {
    return { shouldContinue: false };
  }

  // Extract prompt from blocked message
  const prompt = extractBlockedPrompt(response.content);

  // Build the request
  const request: UserInputRequest = {
    step,
    response,
    prompt,
  };

  // Request user input
  const userInput = await options.onUserInput(request);

  // If user cancels (returns null), abort
  if (userInput === null) {
    return { shouldContinue: false };
  }

  return {
    shouldContinue: true,
    userInput,
  };
}
