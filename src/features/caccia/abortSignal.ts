interface SigintRuntime {
  on(event: 'SIGINT', listener: () => void): unknown;
  once(event: 'SIGINT', listener: () => void): unknown;
  removeListener(event: 'SIGINT', listener: () => void): unknown;
}

export interface CacciaAbortScope {
  signal: AbortSignal;
  dispose(): void;
}

export function createCacciaAbortScope(
  externalSignal?: AbortSignal,
  runtime: SigintRuntime = process,
  onRepeatedSigint?: () => void,
): CacciaAbortScope {
  if (externalSignal !== undefined) {
    return { signal: externalSignal, dispose: () => undefined };
  }

  const controller = new AbortController();
  let receivedSigint = false;
  const onSigint = (): void => controller.abort(new Error('Caccia was interrupted'));
  let onRepeatedSigintHandler: (() => void) | undefined;
  if (onRepeatedSigint !== undefined) {
    const handleRepeatedSigint = (): void => {
      if (!receivedSigint) {
        receivedSigint = true;
        return;
      }
      onRepeatedSigint();
      runtime.removeListener('SIGINT', handleRepeatedSigint);
    };
    onRepeatedSigintHandler = handleRepeatedSigint;
  }
  runtime.once('SIGINT', onSigint);
  if (onRepeatedSigintHandler !== undefined) {
    runtime.on('SIGINT', onRepeatedSigintHandler);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      runtime.removeListener('SIGINT', onSigint);
      if (onRepeatedSigintHandler !== undefined) {
        runtime.removeListener('SIGINT', onRepeatedSigintHandler);
      }
    },
  };
}
