export function serializeResume(context) {
  return JSON.stringify({ scope: context.scope });
}

export function restoreResume(serialized) {
  return JSON.parse(serialized);
}
