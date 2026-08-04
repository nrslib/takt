// Field-level validation for resolved config values.
export function validateProviderName(name) {
  if (typeof name !== 'string') {
    return { ok: false, reason: 'provider must be a string' };
  }
  return { ok: true };
}

export function validateModelName(model) {
  if (model === undefined) return { ok: true };
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, reason: 'model must be a non-empty string' };
  }
  return { ok: true };
}
