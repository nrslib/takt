// Shape checks for the persisted task spec format.
export function isTaskSpec(value) {
  return (
    typeof value === 'object'
    && value !== null
    && typeof value.title === 'string'
    && (value.piece === undefined || typeof value.piece === 'string')
  );
}

export function assertTaskSpec(value) {
  if (!isTaskSpec(value)) throw new Error('malformed task spec');
  return value;
}
