export type TeamLeaderExecutionTerminalState = 'running' | 'terminating' | 'terminated';

export interface TeamLeaderExecutionPublicationFence {
  readonly state: TeamLeaderExecutionTerminalState;
  assertRunning(operation: string): void;
}

export class TeamLeaderExecutionTerminalGate implements TeamLeaderExecutionPublicationFence {
  private currentState: TeamLeaderExecutionTerminalState = 'running';
  private terminalReason: unknown;

  constructor(
    private readonly onTerminalError: ((error: unknown) => void) | undefined,
  ) {}

  get state(): TeamLeaderExecutionTerminalState {
    return this.currentState;
  }

  latch(error: unknown): unknown {
    if (this.currentState !== 'running') {
      return this.terminalReason;
    }
    this.currentState = 'terminating';
    this.terminalReason = error;
    try {
      this.onTerminalError?.(error);
    } catch (callbackError) {
      this.terminalReason = new AggregateError(
        [error, callbackError],
        'Team leader terminal handling failed',
      );
    } finally {
      this.currentState = 'terminated';
    }
    return this.terminalReason;
  }

  assertRunning(operation: string): void {
    if (this.currentState === 'running') return;
    throw new TeamLeaderExecutionPublicationFencedError(operation, this.terminalReason);
  }
}

export class TeamLeaderExecutionPublicationFencedError extends Error {
  constructor(
    readonly operation: string,
    readonly terminalReason: unknown,
  ) {
    super(`Team leader execution fenced "${operation}" after terminal settlement`, {
      cause: terminalReason,
    });
    this.name = 'TeamLeaderExecutionPublicationFencedError';
  }
}
