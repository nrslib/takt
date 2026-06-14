const UNAVAILABLE_TOOL_ERROR_PATTERNS = [
  'unavailable tool',
  'invalid tool',
];

const REPEATED_UNAVAILABLE_TOOL_THRESHOLD = 2;

function isUnavailableToolErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return UNAVAILABLE_TOOL_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

export class UnavailableToolLoopDetector {
  private consecutiveUnavailableToolErrors = 0;
  private lastUnavailableToolCallId: string | undefined;

  observe(toolCallId: string, tool: string, message: string): string | undefined {
    if (!isUnavailableToolErrorMessage(message)) {
      this.reset();
      return undefined;
    }

    if (toolCallId === this.lastUnavailableToolCallId) {
      return undefined;
    }

    this.lastUnavailableToolCallId = toolCallId;
    this.consecutiveUnavailableToolErrors += 1;

    if (this.consecutiveUnavailableToolErrors < REPEATED_UNAVAILABLE_TOOL_THRESHOLD) {
      return undefined;
    }

    return `OpenCode unavailable tool loop detected for tool "${tool}": ${message}`;
  }

  reset(): void {
    this.consecutiveUnavailableToolErrors = 0;
    this.lastUnavailableToolCallId = undefined;
  }
}
