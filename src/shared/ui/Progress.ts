import { info } from './LogManager.js';
import { Spinner } from './Spinner.js';

export type ProgressCompletionMessage<T> = string | ((result: T) => string);

export async function withProgress<T>(
  startMessage: string,
  completionMessage: ProgressCompletionMessage<T>,
  operation: () => Promise<T>,
): Promise<T> {
  const isTTY = process.stdout.isTTY === true;

  if (!isTTY) {
    info(startMessage);
    const result = await operation();
    const message = typeof completionMessage === 'function'
      ? completionMessage(result)
      : completionMessage;
    info(message);
    return result;
  }

  const spinner = new Spinner(startMessage);
  spinner.start();
  try {
    const result = await operation();
    const message = typeof completionMessage === 'function'
      ? completionMessage(result)
      : completionMessage;
    spinner.stop();
    info(message);
    return result;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}
