import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PassthroughView } from '../features/tui/PassthroughView.js';
import type { ImagePasteSink } from '../features/tui/useImagePaste.js';
import type { PastedImage } from '../features/interactive/inlineImagePaste.js';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupImageAttachmentStore,
  createImageAttachmentStore,
} from '../features/interactive/imageAttachments.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ENTER = '\r';
const ALT_ENTER = '\x1b\r';
const SHIFT_ENTER = '\x1b[13;2u';
const CTRL_V = '\x16';
const CTRL_J = '\n';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const CTRL_K = '\x0b';
const ARROW_UP = '\x1b[A';
const ARROW_LEFT = '\x1b[D';

function flushFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

interface ImageStub {
  readonly clipboardCalls: AbortSignal[];
  readonly savedImages: PastedImage[];
  readonly sink: ImagePasteSink;
}

/** Mirrors the store contract: each gesture resolves to the placeholder to insert. */
function createImageStub(placeholder = '[Image #1]'): ImageStub {
  const clipboardCalls: AbortSignal[] = [];
  const savedImages: PastedImage[] = [];
  return {
    clipboardCalls,
    savedImages,
    sink: {
      sealImages: () => undefined,
      pasteClipboardImage(abortSignal: AbortSignal): Promise<string> {
        clipboardCalls.push(abortSignal);
        return Promise.resolve(placeholder);
      },
      saveInlineImage(image: PastedImage): Promise<string> {
        savedImages.push(image);
        return Promise.resolve(placeholder);
      },
    },
  };
}

function renderView(
  onDone: (result: { action: string; task: string }) => void,
  initialText = '',
  images: ImagePasteSink = createImageStub().sink,
) {
  return render(
    <PassthroughView
      intro="Passthrough mode - describe your task."
      hint="Enter: run as-is"
      placeholder="Type a task"
      lang="en"
      images={images}
      initialText={initialText}
      onDone={onDone}
    />,
  );
}

