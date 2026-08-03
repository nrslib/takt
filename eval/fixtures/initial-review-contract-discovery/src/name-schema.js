export function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
  return name;
}
