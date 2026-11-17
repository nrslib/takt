function textOf(block: unknown): string | undefined {
  if (block === null || typeof block !== 'object') return undefined;
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string' ? record.text : undefined;
}

/**
 * The answer text so far after one more Claude assistant message. Text before a tool call is working
 * text (progress notes, commentary) and the answer follows the last call, so a message that calls a
 * tool replaces the answer with the text after its last tool_use block, which may be empty. A message
 * without a tool call replaces it only when it has visible text.
 */
export function nextAssistantAnswerText<Previous extends string | undefined>(
  previous: Previous,
  content: unknown,
  separator: string,
): string | Previous {
  const blocks: readonly unknown[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content) ? content : [];
  let answerStart = 0;
  blocks.forEach((block, index) => {
    if (block !== null && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
      answerStart = index + 1;
    }
  });
  const texts = blocks.slice(answerStart).flatMap((block) => textOf(block) ?? []);
  const callsTool = answerStart > 0;
  return callsTool || texts.some((text) => text.trim().length > 0) ? texts.join(separator) : previous;
}
