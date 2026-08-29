import { describe, expect, it } from 'vitest';
import { parseDeepSeekHarnessModelReference } from '../infra/deepseek-harness/model-reference.js';

function expectActionableParseError(reference: string, location: RegExp): void {
  let message: string | undefined;
  try {
    parseDeepSeekHarnessModelReference(reference);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toBeDefined();
  if (message === undefined) {
    throw new Error('DeepSeek Harness model reference was accepted unexpectedly');
  }
  if (reference.length > 0) {
    expect(message).toContain(reference);
  } else {
    expect(message).toMatch(/empty|""/iu);
  }
  expect(message).toMatch(location);
}

describe('DeepSeek Harness model references', () => {
  it.each([
    ['openai/gpt-5.4', { provider: 'openai', model: 'gpt-5.4' }],
    ['openai-codex/gpt-5.6-luna', { provider: 'openai-codex', model: 'gpt-5.6-luna' }],
    ['anthropic/claude-sonnet-4-6', { provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    ['my-gateway/org/custom-model', { provider: 'my-gateway', model: 'org/custom-model' }],
    ['my-gateway/ollama/qwen3.5:397b', { provider: 'my-gateway', model: 'ollama/qwen3.5:397b' }],
    ['route//model', { provider: 'route', model: '/model' }],
    ['deepseek-v4-flash', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
  ] as const)('separates the route from the model for %s', (reference, expected) => {
    expect(parseDeepSeekHarnessModelReference(reference)).toEqual(expected);
  });

  it.each([
    [' unknown-route / unknown-model ', { provider: ' unknown-route ', model: ' unknown-model ' }],
    [' deepseek-v4-flash ', { provider: 'deepseek-official', model: ' deepseek-v4-flash ' }],
  ] as const)('preserves surrounding whitespace for %s', (reference, expected) => {
    expect(parseDeepSeekHarnessModelReference(reference)).toEqual(expected);
  });

  it.each([
    '/gpt-5.4',
    'openai/',
    '/',
    '',
    '   ',
    '   /model',
    'route/   ',
  ] as const)('rejects an empty or malformed model reference: %s', (reference) => {
    expectActionableParseError(reference, /model reference|route|model|empty/iu);
  });
});
