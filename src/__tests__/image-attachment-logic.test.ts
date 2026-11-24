import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createImageAttachmentCollection } from '../shared/utils/imageAttachmentStore.js';
import { selectReferencedImageAttachments } from '../shared/utils/imageAttachmentSelection.js';
import { MAX_INLINE_IMAGE_BYTES, validatePastedImage } from '../features/interactive/inlineImagePaste.js';

const options = { tmpRoot: '/managed/images', sessionId: 'conversation' };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('shared image attachment logic without filesystem access', () => {
  it.each([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']])(
    'uses the existing filename and placeholder rules for %s', async (mimeType, extension) => {
      const write = vi.fn(); const images = createImageAttachmentCollection(options, write);
      const saved = await images.saveImage(png, mimeType);
      expect(saved).toEqual({ placeholder: '[Image #1]', fileName: `image-1.${extension}`,
        tempPath: join(options.tmpRoot, options.sessionId, 'attachments', `image-1.${extension}`) });
      expect(write).toHaveBeenCalledExactlyOnceWith(saved, png);
      expect(images.listAttachments()).toEqual([saved]);
    });

  it('continues after both restored image numbers and the retained last index', async () => {
    const original = { placeholder: '[Image #5]', fileName: 'image-7.png', tempPath: '/existing/image-7.png' };
    const images = createImageAttachmentCollection({ ...options, initialAttachments: [original], initialAttachmentIndex: 9 }, vi.fn());
    const saved = await images.saveImage(png, 'image/png');
    expect(saved.placeholder).toBe('[Image #10]');
    expect(saved.fileName).toBe('image-10.png');
    expect(images.listAttachments()).toEqual([original, saved]);
  });

  it('publishes a reference only after its asynchronous writer completes', async () => {
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    const images = createImageAttachmentCollection(options, () => writing);
    const saved = images.saveImage(png, 'image/png');
    expect(images.listAttachments()).toEqual([]);
    finish();
    expect(images.listAttachments()).toEqual([]);
    const completed = await saved;
    expect(images.listAttachments()).toEqual([completed]);
  });

  it('does not publish a failed write and allows a later save', async () => {
    const failure = new Error('image storage failed');
    const write = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const images = createImageAttachmentCollection(options, write);
    await expect(images.saveImage(png, 'image/png')).rejects.toBe(failure);
    expect(images.listAttachments()).toEqual([]);
    const next = await images.saveImage(png, 'image/png');
    expect(images.listAttachments()).toEqual([next]);
  });

  it('seals the collection without deleting its existing references or invoking a new write', async () => {
    const write = vi.fn(); const images = createImageAttachmentCollection(options, write);
    const saved = await images.saveImage(png, 'image/png'); images.seal();
    await expect(images.saveImage(png, 'image/png')).rejects.toThrow();
    expect(images.listAttachments()).toEqual([saved]); expect(write).toHaveBeenCalledOnce();
  });

  it('selects only referenced images, once each, in textual reference order', () => {
    const images = [1, 2, 3].map((n) => ({ placeholder: `[Image #${n}]`, fileName: `image-${n}.png`, tempPath: `/managed/image-${n}.png` }));
    expect(selectReferencedImageAttachments('[Image #2] [Image #1] [Image #2] [Image #9]', images)).toEqual([
      { placeholder: '[Image #2]', path: images[1]!.tempPath }, { placeholder: '[Image #1]', path: images[0]!.tempPath },
    ]);
  });

  it('rejects duplicate placeholders rather than selecting the wrong image', () => {
    const image = { placeholder: '[Image #1]', fileName: 'image-1.png', tempPath: '/managed/image-1.png' };
    expect(() => selectReferencedImageAttachments('[Image #1]', [image, { ...image, tempPath: '/different/image.png' }])).toThrow();
  });

  it('validates pasted bytes with the existing format and byte limit rules', () => {
    expect(validatePastedImage(png, 'image.png')).toEqual({ data: png, mimeType: 'image/png' });
    expect(() => validatePastedImage(Buffer.from('text'), 'image.png')).toThrow();
    expect(() => validatePastedImage(png, 'image.jpg')).toThrow();
    expect(() => validatePastedImage(Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1))).toThrow();
  });
});
