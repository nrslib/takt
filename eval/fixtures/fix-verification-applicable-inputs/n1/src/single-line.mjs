export function singleLine(value) {
  return value.replace(/[\r\n\t]/g, ' ').trim();
}
