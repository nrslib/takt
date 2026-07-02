import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandImageAttachmentPlaceholders } from '../infra/providers/imageAttachmentPrompt.js';
import { buildClaudePromptInput } from '../infra/claude/image-input.js';
import { validateProviderImageAttachments } from '../infra/providers/imageAttachments.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempImage(extension = '.png'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-provider-image-test-'));
  tempRoots.add(root);
  const filePath = path.join(root, `image${extension}`);
  fs.writeFileSync(filePath, Buffer.from('image-bytes'));
  return filePath;
}

describe('provider image attachment prompt support', () => {
  it('should expand image placeholders to local image path references', () => {
    const result = expandImageAttachmentPlaceholders('見て [Image #1]', [
      { placeholder: '[Image #1]', path: '/tmp/image-1.png' },
    ]);

    expect(result).toBe('見て [Image #1] (`/tmp/image-1.png`)');
  });

  it('should append image path references when the prompt has no matching placeholders', () => {
    const result = expandImageAttachmentPlaceholders('Summarize the completed run.', [
      { placeholder: '[Image #1]', path: '/tmp/image-1.png' },
    ]);

    expect(result).toBe('Summarize the completed run.\n\n[Image #1] path: `/tmp/image-1.png`');
  });

  it('should preserve expanded placeholders and append only unreferenced image attachments', () => {
    const result = expandImageAttachmentPlaceholders('見て [Image #1]', [
      { placeholder: '[Image #1]', path: '/tmp/image-1.png' },
      { placeholder: '[Image #2]', path: '/tmp/image-2.png' },
    ]);

    expect(result).toBe('見て [Image #1] (`/tmp/image-1.png`)\n\n[Image #2] path: `/tmp/image-2.png`');
  });
});

describe('buildClaudePromptInput', () => {
  it('should return plain text when no image attachments are provided', () => {
    expect(buildClaudePromptInput('prompt', undefined)).toBe('prompt');
  });

  it('should build an SDK user message stream with base64 image blocks', async () => {
    const imagePath = createTempImage('.png');
    const input = buildClaudePromptInput('見て [Image #1]', [
      { placeholder: '[Image #1]', path: imagePath },
    ]);

    expect(typeof input).not.toBe('string');
    const messages = [];
    for await (const message of input as AsyncIterable<unknown>) {
      messages.push(message);
    }

    expect(messages).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '見て [Image #1]' },
            { type: 'text', text: '[Image #1]' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: Buffer.from('image-bytes').toString('base64'),
              },
            },
          ],
        },
        parent_tool_use_id: null,
      },
    ]);
  });

  it('should include the attachment path when reading an image fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-provider-image-missing-test-'));
    tempRoots.add(root);
    const missingPath = path.join(root, 'missing.png');
    const input = buildClaudePromptInput('見て [Image #1]', [
      { placeholder: '[Image #1]', path: missingPath },
    ]);

    await expect(async () => {
      for await (const _message of input as AsyncIterable<unknown>) {
        throw new Error('Expected image read failure before yielding Claude message');
      }
    }).rejects.toThrow(`Failed to read image attachment at ${missingPath}`);
  });
});

describe('validateProviderImageAttachments', () => {
  it('should reject malformed attachment entries before provider SDK conversion', () => {
    expect(() => validateProviderImageAttachments([
      undefined as unknown as { placeholder: string; path: string },
    ])).toThrow('Image attachment must be an object.');
  });

  it('should reject duplicate image placeholders before provider SDK conversion', () => {
    const imagePath = createTempImage('.png');

    expect(() => validateProviderImageAttachments([
      { placeholder: '[Image #1]', path: imagePath },
      { placeholder: '[Image #1]', path: imagePath },
    ])).toThrow('Duplicate image attachment placeholder: [Image #1]');
  });

  it('should reject unsupported image extensions before provider SDK conversion', () => {
    const imagePath = createTempImage('.txt');

    expect(() => validateProviderImageAttachments([
      { placeholder: '[Image #1]', path: imagePath },
    ])).toThrow('Unsupported image attachment file extension: image.txt');
  });

  it('should reject non-regular image attachment files before provider SDK conversion', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-provider-image-dir-test-'));
    tempRoots.add(root);
    const directoryPath = path.join(root, 'image.png');
    fs.mkdirSync(directoryPath);

    expect(() => validateProviderImageAttachments([
      { placeholder: '[Image #1]', path: directoryPath },
    ])).toThrow(`Image attachment source must be a regular file: ${directoryPath}`);
  });
});
