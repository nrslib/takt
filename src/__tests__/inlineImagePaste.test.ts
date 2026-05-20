import { describe, expect, it } from 'vitest';
import { OSC_IMAGE_PREFIX, parseInlineImageSequence } from '../features/interactive/inlineImagePaste.js';

const PNG_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function buildInlineImageSequence(params: string[], data: Buffer, terminator: string): string {
  return `${OSC_IMAGE_PREFIX}${params.join(';')}:${data.toString('base64')}${terminator}`;
}

describe('parseInlineImageSequence', () => {
  it('should parse an inline PNG image terminated by ST', () => {
    const input = [
      'before ',
      buildInlineImageSequence(['inline=1', 'name=reference.png', `size=${PNG_DATA.length}`], PNG_DATA, '\x1B\\'),
      ' after',
    ].join('');
    const start = input.indexOf(OSC_IMAGE_PREFIX);

    const result = parseInlineImageSequence(input, start);

    expect(result.status).toBe('image');
    if (result.status !== 'image') {
      throw new Error('Expected parsed inline image.');
    }
    expect(result.image.mimeType).toBe('image/png');
    expect(result.image.data).toEqual(PNG_DATA);
    expect(result.sequenceEnd).toBe(input.indexOf(' after'));
  });

  it('should leave non-inline OSC 1337 file sequences as passthrough', () => {
    const input = `${buildInlineImageSequence(['name=reference.png', `size=${PNG_DATA.length}`], PNG_DATA, '\x07')}after`;

    const result = parseInlineImageSequence(input, 0);

    expect(result).toEqual({
      status: 'passthrough',
      sequenceEnd: input.indexOf('after'),
    });
  });

  it('should reject pasted image data that does not match the declared size', () => {
    const input = buildInlineImageSequence(['inline=1', 'name=reference.png', `size=${PNG_DATA.length + 1}`], PNG_DATA, '\x07');

    expect(() => parseInlineImageSequence(input, 0)).toThrow('Pasted inline image data does not match its declared size.');
  });

  it('should return incomplete for unterminated inline image input within the pending limit', () => {
    const input = `${OSC_IMAGE_PREFIX}inline=1;name=reference.png;size=${PNG_DATA.length}:${PNG_DATA.toString('base64')}`;

    const result = parseInlineImageSequence(input, 0);

    expect(result).toEqual({ status: 'incomplete' });
  });
});
