import assert from 'node:assert/strict';
import { test } from 'node:test';
import buildPrompt from './task-instruction-gherkin-prompt.mjs';

test('legacy conversation input remains a user message', async () => {
  const prompt = await buildPrompt({ vars: {
    language: 'en',
    conversation: 'Add a notification toggle.',
  } });

  assert.match(prompt, /User: Add a notification toggle\./);
});

test('message history preserves assistant and user roles in order', async () => {
  const prompt = await buildPrompt({ vars: {
    language: 'en',
    messages: [
      { role: 'user', content: 'Add a notification toggle.' },
      { role: 'assistant', content: 'I suggest a manual check.' },
      { role: 'user', content: 'Proceed with the toggle.' },
    ],
  } });

  assert.match(prompt, /User: Add a notification toggle\.[\s\S]*Assistant: I suggest a manual check\.[\s\S]*User: Proceed with the toggle\./);
});

test('invalid message history fails instead of falling back to conversation text', async () => {
  await assert.rejects(
    buildPrompt({ vars: { language: 'en', conversation: 'Fallback', messages: [{ role: 'tool', content: 'Result' }] } }),
    /messages must be a non-empty array/,
  );
});
