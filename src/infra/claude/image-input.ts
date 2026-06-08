import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { ProviderImageAttachment } from '../providers/types.js';
import { formatImageAttachmentPathReference } from '../providers/imageAttachmentPrompt.js';

type ClaudeImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function inferMediaType(filePath: string): ClaudeImageMediaType {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.png':
    default:
      return 'image/png';
  }
}

async function readImageAttachment(attachment: ProviderImageAttachment): Promise<Buffer> {
  try {
    return await readFile(attachment.path);
  } catch (error) {
    throw new Error(`Failed to read image attachment at ${attachment.path}`, { cause: error });
  }
}

async function buildAttachmentContentBlocks(attachment: ProviderImageAttachment): Promise<ContentBlockParam[]> {
  const data = await readImageAttachment(attachment);
  return [
    { type: 'text', text: formatImageAttachmentPathReference(attachment) },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: inferMediaType(attachment.path),
        data: data.toString('base64'),
      },
    },
  ];
}

async function buildContentBlocks(
  prompt: string,
  imageAttachments: readonly ProviderImageAttachment[],
): Promise<ContentBlockParam[]> {
  const attachmentBlocks = await Promise.all(imageAttachments.map(buildAttachmentContentBlocks));
  return [
    { type: 'text', text: prompt },
    ...attachmentBlocks.flat(),
  ];
}

async function* createClaudeUserMessageStream(
  prompt: string,
  imageAttachments: readonly ProviderImageAttachment[],
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: await buildContentBlocks(prompt, imageAttachments),
    },
    parent_tool_use_id: null,
  };
}

export function buildClaudePromptInput(
  prompt: string,
  imageAttachments: readonly ProviderImageAttachment[] | undefined,
): string | AsyncIterable<SDKUserMessage> {
  if (!imageAttachments || imageAttachments.length === 0) {
    return prompt;
  }
  return createClaudeUserMessageStream(prompt, imageAttachments);
}
