/**
 * The exec questions are asked on this screen, and they share their editing
 * keys with the passthrough draft. What is checked here is that the shared
 * mapping reaches this view too, plus the two answers only it gives: Enter
 * hands the text back, Esc and the interrupts hand back nothing.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PromptScreen } from '../features/tui/PromptScreen.js';

const QUESTION = 'Assistant> ';
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_K = '\x0b';
const ARROW_LEFT = '\x1b[D';
const BACKSPACE = '\x7f';

type PromptApp = ReturnType<typeof render>;

/**
 * Ink subscribes to stdin in an effect, so a key written before the question is
 * on screen would go nowhere. Waiting for the frame is the observable form of
 * "this screen is listening".
 */
async function renderScreen(
  onDone: (answer: string | null) => void,
  initialText = '',
): Promise<PromptApp> {
  const app = render(
    <PromptScreen
      question={QUESTION}
      hint="Enter: answer"
      placeholder="Type an answer"
      initialText={initialText}
      onDone={onDone}
    />,
  );
  await vi.waitFor(() => expect(app.lastFrame() ?? '').toContain(QUESTION.trimEnd()));
  return app;
}

describe('PromptScreen', () => {
  it('should hand back the typed answer on Enter', async () => {
    const onDone = vi.fn();
    const app = await renderScreen(onDone);

    app.stdin.write('takt-default');
    await vi.waitFor(() => expect(app.lastFrame() ?? '').toContain('takt-default'));
    app.stdin.write(ENTER);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith('takt-default'));
    app.unmount();
  });

  it('should hand back nothing on Esc and on Ctrl+C', async () => {
    const onEsc = vi.fn();
    const first = await renderScreen(onEsc, 'seeded');
    first.stdin.write(ESC);
    await vi.waitFor(() => expect(onEsc).toHaveBeenCalledExactlyOnceWith(null));
    first.unmount();

    const onInterrupt = vi.fn();
    const second = await renderScreen(onInterrupt, 'seeded');
    second.stdin.write(CTRL_C);
    await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledExactlyOnceWith(null));
    second.unmount();
  });

  it('should edit the answer with the keys every buffer shares', async () => {
    const onDone = vi.fn();
    const app = await renderScreen(onDone, 'keep this cut that');

    // The caret walks back over ' cut that', and Ctrl+K takes the rest of the
    // line with it; Backspace then removes the space it left behind.
    for (let index = 0; index < 8; index += 1) {
      app.stdin.write(ARROW_LEFT);
    }
    app.stdin.write(CTRL_K);
    app.stdin.write(BACKSPACE);
    app.stdin.write(ENTER);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith('keep this'));
    app.unmount();
  });
});
