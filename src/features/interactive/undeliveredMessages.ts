import { formatLiteralBlock } from './promptSections.js';

interface UndeliveredMessageTurn {
  readonly prompt: string;
  readonly interrupted: boolean;
  interrupt(): void;
  complete(): void;
  fail(): void;
}

export class UndeliveredMessages {
  private pending: string[] = [];

  begin(message: string): UndeliveredMessageTurn {
    const quoted = this.pending;
    this.pending = [];
    let state: 'active' | 'interrupted' | 'completed' | 'failed' = 'active';
    const prompt = quoted.length === 0 ? message : [
      'The following user messages were sent but their responses were interrupted before an answer returned; treat them together with the current message as the user’s own instructions and answer them.',
      formatLiteralBlock(quoted.map((text) => `User: ${text}`).join('\n')),
      message,
    ].join('\n\n');

    return {
      prompt,
      get interrupted(): boolean {
        return state === 'interrupted';
      },
      interrupt: (): void => {
        if (state !== 'active') {
          return;
        }
        state = 'interrupted';
        this.pending = [...quoted, message, ...this.pending];
      },
      complete: (): void => {
        if (state === 'active') {
          state = 'completed';
        }
      },
      fail: (): void => {
        if (state !== 'active') {
          return;
        }
        state = 'failed';
        this.pending = [...quoted, ...this.pending];
      },
    };
  }
}
