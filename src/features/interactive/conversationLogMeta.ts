export function createSessionLogMeta(sessionId: string | undefined): { hasSession: boolean } {
  return { hasSession: sessionId !== undefined };
}

export function createInputLogMeta(input: string, sessionId: string | undefined): {
  hasInitialInput: boolean;
  initialInputLength: number;
  hasSession: boolean;
} {
  return {
    hasInitialInput: input.length > 0,
    initialInputLength: input.length,
    hasSession: sessionId !== undefined,
  };
}

export function createPlayCommandLogMeta(task: string): { hasTaskText: boolean; taskLength: number } {
  return {
    hasTaskText: task.length > 0,
    taskLength: task.length,
  };
}
