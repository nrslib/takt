import { validateName } from './name-schema.js';

export function auditKey(segments) {
  return JSON.stringify(segments.map(({ name, attempt }) => [validateName(name), attempt]));
}
