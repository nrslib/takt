import type { ProviderImageAttachment } from './types.js';

export function formatImageAttachmentPathReference(attachment: ProviderImageAttachment): string {
  return `${attachment.placeholder} path: \`${attachment.path}\``;
}

export function expandImageAttachmentPlaceholders(
  prompt: string,
  imageAttachments: readonly ProviderImageAttachment[] | undefined,
): string {
  if (!imageAttachments || imageAttachments.length === 0) {
    return prompt;
  }

  return imageAttachments.reduce((expanded, attachment) =>
    expanded.split(attachment.placeholder).join(`${attachment.placeholder} (\`${attachment.path}\`)`),
  prompt);
}
