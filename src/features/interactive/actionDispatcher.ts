/**
 * Shared dispatcher for post-conversation actions.
 */

export interface ConversationActionResult<A extends string> {
  action: A;
  task: string;
}

export type ConversationActionHandler<A extends string, R> = (
  result: ConversationActionResult<A>,
) => Promise<R> | R;

export async function dispatchConversationAction<A extends string, R>(
  result: ConversationActionResult<A>,
  handlers: Record<A, ConversationActionHandler<A, R>>,
): Promise<R> {
  return handlers[result.action](result);
}

