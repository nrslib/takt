export function key(parts) {
  return parts.map(part => part.replaceAll('~', '_').replaceAll('|', '~')).join('|');
}
export function encodeKey(parts) {
  return parts.map(part => `${part.length}:${part}`).join('');
}
export const readKey = encodeKey;
export const writeKey = key;
