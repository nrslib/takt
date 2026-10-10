export function workspaceName(input) {
  return input.split('/').at(-1);
}
