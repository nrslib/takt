import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveReferencedImageAttachments,
  validateStoredImageAttachment,
} from '../shared/utils/imageAttachmentReferences.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempImage(fileName: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-image-ref-test-'));
  tempRoots.add(root);
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, Buffer.from('image-bytes'));
  return filePath;
}

describe('resolveReferencedImageAttachments', () => {
  it('should normalize referenced stored attachments to provider file references', () => {
    const imagePath = createTempImage('image-1.png');

    const result = resolveReferencedImageAttachments('Use [Image #1].', [{
      placeholder: '[Image #1]',
      tempPath: imagePath,
      fileName: 'image-1.png',
    }]);

    expect(result).toEqual([{ placeholder: '[Image #1]', path: imagePath }]);
  });

  it('should resolve multiple referenced attachments once in prompt order', () => {
    const firstImagePath = createTempImage('image-1.png');
    const secondImagePath = createTempImage('image-2.webp');

    const result = resolveReferencedImageAttachments('Use [Image #2], then [Image #1], then [Image #2].', [
      {
        placeholder: '[Image #1]',
        tempPath: firstImagePath,
        fileName: 'image-1.png',
      },
      {
        placeholder: '[Image #2]',
        tempPath: secondImagePath,
        fileName: 'image-2.webp',
      },
    ]);

    expect(result).toEqual([
      { placeholder: '[Image #2]', path: secondImagePath },
      { placeholder: '[Image #1]', path: firstImagePath },
    ]);
  });

  it('should leave unstored image placeholder text unresolved', () => {
    const result = resolveReferencedImageAttachments('Use [Image #2].', [{
      placeholder: '[Image #1]',
      tempPath: createTempImage('image-1.png'),
      fileName: 'image-1.png',
    }]);

    expect(result).toEqual([]);
  });

  it('should ignore invalid unreferenced attachments when resolving valid referenced attachments', () => {
    const imagePath = createTempImage('image-1.png');

    const result = resolveReferencedImageAttachments('Use [Image #1].', [
      {
        placeholder: '[Image #1]',
        tempPath: imagePath,
        fileName: 'image-1.png',
      },
      {
        placeholder: '[Image #2]',
        tempPath: '',
        fileName: 'note.txt',
      },
    ]);

    expect(result).toEqual([{ placeholder: '[Image #1]', path: imagePath }]);
  });

  it('should reject duplicate placeholders even when the duplicated attachment is unreferenced', () => {
    const imagePath = createTempImage('image-1.png');

    expect(() => resolveReferencedImageAttachments('Use [Image #1].', [
      {
        placeholder: '[Image #1]',
        tempPath: imagePath,
        fileName: 'image-1.png',
      },
      {
        placeholder: '[Image #2]',
        tempPath: '',
        fileName: 'note.txt',
      },
      {
        placeholder: '[Image #2]',
        tempPath: '',
        fileName: 'note.txt',
      },
    ])).toThrow('Duplicate image attachment placeholder: [Image #2]');
  });

});

describe('validateStoredImageAttachment', () => {
  it('should reject missing required attachment fields', () => {
    expect(() => validateStoredImageAttachment({
      placeholder: '',
      tempPath: createTempImage('image-1.png'),
      fileName: 'image-1.png',
    })).toThrow('Image attachment placeholder is required.');
  });

  it('should reject non-image attachment file names', () => {
    expect(() => validateStoredImageAttachment({
      placeholder: '[Image #1]',
      tempPath: createTempImage('image-1.png'),
      fileName: 'note.txt',
    })).toThrow('Unsupported image attachment file extension: note.txt');
  });
});