describe('PassthroughView', () => {
  it('should run the typed text verbatim on Enter', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone);
    await flushFrames();

    app.stdin.write('ship it');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(onDone).toHaveBeenCalledWith({ action: 'execute', task: 'ship it' });
    app.unmount();
  });

  it('should insert a newline on Alt+Enter and on Ctrl+J instead of running', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone);
    await flushFrames();

    app.stdin.write('one');
    await flushFrames();
    app.stdin.write(ALT_ENTER);
    await flushFrames();
    app.stdin.write('two');
    await flushFrames();
    // Ink reports Ctrl+J as input '\n' with no key flags set.
    app.stdin.write(CTRL_J);
    await flushFrames();
    app.stdin.write('three');
    await flushFrames();

    expect(onDone).not.toHaveBeenCalled();

    app.stdin.write(ENTER);
    await flushFrames();
    expect(onDone).toHaveBeenCalledWith({ action: 'execute', task: 'one\ntwo\nthree' });

    app.unmount();
  });

  it('should cancel on Ctrl+C and on an empty submission', async () => {
    const onCtrlC = vi.fn();
    const first = renderView(onCtrlC);
    await flushFrames();
    first.stdin.write(CTRL_C);
    await flushFrames();
    expect(onCtrlC).toHaveBeenCalledWith({ action: 'cancel', task: '' });
    first.unmount();

    const onEmpty = vi.fn();
    const second = renderView(onEmpty);
    await flushFrames();
    second.stdin.write(ENTER);
    await flushFrames();
    expect(onEmpty).toHaveBeenCalledWith({ action: 'cancel', task: '' });
    second.unmount();
  });

  it('should attach a clipboard image on Ctrl+V and insert its placeholder', async () => {
    const images = createImageStub();
    const onDone = vi.fn();
    const app = renderView(onDone, '', images.sink);
    await flushFrames();

    app.stdin.write('look at ');
    await flushFrames();
    app.stdin.write(CTRL_V);
    await flushFrames();

    expect(images.clipboardCalls).toHaveLength(1);
    expect(app.lastFrame() ?? '').toContain('look at [Image #1]');

    app.stdin.write(ENTER);
    await flushFrames();
    expect(onDone).toHaveBeenCalledWith({ action: 'execute', task: 'look at [Image #1]' });

    app.unmount();
  });

  it('should keep the seeded line breaks instead of collapsing them', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone, 'first line\nsecond line');
    await flushFrames();

    app.stdin.write(ENTER);
    await flushFrames();

    expect(onDone).toHaveBeenCalledWith({
      action: 'execute',
      task: 'first line\nsecond line',
    });

    app.unmount();
  });

  it('should insert a newline on Shift+Enter', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone);
    await flushFrames();

    app.stdin.write('one');
    await flushFrames();
    app.stdin.write(SHIFT_ENTER);
    await flushFrames();
    app.stdin.write('two');
    await flushFrames();
    expect(onDone).not.toHaveBeenCalled();

    app.stdin.write(ENTER);
    await flushFrames();
    expect(onDone).toHaveBeenCalledWith({ action: 'execute', task: 'one\ntwo' });

    app.unmount();
  });

  it('should include an image that finished saving while Enter was pressed', async () => {
    let releaseSave!: () => void;
    const images: ImagePasteSink = {
      // A capture that honours its abort signal: Enter must let it finish, or
      // the placeholder it was about to insert never reaches the task.
      pasteClipboardImage: (abortSignal: AbortSignal) => new Promise<string>((resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error('capture stopped')));
        releaseSave = () => resolve('[Image #1]');
      }),
      saveInlineImage: () => Promise.resolve('[Image #1]'),
      sealImages: () => undefined,
    };
    const onDone = vi.fn();
    const app = renderView(onDone, '', images);
    await flushFrames();

    app.stdin.write('look at ');
    await flushFrames();
    app.stdin.write(CTRL_V);
    await flushFrames();

    // Enter lands while the save is still running.
    app.stdin.write(ENTER);
    await flushFrames();
    expect(onDone).not.toHaveBeenCalled();

    releaseSave();
    await flushFrames();

    expect(onDone).toHaveBeenCalledWith({ action: 'execute', task: 'look at [Image #1]' });

    app.unmount();
  });

  it('should walk the lines of the draft and cut to the line end', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone, 'first line\nsecond line');
    await flushFrames();

    // No history in this mode, so Up can only move within the draft.
    app.stdin.write(ARROW_UP);
    await flushFrames();
    app.stdin.write('!');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      action: 'execute',
      task: 'first line!\nsecond line',
    });

    app.unmount();
  });

  it('should cut to the end of the line on Ctrl+K', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone, 'keep this cut that');
    await flushFrames();

    for (let index = 0; index < 8; index += 1) {
      app.stdin.write(ARROW_LEFT);
    }
    await flushFrames();
    app.stdin.write(CTRL_K);
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(onDone).toHaveBeenCalledExactlyOnceWith({ action: 'execute', task: 'keep this' });

    app.unmount();
  });

  it('should leave no temp file when an outside unmount races a real save', async () => {
    // A real store, so the assertion is about files on disk rather than a spy.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'takt-pv-attach-'));
    const store = createImageAttachmentStore({ tmpRoot, sessionId: 'session-1' });
    let releaseSave!: () => void;
    const images: ImagePasteSink = {
      // Ignores the abort, exactly like a clipboard read already in flight.
      pasteClipboardImage: () => new Promise<string>((resolve) => {
        releaseSave = () => {
          void store.saveImage(PNG_BYTES, 'image/png')
            .then((attachment) => resolve(attachment.placeholder))
            .catch(() => resolve(''));
        };
      }),
      saveInlineImage: () => Promise.resolve('[Image #1]'),
      sealImages: () => store.seal(),
    };
    const app = renderView(vi.fn(), '', images);
    try {
      await flushFrames();

      app.stdin.write(CTRL_V);
      await flushFrames();

      // The caller tears the tree down and cleans up while the capture runs.
      app.unmount();
      cleanupImageAttachmentStore(store);

      releaseSave();
      await flushFrames();

      expect(store.listAttachments()).toEqual([]);
      expect(existsSync(join(tmpRoot, 'session-1'))).toBe(false);
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      // A failed assertion must not leave the tree holding stdin or the temp
      // directory on disk; unmounting twice is safe.
      app.unmount();
      cleanupImageAttachmentStore(store);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should cancel on Ctrl+D with a draft in the buffer, like the readline editor', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone, 'seeded task');
    await flushFrames();

    app.stdin.write(CTRL_D);
    await flushFrames();

    expect(onDone).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', task: '' });

    app.unmount();
  });

  it('should force the exit on a second Ctrl+C and seal against the late save', async () => {
    let releaseSave!: () => void;
    let captureSignal!: AbortSignal;
    const sealImages = vi.fn();
    const images: ImagePasteSink = {
      pasteClipboardImage: (abortSignal: AbortSignal) => new Promise<string>((resolve) => {
        captureSignal = abortSignal;
        releaseSave = () => resolve('[Image #1]');
      }),
      saveInlineImage: () => Promise.resolve('[Image #1]'),
      sealImages,
    };
    const onDone = vi.fn();
    const app = renderView(onDone, '', images);
    await flushFrames();

    app.stdin.write(CTRL_V);
    await flushFrames();

    // An interrupt is the user ending the capture, so this one is stopped
    // rather than waited out.
    app.stdin.write(CTRL_C);
    await vi.waitFor(() => expect(captureSignal.aborted).toBe(true));
    // The capture ignores the abort, so nothing has settled yet.
    expect(onDone).not.toHaveBeenCalled();

    // The capture ignores the abort, so the second Ctrl+C must not wait for it.
    app.stdin.write(CTRL_C);
    await flushFrames();
    expect(onDone).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', task: '' });
    // Sealed with the settle, so the save that lands next writes nothing.
    expect(sealImages).toHaveBeenCalled();

    releaseSave();
    await flushFrames();
    expect(onDone).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it('should strip control sequences from the seeded command line text', async () => {
    const onDone = vi.fn();
    const app = renderView(onDone, '\x1b[31mseeded\x1b[0m\x1b]52;c;cGF5bG9hZA==\x07 task');
    await flushFrames();

    expect(app.lastFrame() ?? '').not.toContain('\x1b');
    expect(app.lastFrame() ?? '').not.toContain('cGF5bG9hZA==');

    app.stdin.write(ENTER);
    await flushFrames();
    expect(onDone).toHaveBeenCalledWith({ action: 'execute', task: 'seeded task' });

    app.unmount();
  });
});
