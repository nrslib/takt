import { sanitizeTerminalStreamText } from './text.js';

/** 制御列の本文は保持しない。未完了の OSC が続いても、受信した各文字を一度だけ読む。 */
export class TerminalTextStream {
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'text';

  write(text: string): string {
    let visible = '';
    for (const char of text) {
      if (this.state === 'text') {
        if (char === '\x1b') this.state = 'escape';
        else visible += char;
      } else if (this.state === 'escape') {
        if (char === '[') this.state = 'csi';
        else if (char === ']') this.state = 'osc';
        else this.state = char === '\x1b' ? 'escape' : 'text';
      } else if (this.state === 'csi') {
        if (char >= '@' && char <= '~') this.state = 'text';
        else if (char === '\x1b') this.state = 'escape';
      } else if (this.state === 'osc') {
        if (char === '\x07') this.state = 'text';
        else if (char === '\x1b') this.state = 'oscEscape';
      } else {
        if (char === '\\' || char === '\x07') this.state = 'text';
        else if (char !== '\x1b') this.state = 'osc';
      }
    }
    return sanitizeTerminalStreamText(visible);
  }
}
