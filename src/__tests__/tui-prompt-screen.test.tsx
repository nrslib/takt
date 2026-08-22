/**
 * The exec questions are asked on this screen, and they share their editing
 * keys with the passthrough draft. What is checked here is that the shared
 * mapping reaches this view too, plus the two answers only it gives: Enter
 * hands the text back, Esc and the interrupts hand back nothing.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PromptScreen } from '../features/tui/PromptScreen.js';

const ENTER = '\r';
const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_K = '\x0b';
const ARROW_LEFT = '\x1b[D';
const BACKSPACE = '\x7f';

function flushFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function renderScreen(onDone: (answer: string | null) => void, initialText = '') {
  return render(
    <PromptScreen
      question="Assistant> "
      hint="Enter: answer"
      placeholder="Type an answer"
      initialText={initialText}
      onDone={onDone}
    />,
  );
}

describe('PromptScreen', () => {
  it('should hand back the typed answer on Enter', async () => {
    const onDone = vi.fn();
    const app = renderScreen(onDone);
    await flushFrames();

    app.stdin.write('takt-default');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(onDone).toHaveBeenCalledExactlyOnceWith('takt-default');
    app.unmount();
  });

  it('should hand back nothing on Esc and on Ctrl+C', async () => {
    const onEsc = vi.fn();
    const first = renderScreen(onEsc, 'seeded');
    await flushFrames();
    first.stdin.write(ESC);
    await flushFrames();
    expect(onEsc).toHaveBeenCalledExactlyOnceWith(null);
    first.unmount();

    const onInterrupt = vi.fn();
    const second = renderScreen(onInterrupt, 'seeded');
    await flushFrames();
    second.stdin.write(CTRL_C);
    await flushFrames();
    expect(onInterrupt).toHaveBeenCalledExactlyOnceWith(null);
    second.unmount();
  });

  it('should edit the answer with the keys every buffer shares', async () => {
    const onDone = vi.fn();
    const app = renderScreen(onDone, 'keep this cut that');
    await flushFrames();

    for (let index = 0; index < 8; index += 1) {
      app.stdin.write(ARROW_LEFT);
    }
    await flushFrames();
    app.stdin.write(CTRL_K);
    await flushFrames();
    app.stdin.write(BACKSPACE);
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(onDone).toHaveBeenCalledExactlyOnceWith('keep this');
    app.unmount();
  });
});
