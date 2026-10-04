/**
 * Ink strips the ESC that opens an OSC sequence and splits stdin at it, so a
 * real inline-image paste arrives as `"]"` on its own followed by the payload,
 * while the same characters pasted as literal text arrive in one event
 * (measured on Ink 7.1.1 through a PTY). These pin that discrimination down.
 */

import { describe, expect, it } from 'vitest';
import {
  consumeImagePasteInput,
  createImagePasteBuffer,
  type ImagePasteBuffer,
  type ImagePasteOutcome,
} from '../features/tui/imagePasteInput.js';
import { MAX_PENDING_INLINE_IMAGE_CHARS } from '../features/interactive/inlineImagePaste.js';

/** The parser validates the magic bytes, so the fixture is a real PNG header. */
const IMAGE_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload'),
]);
const IMAGE_NAME = Buffer.from('shot.png').toString('base64');
/** What the terminal writes, minus the ESC Ink removes. `size` is the decoded length. */
const IMAGE_PAYLOAD = `1337;File=inline=1;name=${IMAGE_NAME};size=${IMAGE_BYTES.length}:${IMAGE_BYTES.toString('base64')}\x07`;
const OPENER = ']';

function describeOutcome(outcome: ImagePasteOutcome): string {
  switch (outcome.kind) {
    case 'none':
      return 'none';
    case 'pending':
      return 'pending';
    case 'image':
      return `image(${outcome.image.mimeType},rest=${outcome.rest})`;
    case 'passthrough':
      return `passthrough(${outcome.text}${outcome.consumed ? '' : ',key-free'})`;
  }
}

/** Feeds the events in order and reports what each one produced. */
function feed(events: readonly string[]): {
  readonly steps: string[];
  readonly outcomes: ImagePasteOutcome[];
  readonly buffer: ImagePasteBuffer;
} {
  let buffer = createImagePasteBuffer();
  const steps: string[] = [];
  const outcomes: ImagePasteOutcome[] = [];
  for (const event of events) {
    const read = consumeImagePasteInput(buffer, event);
    buffer = read.buffer;
    steps.push(describeOutcome(read.outcome));
    outcomes.push(read.outcome);
  }
  return { steps, outcomes, buffer };
}

describe('inline image paste reassembly', () => {
  it('should read the image from the two events Ink emits for a real paste', () => {
    const { steps, outcomes } = feed([OPENER, IMAGE_PAYLOAD]);

    expect(steps[0]).toBe('pending');
    expect(steps[1]).toBe('image(image/png,rest=)');
    const last = outcomes[1];
    expect(last?.kind === 'image' && last.image.mimeType).toBe('image/png');
    expect(last?.kind === 'image' && last.image.data.equals(IMAGE_BYTES)).toBe(true);
  });

  it('should read an image whose payload is split across several events', () => {
    const half = Math.floor(IMAGE_PAYLOAD.length / 2);
    const { steps } = feed([OPENER, IMAGE_PAYLOAD.slice(0, half), IMAGE_PAYLOAD.slice(half)]);

    expect(steps).toEqual(['pending', 'pending', 'image(image/png,rest=)']);
  });

  it('should surface bytes that followed the sequence in the same event', () => {
    const { outcomes } = feed([OPENER, `${IMAGE_PAYLOAD}tail`]);

    const last = outcomes[1];
    expect(last?.kind === 'image' && last.rest).toBe('tail');
  });

  it('should treat the same characters pasted as literal text as ordinary input', () => {
    // No ESC, so Ink delivers one event — it must not be eaten as a paste.
    const { steps } = feed([`]${IMAGE_PAYLOAD}`]);

    expect(steps).toEqual(['none']);
  });

  it('should give back a lone bracket that turned out to be ordinary text', () => {
    const { steps } = feed([OPENER, 'x']);

    expect(steps).toEqual(['pending', 'passthrough(]x)']);
  });

  it('should give back the held bytes when the next event carries no text', () => {
    const { steps } = feed([OPENER, '']);

    expect(steps).toEqual(['pending', 'passthrough(],key-free)']);
  });

  it.each([
    ['Enter', '\r'],
    ['Ctrl+J', '\n'],
    ['Tab', '\t'],
    ['DEL', '\x7f'],
    ['a C1 control byte', '\u009b'],
    ['a C1 string terminator', '\u009c'],
  ])('should hand %s back to the caller and restore the held opener', (_label, key) => {
    const { steps, outcomes } = feed([OPENER, key]);

    // The opener is typed after all, and the key still needs its own handling.
    expect(steps).toEqual(['pending', 'passthrough(],key-free)']);
    const released = outcomes[1];
    expect(released?.kind === 'passthrough' && released.text).toBe(OPENER);
    expect(released?.kind === 'passthrough' && released.consumed).toBe(false);
  });

  it('should report an OSC 1337 sequence that carries no image as ordinary input', () => {
    const notAnImage = '1337;SetMark\x07';
    const { steps } = feed([OPENER, notAnImage]);

    expect(steps).toEqual(['pending', `passthrough(]${notAnImage})`]);
  });

  it('should give back a sequence whose payload is not a supported image', () => {
    const notAnImage = Buffer.from('plain text, not an image');
    const payload = `1337;File=inline=1;name=${IMAGE_NAME};size=${notAnImage.length}:${notAnImage.toString('base64')}\x07`;
    const { steps, buffer } = feed([OPENER, payload]);

    expect(steps[1]).toBe(`passthrough(]${payload})`);
    expect(buffer.held).toBe('');
  });

  it('should give back a sequence that outgrows the pending limit', () => {
    const oversized = `1337;File=inline=1;size=9:${'A'.repeat(MAX_PENDING_INLINE_IMAGE_CHARS)}`;
    const { steps, buffer } = feed([OPENER, oversized]);

    expect(steps[1]).toBe(`passthrough(]${oversized})`);
    expect(buffer.held).toBe('');
  });

  it('should hold nothing once an image has been read', () => {
    const { buffer } = feed([OPENER, IMAGE_PAYLOAD]);

    expect(buffer.held).toBe('');
  });

  it('should never mutate the buffer it was given', () => {
    const buffer = createImagePasteBuffer();
    const snapshot = { ...buffer };

    const first = consumeImagePasteInput(buffer, OPENER);
    expect(buffer).toEqual(snapshot);

    const held = { ...first.buffer };
    consumeImagePasteInput(first.buffer, IMAGE_PAYLOAD);
    expect(first.buffer).toEqual(held);
  });
});
