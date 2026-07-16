import type { ContentBlock } from '@agentclientprotocol/sdk';

export function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'resource_link':
          return [
            `Resource: ${block.name}`,
            `URI: ${block.uri}`,
            block.description ? `Description: ${block.description}` : undefined,
            block.mimeType ? `MIME type: ${block.mimeType}` : undefined,
          ].filter((line): line is string => line !== undefined).join('\n');
        case 'image':
        case 'audio':
        case 'resource':
          throw new Error(`Unsupported ACP prompt content block: ${block.type}`);
      }
    })
    .join('\n')
    .trim();
}
