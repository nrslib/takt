export function displayTitle(title) {
  return title.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
