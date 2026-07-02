import type { ProviderImageAttachment } from './types.js';

function formatImageAttachmentPathReference(attachment: ProviderImageAttachment): string {
  return `${attachment.placeholder} path: \`${attachment.path}\``;
}

export function expandImageAttachmentPlaceholders(
  prompt: string,
  imageAttachments: readonly ProviderImageAttachment[] | undefined,
): string {
  if (!imageAttachments || imageAttachments.length === 0) {
    return prompt;
  }

  const expanded = imageAttachments.reduce((currentPrompt, attachment) => {
    if (!prompt.includes(attachment.placeholder)) {
      return currentPrompt;
    }

    return currentPrompt
      .split(attachment.placeholder)
      .join(`${attachment.placeholder} (\`${attachment.path}\`)`);
  }, prompt);
  const missingReferences = imageAttachments
    .filter((attachment) => !prompt.includes(attachment.placeholder))
    .map((attachment) => formatImageAttachmentPathReference(attachment));

  if (missingReferences.length === 0) {
    return expanded;
  }

  const appendedReferences = missingReferences.join('\n');
  return expanded.length > 0
    ? `${expanded}\n\n${appendedReferences}`
    : appendedReferences;
}
