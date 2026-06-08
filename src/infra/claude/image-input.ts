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

async function buildContentBlocks(
  prompt: string,
  imageAttachments: readonly ProviderImageAttachment[],
): Promise<ContentBlockParam[]> {
  const content: ContentBlockParam[] = [{ type: 'text', text: prompt }];
  for (const attachment of imageAttachments) {
    const data = await readFile(attachment.path);
    content.push({ type: 'text', text: formatImageAttachmentPathReference(attachment) });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: inferMediaType(attachment.path),
        data: data.toString('base64'),
      },
    });
  }
  return content;
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
