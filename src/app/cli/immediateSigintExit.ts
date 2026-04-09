import { EventEmitter } from 'node:events';

type StdinLike = EventEmitter & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume: () => void;
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

export function installImmediateSigintExit(
  commandName: string | undefined,
  runtime: ProcessLike = process as unknown as ProcessLike,
): void {
  if (!isRunLikeCommand(commandName)) {
    return;
  }

  const stdin = runtime.stdin;
  const hadRawMode = stdin.isRaw === true;
  let enabledRawMode = false;

  if (!stdin.isTTY) {
    return;
  }

  if (typeof stdin.setRawMode === 'function' && !hadRawMode) {
    stdin.setRawMode(true);
    enabledRawMode = true;
  }

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (text.includes('\u0003')) {
      runtime.emit('SIGINT');
    }
  };

  stdin.on('data', onData);
  stdin.resume();

  runtime.once('exit', () => {
    stdin.removeListener('data', onData);
    if (enabledRawMode && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(false);
    }
  });
}
