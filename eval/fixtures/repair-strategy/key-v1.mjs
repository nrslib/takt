export function key(parts) {
  return parts.map(part => part.replaceAll('|', '~')).join('|');
}
