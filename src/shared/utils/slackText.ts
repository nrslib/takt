export function escapeSlackMentions(text: string): string {
  // Escape mention introducers while preserving Slack link syntax and visible text.
  return text.replace(/<(?=[@!])/gu, '&lt;');
}
