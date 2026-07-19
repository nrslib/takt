import { describe, expect, it, vi } from 'vitest';
import { emitToolResult } from '../infra/opencode/OpenCodeStreamHandler.js';
import {
  maskOpenCodeToolContentInText,
  sanitizeOpenCodeToolInput,
} from '../infra/opencode/tool-input-sanitizer.js';

describe('OpenCode tool body sanitization', () => {
  it.each([
    ['edit', 'oldString', 'source body'],
    ['edit', 'newString', 'replacement body'],
    ['write', 'content', 'complete file body'],
    ['apply_patch', 'patchText', '*** Begin Patch\nsecret body\n*** End Patch'],
  ])('should apply the shared descriptor contract to %s.%s in inputs and quoted output', (
    tool,
    key,
    body,
  ) => {
    const input = { filePath: 'src/example.ts', [key]: body };
    const sanitizedInput = sanitizeOpenCodeToolInput(input, tool);
    const sanitizedText = maskOpenCodeToolContentInText(`Tool failed:\n${body}`, tool, input);

    expect(sanitizedInput.filePath).toBe('src/example.ts');
    expect(sanitizedInput[key]).toMatchObject({ length: body.length });
    expect((sanitizedInput[key] as { sha256: string }).sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(sanitizedInput)).not.toContain(body);
    expect(sanitizedText).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
    expect(sanitizedText).not.toContain(body);
  });

  it.each([
    ['write', { content: 'write body' }],
    ['apply_patch', { patchText: 'patch body' }],
  ])('should keep %s bodies out of emitted tool_result provider events', (tool, input) => {
    const onStream = vi.fn();
    const body = Object.values(input)[0]!;

    emitToolResult(
      onStream,
      `Tool failed while processing ${body}`,
      true,
      [input],
      'tool-1',
      tool,
      input,
    );

    const serialized = JSON.stringify(onStream.mock.calls);
    expect(serialized).not.toContain(body);
    expect(serialized).toMatch(/sha256/);
  });

  it('should not rewrite an unknown key for an unrelated tool', () => {
    expect(sanitizeOpenCodeToolInput({ content: 'ordinary argument' }, 'custom')).toEqual({
      content: 'ordinary argument',
    });
  });
});
