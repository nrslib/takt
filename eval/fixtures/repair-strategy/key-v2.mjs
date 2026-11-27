export function key(parts) {
  return parts.map(part => part.replaceAll('~', '_').replaceAll('|', '~')).join('|');
}
