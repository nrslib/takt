import {
  REDACTED_VALUE,
  SENSITIVE_TEXT_BOUNDARY_WINDOW,
  hasPotentialSensitiveTextSuffix,
  sanitizeSensitiveText,
} from './sensitive-text.js';
import { collectSensitiveStringValues } from './sensitive-value.js';

const MAX_PENDING_SENSITIVE_TEXT_LENGTH = 10_000;

export interface SensitiveTextStreamRedactor {
  write(text: string, source: unknown): string;
  flush(source: unknown): string;
}

export function createSensitiveTextStreamRedactor(): SensitiveTextStreamRedactor {
  const knownValues = new Set<string>();
  let orderedValues: readonly string[] = [];
  let pending = '';
  let failClosed = false;

  const updateKnownValues = (source: unknown): void => {
    const collected = collectSensitiveStringValues(source);
    failClosed ||= collected.exhausted;
    for (const value of collected.values) {
      knownValues.add(value);
    }
    orderedValues = [...knownValues].sort((a, b) => b.length - a.length);
  };

  const drain = (flush: boolean): string => {
    if (failClosed) {
      const hadPendingText = pending.length > 0;
      pending = '';
      return hadPendingText ? REDACTED_VALUE : '';
    }
    if (!flush && orderedValues.length === 0) {
      if (hasPotentialSensitiveTextSuffix(pending)) {
        return '';
      }
      const sanitized = sanitizeSensitiveText(pending);
      pending = '';
      return sanitized;
    }
    let output = '';
    while (pending.length > 0) {
      const matchedValue = orderedValues.find((value) => pending.startsWith(value));
      if (matchedValue !== undefined) {
        output += REDACTED_VALUE;
        pending = pending.slice(matchedValue.length);
        continue;
      }
      if (!flush && orderedValues.some((value) => value.startsWith(pending))) {
        break;
      }
      if (!flush && pending.length <= SENSITIVE_TEXT_BOUNDARY_WINDOW) {
        break;
      }
      output += pending[0];
      pending = pending.slice(1);
    }
    return sanitizeSensitiveText(output);
  };

  return {
    write(text: string, source: unknown): string {
      updateKnownValues(source);
      pending += text;
      if (
        pending.length > MAX_PENDING_SENSITIVE_TEXT_LENGTH
        && (orderedValues.length > 0 || hasPotentialSensitiveTextSuffix(pending))
      ) {
        failClosed = true;
      }
      return drain(false);
    },
    flush(source: unknown): string {
      updateKnownValues(source);
      return drain(true);
    },
  };
}
