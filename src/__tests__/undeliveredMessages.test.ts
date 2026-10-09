import { describe, expect, it } from 'vitest';
import { UndeliveredMessages } from '../features/interactive/undeliveredMessages.js';
import { expectUndeliveredPrompt } from './helpers/undelivered.js';

describe('undelivered messages', () => {
  it('should carry repeated interrupts in order and ignore late completion or failure', () => {
    const messages = new UndeliveredMessages();
    const first = messages.begin('A');
    expect(first.prompt).toBe('A');
    first.interrupt();
    const second = messages.begin('B');
    expectUndeliveredPrompt(second.prompt, ['A'], 'B');
    second.interrupt();
    first.complete();
    first.fail();
    first.interrupt();
    const third = messages.begin('C');
    expectUndeliveredPrompt(third.prompt, ['A', 'B'], 'C');
    third.complete();
    second.fail();
    second.interrupt();
    expect(messages.begin('D').prompt).toBe('D');
  });

  it('should restore earlier messages after ordinary failure without adding the failed message', () => {
    const messages = new UndeliveredMessages();
    messages.begin('A').interrupt();
    const failed = messages.begin('B');
    failed.fail();
    failed.interrupt();
    failed.fail();
    expectUndeliveredPrompt(messages.begin('C').prompt, ['A'], 'C');
  });

  it('should keep identical messages as separate utterances', () => {
    const messages = new UndeliveredMessages();
    messages.begin('same').interrupt();
    messages.begin('same').interrupt();
    expectUndeliveredPrompt(messages.begin('continue').prompt, ['same', 'same'], 'continue');
  });

  it.each([
    '修正対象\n```ts\nconst x = 1;\n```',
    '``````text\n```ts\nx\n~~~\ny\n~~~\n未完了',
  ])('should preserve the complete text and keep the current message outside its fence: %s', (text) => {
    const messages = new UndeliveredMessages();
    messages.begin(text).interrupt();
    expectUndeliveredPrompt(messages.begin('続けて').prompt, [text], '続けて');
  });
});
