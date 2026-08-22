import { describe, expect, it } from 'vitest';
import {
  renderFencedJsonBlock,
  renderFencedTextBlock,
} from '../core/workflow/instruction/fenced-block.js';

describe('fenced block rendering', () => {
  it.each([
    ['json', () => renderFencedJsonBlock({ payload: '`````injected' })],
    ['text', () => renderFencedTextBlock('`````injected')],
  ])('should use an outer fence longer than embedded backticks for %s blocks', (_kind, render) => {
    const rendered = render();
    const [opening, ...remainingLines] = rendered.split('\n');
    const closing = remainingLines.at(-1)!;
    const openingFence = /^`+/.exec(opening!)?.[0];

    expect(openingFence).toBeDefined();
    expect(closing).toBe(openingFence);
    expect(openingFence!.length).toBeGreaterThan(5);
  });
});
