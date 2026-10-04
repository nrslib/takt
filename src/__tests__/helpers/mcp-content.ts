export function firstTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    throw new Error('MCP result content is not an array');
  }
  if (content.length === 0) {
    throw new Error('MCP result content is empty');
  }
  const text = Reflect.get(content[0] as object, 'text');
  if (typeof text !== 'string') {
    throw new Error('MCP result does not contain text');
  }
  return text;
}
