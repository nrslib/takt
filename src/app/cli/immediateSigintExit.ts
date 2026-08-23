import { EventEmitter } from 'node:events';

type StdinLike = EventEmitter & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => StdinLike;
  on: (event: string, listener: (...args: unknown[]) => void) => StdinLike;
};

type ProcessLike = EventEmitter & {
  pid: number;
  stdin: StdinLike;
  once: (event: string, listener: (...args: unknown[]) => void) => ProcessLike;
};

function isRunLikeCommand(commandName: string | undefined): boolean {
  return commandName === 'run' || commandName === 'watch';
}

const KITTY_KEY_BODY_PATTERN =
  /^(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?(?:;[\d:]+)?u$/;
const MAX_KEY_SEQUENCE_LENGTH = 64;

function isKittyCtrlC(sequence: string): boolean {
  if (!sequence.startsWith('\x1b[')) {
    return false;
  }

  const match = KITTY_KEY_BODY_PATTERN.exec(sequence.slice(2));
  if (!match) {
    return false;
  }

  const codepoint = Number(match[1]);
  const encodedModifiers = match[2] === undefined ? 1 : Number(match[2]);
  const eventType = match[3] === undefined ? 1 : Number(match[3]);
  const modifiers = Math.max(0, encodedModifiers - 1);
  const hasCtrlModifier = modifiers % 8 >= 4;

  if (eventType === 3) {
    return false;
  }

  return codepoint === 3 || (codepoint === 99 && hasCtrlModifier);
}

export function installImmediateSigintExit(
  commandName: string | undefined,
  runtime: ProcessLike = process as unknown as ProcessLike,
): () => void {
  if (!isRunLikeCommand(commandName)) {
    return () => {};
  }

  const stdin = runtime.stdin;
  const hadRawMode = stdin.isRaw === true;
  let enabledRawMode = false;
  let cleanedUp = false;
  let pendingKeySequence = '';

  if (!stdin.isTTY) {
    return () => {};
  }

  if (typeof stdin.setRawMode === 'function' && !hadRawMode) {
    stdin.setRawMode(true);
    enabledRawMode = true;
  }

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    for (const character of text) {
      if (character === '\u0003') {
        pendingKeySequence = '';
        runtime.emit('SIGINT');
        continue;
      }

      if (character === '\x1b') {
        pendingKeySequence = character;
        continue;
      }

      if (pendingKeySequence === '\x1b') {
        pendingKeySequence = character === '[' ? '\x1b[' : '';
        continue;
      }

      if (!pendingKeySequence.startsWith('\x1b[')) {
        continue;
      }

      if (/^[\d:;]$/.test(character) && pendingKeySequence.length < MAX_KEY_SEQUENCE_LENGTH) {
        pendingKeySequence += character;
        continue;
      }

      const sequence = character === 'u' ? `${pendingKeySequence}u` : '';
      pendingKeySequence = '';
      if (sequence !== '' && isKittyCtrlC(sequence)) {
        runtime.emit('SIGINT');
      }
    }
  };

  const onPause = (): void => {
    if (!cleanedUp) {
      stdin.resume();
    }
  };

  stdin.on('data', onData);
  stdin.on('pause', onPause);
  stdin.resume();

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    stdin.removeListener('data', onData);
    stdin.removeListener('pause', onPause);
    stdin.pause();
    if (enabledRawMode && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(false);
    }
  };

  runtime.once('exit', cleanup);
  return cleanup;
}
