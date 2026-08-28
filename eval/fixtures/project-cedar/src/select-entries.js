export function selectEntries(selection, input) {
  const ids = input.entries
    .filter((entry) => input.tags.includes(entry.tag))
    .map((entry) => entry.id);
  return {
    ids,
    role: selection.role,
    instruction: selection.instruction,
  };
}
