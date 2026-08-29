import { DEEPSEEK_HARNESS_DEFAULT_PROVIDER } from './constants.js';

export interface DeepSeekHarnessModelReference {
  provider: string;
  model: string;
}

function invalidModelReference(reference: string, reason: string): Error {
  return new Error(`Invalid DeepSeek Harness model reference ${JSON.stringify(reference)}: ${reason}`);
}

export function parseDeepSeekHarnessModelReference(
  reference: string,
): DeepSeekHarnessModelReference {
  if (reference.trim().length === 0) {
    throw invalidModelReference(reference, 'model reference must not be empty');
  }

  const separatorIndex = reference.indexOf('/');
  const rawProvider = separatorIndex === -1
    ? DEEPSEEK_HARNESS_DEFAULT_PROVIDER
    : reference.slice(0, separatorIndex);
  const rawModel = separatorIndex === -1
    ? reference
    : reference.slice(separatorIndex + 1);

  if (rawProvider.trim().length === 0) {
    throw invalidModelReference(reference, 'provider route must not be empty');
  }
  if (rawModel.trim().length === 0) {
    throw invalidModelReference(reference, 'model must not be empty');
  }

  return { provider: rawProvider, model: rawModel };
}
