export const name = 'takt-system-prompt';
export const inject = ['systemPrompt'];

/** Install the complete TAKT prompt without SDK interpolation or appended default sections. */
export function apply(ctx, config) {
  if (typeof config?.prompt !== 'string') {
    throw new Error('TAKT DeepSeek system prompt configuration is invalid');
  }

  ctx.systemPrompt.section({
    name: 'takt:complete-system-prompt',
    order: 0,
    text: config.prompt,
    complete: true,
    interpolate: false,
  });
}

export default apply;
