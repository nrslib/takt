import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
  type SensitiveTextStreamRedactor,
} from '../utils/sensitiveText.js';
import { sanitizeTerminalStreamText } from '../utils/text.js';
import { stableToolResultPrefix } from './result.js';

export function normalizeToolResultText(text: string): string {
  return sanitizeTerminalStreamText(stableToolResultPrefix(text));
}

export function toolResultSensitiveValues(source: unknown): ReturnType<typeof createBoundedSensitiveValues> {
  const known = createBoundedSensitiveValues();
  known.collect(source);
  // 本文と秘密値を同じ端末表現で照合し、元の秘密値ソースは変更しない。
  const normalized = [...known.values].map((value) => normalizeToolResultText(value));
  known.collect({ token: normalized });
  return known;
}

export function sanitizeToolResultText(text: string, source: unknown): string {
  return sanitizeSensitiveTextWithKnownValues(normalizeToolResultText(text), toolResultSensitiveValues(source));
}

/** 追記分を端末表現に正規化し、同じ表現にした秘密値で照合して redactor へ渡す。 */
export function writeToolResultText(redactor: SensitiveTextStreamRedactor, appended: string, source: unknown): string {
  return redactor.write(normalizeToolResultText(appended), toolResultSensitiveValues(source));
}
