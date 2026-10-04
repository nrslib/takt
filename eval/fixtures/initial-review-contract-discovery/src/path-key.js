import { validateName } from './name-schema.js';

export function pathKey(segments) {
  return segments.map(({ name, attempt }) => `${validateName(name)}|${attempt}`).join('|');
}
