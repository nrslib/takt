import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { InteractiveModeResult } from '../interactive/interactive.js';
import { PromptInput } from './PromptInput.js';
import { toDisplayText, toSingleLineText } from './displayText.js';
import { resolveEditorKey } from './editorKeys.js';
import {
  applyEditorKey,
  createEditorState,
  type EditorState,
} from './editorState.js';
import { resolvePromptContentWidth } from './promptLayout.js';
import {
  awaitPendingWork,
  drainPendingWork,
  useImagePaste,
  type ImagePasteSink,
  type PendingWork,
} from './useImagePaste.js';

/**
 * Passthrough takes the typed text as the task verbatim. It never contacts a
 * provider, so it deliberately does not build a conversation session — that
 * would demand a configured provider the mode does not need. It still accepts
 * pasted images, exactly as the readline passthrough does.
 */
export interface PassthroughViewProps {
  readonly intro: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly lang: 'en' | 'ja';
  readonly images: ImagePasteSink;
  readonly initialText: string;
  readonly onDone: (result: InteractiveModeResult) => void;
}

const CANCELLED: InteractiveModeResult = { action: 'cancel', task: '' };

export function PassthroughView({
  intro,
  hint,
  placeholder,
  lang,
  images,
  initialText,
  onDone,
}: PassthroughViewProps): ReactElement {
  // Ink can deliver several keypresses before React re-renders, so the ref is the
  // authoritative buffer that handlers read and edit; the state is its render mirror.
  // The seed keeps its line breaks: this is a multi-line editor and the text is
  // taken as the task verbatim.
  const editorRef = useRef<EditorState>(createEditorState(toDisplayText(initialText)));
  const [editor, setEditorView] = useState<EditorState>(editorRef.current);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef<Set<PendingWork>>(new Set());
  const doneRef = useRef(false);
  const finishingRef = useRef(false);
  const { stdout } = useStdout();
  // Resolved once per render: the keys and the box must agree on the row width.
  const contentWidth = resolvePromptContentWidth(stdout?.columns);

  // A teardown started outside this view must stop the saves in flight and seal
  // the store, or a capture that ignores its abort writes a file the caller has
  // already cleaned up.
  useEffect(() => () => {
    doneRef.current = true;
    for (const work of pendingRef.current) {
      work.controller.abort();
    }
    images.sealImages();
  }, [images]);

  const edit = useCallback((next: EditorState) => {
    editorRef.current = next;
    setEditorView(next);
  }, []);

  const insertAtCaret = useCallback((text: string): void => {
    edit(applyEditorKey(editorRef.current, { kind: 'insert', text }));
  }, [edit]);

  const trackPendingWork = useCallback((work: PendingWork) => {
    pendingRef.current.add(work);
    void work.completion.finally(() => pendingRef.current.delete(work));
  }, []);

  const { routeInput, captureClipboard } = useImagePaste({
    sink: images,
    lang,
    insertAtCaret,
    setNotice,
    track: trackPendingWork,
    isStopped: () => doneRef.current,
  });

  const settleOnce = useCallback((result: InteractiveModeResult): void => {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    // Sealed synchronously with the settle: a capture that finishes afterwards
    // must not write a file the caller has already cleaned up.
    images.sealImages();
    onDone(result);
  }, [images, onDone]);

  /**
   * Settles the saves in flight before deciding the task, so a placeholder that
   * lands while the user presses Enter is part of the text, and so the caller's
   * cleanup cannot race a temp file.
   *
   * `settlePending` is what separates the two ways out: Enter lets a capture
   * finish, because its image is meant to be in the text, while an interrupt
   * stops it — the user asked for it to end.
   */
  const finish = useCallback(async (
    settlePending: (pending: Set<PendingWork>) => Promise<void>,
    resolveResult: () => InteractiveModeResult,
  ): Promise<void> => {
    finishingRef.current = true;
    await settlePending(pendingRef.current);
    settleOnce(resolveResult());
  }, [settleOnce]);

  useInput((input, key) => {
    if (doneRef.current) {
      return;
    }
    // Ctrl+D cancels next to Ctrl+C, whatever the draft holds, exactly as the
    // readline editor treats the two (lineEditor.ts).
    if (key.ctrl && (input === 'c' || input === 'd')) {
      // A second interrupt stops waiting on a capture that ignores the abort.
      if (finishingRef.current) {
        settleOnce(CANCELLED);
        return;
      }
      void finish(drainPendingWork, () => CANCELLED);
      return;
    }
    if (finishingRef.current) {
      return;
    }
    if (routeInput(input, key)) {
      return;
    }
    if (key.ctrl && input === 'v') {
      captureClipboard();
      return;
    }
    // Shift+Enter and Option+Enter insert a line break; plain Enter runs the text.
    if (key.return && (key.shift || key.meta)) {
      edit(applyEditorKey(editorRef.current, { kind: 'newline' }));
      return;
    }
    if (key.return) {
      // Read after the wait: a save still running owns part of the text.
      void finish(awaitPendingWork, () => {
        const task = editorRef.current.text.trim();
        return task ? { action: 'execute', task } : CANCELLED;
      });
      return;
    }
    // There is no history in this mode, so the arrows only walk the draft's own
    // rows and do nothing at the first and last of them.
    const editorKey = resolveEditorKey(input, key, contentWidth);
    if (editorKey === null) {
      return;
    }
    edit(applyEditorKey(editorRef.current, editorKey));
  });

  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate-end">{toDisplayText(intro)}</Text>
      {/* Always rendered so the frame height never changes underneath Ink. */}
      <Text color="red" wrap="truncate-end">{notice === null ? ' ' : toSingleLineText(notice)}</Text>
      <PromptInput
        text={editor.text}
        cursor={editor.cursor}
        contentWidth={contentWidth}
        placeholder={placeholder}
        hint={hint}
        completions={[]}
        completionIndex={0}
        disabled={false}
      />
    </Box>
  );
}
