/** Match the CLI resume diagnostic, never assistant or tool output. */
export function isClaudeSessionMissing(sessionId: string | undefined, diagnostic: string | undefined): boolean {
  return sessionId !== undefined && diagnostic !== undefined
    && diagnostic.split('\n').some((line) => line.trim() === `No conversation found with session ID: ${sessionId}`);
}
