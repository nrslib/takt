/**
 * Image-paste wiring shared by every editing view.
 *
 * Both gestures the readline editor offers have to work the same way wherever
 * the user types: Ctrl+V reads the clipboard, and a terminal that pastes a
 * screenshot writes an OSC 1337 sequence which arrives split across key events.
 * Each save is async and writes a temp file the caller deletes on teardown, so
 * every one of them joins the view's pending work.
 */

import type { Key } from 'ink';
import { useCallback, useRef } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import type { PastedImage } from '../interactive/inlineImagePaste.js';
import { toSingleLineText } from './displayText.js';
import {
  consumeImagePasteInput,
  createImagePasteBuffer,
  type ImagePasteBuffer,
} from './imagePasteInput.js';

/** Async work a view must drain before it hands control back. */
export interface PendingWork {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export interface ImagePasteSink {
  pasteClipboardImage(abortSignal: AbortSignal): Promise<string>;
  saveInlineImage(image: PastedImage): Promise<string>;
  /** Refuse further images: the run ended and its temp files are being cleaned up. */
  sealImages(): void;
}

export interface ImagePasteInput {
  readonly sink: ImagePasteSink;
  readonly lang: 'en' | 'ja';
  readonly insertAtCaret: (text: string) => void;
  readonly setNotice: (message: string | null) => void;
  readonly track: (work: PendingWork) => void;
  /** True once the view stopped accepting state changes. */
  readonly isStopped: () => boolean;
}

export interface ImagePasteHandlers {
  /** True when the event belonged to a paste and needs no further key handling. */
  readonly routeInput: (input: string, key: Key) => boolean;
  /** Ctrl+V: read the clipboard image and insert its placeholder. */
  readonly captureClipboard: () => void;
}

export function useImagePaste({
  sink,
  lang,
  insertAtCaret,
  setNotice,
  track,
  isStopped,
}: ImagePasteInput): ImagePasteHandlers {
  const bufferRef = useRef<ImagePasteBuffer>(createImagePasteBuffer());

  const reportFailure = useCallback((error: unknown): void => {
    const cause = error instanceof Error ? error.message : String(error);
    setNotice(toSingleLineText(`${getLabel('tui.errors.imagePasteFailed', lang)} ${cause}`));
  }, [lang, setNotice]);

  const savePlaceholder = useCallback((
    save: (abortSignal: AbortSignal) => Promise<string>,
    /** Bytes that followed the sequence inside the same event. */
    trailing: string,
  ): void => {
    const controller = new AbortController();
    const completion = (async (): Promise<void> => {
      try {
        const placeholder = await save(controller.signal);
        if (isStopped()) {
          return;
        }
        setNotice(null);
        insertAtCaret(`${placeholder}${trailing}`);
      } catch (error) {
        if (isStopped()) {
          return;
        }
        reportFailure(error);
      }
    })();
    track({ controller, completion });
  }, [insertAtCaret, isStopped, reportFailure, setNotice, track]);

  const captureClipboard = useCallback((): void => {
    savePlaceholder((abortSignal) => sink.pasteClipboardImage(abortSignal), '');
  }, [savePlaceholder, sink]);

  const routeInput = useCallback((input: string, key: Key): boolean => {
    // A control or meta chord reports a letter that was never typed, so the
    // buffer is fed nothing and releases whatever it holds before the chord runs.
    const text = key.ctrl || key.meta ? '' : input;
    const read = consumeImagePasteInput(bufferRef.current, text);
    bufferRef.current = read.buffer;

    switch (read.outcome.kind) {
      case 'none':
        return false;
      case 'pending':
        return true;
      case 'image': {
        const { image, rest } = read.outcome;
        savePlaceholder(() => sink.saveInlineImage(image), rest);
        return true;
      }
      case 'passthrough':
        insertAtCaret(read.outcome.text);
        // An event that only ended the hold still needs its own key handling.
        return read.outcome.consumed;
    }
  }, [insertAtCaret, savePlaceholder, sink]);

  return { routeInput, captureClipboard };
}
