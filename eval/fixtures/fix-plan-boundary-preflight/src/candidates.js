export function encodeJsonBase64(id) {
  return Buffer.from(JSON.stringify([id.namespace, id.sequence])).toString('base64');
}

export function encodeFixedWidth(id) {
  return [id.namespace, id.sequence]
    .map((value) => value.toString(16).padStart(4, '0'))
    .join('');
}
