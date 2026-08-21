import { Box, Static, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { InteractiveModeResult } from '../interactive/interactive.js';
import { PromptInput } from './PromptInput.js';
import { StatusLine } from './StatusLine.js';
import { TranscriptEntryView, type TranscriptEntry } from './TranscriptEntryView.js';
import { toDisplayText, toSingleLineText } from './displayText.js';
import {
  applyEditorKey,
  commitEditorInput,
  createEditorState,
  replaceEditorText,
  type EditorState,
} from './editorState.js';
import { resolvePromptContentWidth } from './promptLayout.js';
import { resolveSlashCompletions } from './slashCompletion.js';
import type { TuiConversation, TuiLocalCommand } from './tuiConversation.js';
import { useImagePaste, type PendingWork } from './useImagePaste.js';

export interface ConversationUiText {
  thinking: string;
  hint: string;
  placeholder: string;
  /** Shown under the queued lines while the assistant is still answering. */
  queuedHint: string;
  /** `{count}` stands for the queued lines that did not fit on screen. */
  queuedMore: string;
}

/** What the conversation phase asks the surrounding TUI to do next. */
export type ConversationExit =
  | { kind: 'result'; result: InteractiveModeResult }
  | { kind: 'choose_action'; task: string }
  | { kind: 'resume_session' }
  | { kind: 'failed'; error: unknown };

export interface ConversationViewProps {
  readonly ui: ConversationUiText;
  readonly lang: 'en' | 'ja';
  readonly conversation: TuiConversation;
  readonly initialEntries: readonly TranscriptEntry[];
  /** `summarize` turns the first input straight into an instruction. */
  readonly submitMode: 'chat' | 'summarize';
  /** Summarize the seeded input on mount, without waiting for a keystroke. */
  readonly autoSubmit: boolean;
  /**
   * Lines already submitted in this conversation. The view is unmounted and
   * mounted again around every selector, so the recall list is kept by the
   * caller and handed back on the next mount.
   */
  readonly initialHistory: readonly string[];
  /** Provider and model this session calls, shown under the prompt. */
  readonly modelLabel: string;
  /** Called once, with the history to carry into the next mount. */
  readonly onExit: (exit: ConversationExit, history: readonly string[]) => void;
}

const CANCELLED: InteractiveModeResult = { action: 'cancel', task: '' };

/** Queued lines shown above the prompt; the rest are counted in one row. */
const MAX_QUEUE_ROWS = 3;

/**
 * A line that starts with a slash is a command, and a command is never merged
 * with anything else: `/go` means "summarize what came before", not "and also
 * this text".
 */
function isCommandLine(text: string): boolean {
  return text.trimStart().startsWith('/');
}

function transcriptEntry(role: TranscriptEntry['role'], content: string): TranscriptEntry {
  return { role, content: toDisplayText(content) };
}

export function ConversationView({
  ui,
  lang,
  conversation,
  initialEntries,
  submitMode,
  autoSubmit,
  initialHistory,
  modelLabel,
  onExit,
}: ConversationViewProps): ReactElement {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>(
    () => initialEntries.map((entry) => transcriptEntry(entry.role, entry.content)),
  );
  // Ink can deliver several keypresses before React re-renders, so the ref is the
  // authoritative buffer that handlers read and edit; the state is its render mirror.
  const editorRef = useRef<EditorState>({ ...createEditorState(''), history: initialHistory });
  const [editor, setEditorView] = useState<EditorState>(editorRef.current);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [streamingRaw, setStreamingRaw] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  /**
   * Lines submitted while the assistant was still answering. The ref is what the
   * key handlers and the drain read, the state is its render mirror — the same
   * split the editor buffer uses, for the same reason.
   */
  const queueRef = useRef<readonly string[]>([]);
  const [queue, setQueueView] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef<Set<PendingWork>>(new Set());
  /** Set late, because the drain is built out of callbacks defined below it. */
  const drainQueueRef = useRef<() => void>(() => undefined);
  const exitedRef = useRef(false);
  /** Set once this view reported an exit, whether or not it ended the run. */
  const exitReportedRef = useRef(false);
  /** Set when the reported exit ended the run rather than handing the terminal over. */
  const finalExitRef = useRef(false);
  const cancellingRef = useRef(false);

  const { stdout } = useStdout();
  // Resolved once per render: the keys and the box must agree on the row width.
  const contentWidth = resolvePromptContentWidth(stdout?.columns);
  const completions = useMemo(
    () => resolveSlashCompletions(editor.text, lang, conversation.commandAvailability),
    [conversation.commandAvailability, editor.text, lang],
  );
  const streamingPreview = useMemo(() => toDisplayText(streamingRaw), [streamingRaw]);
  // The model name comes from config or `--model`, so it crosses the display
  // boundary like any other outside text before it reaches a fixed-height row.
  const modelRow = useMemo(() => toSingleLineText(modelLabel), [modelLabel]);

  /**
   * Every exit ends this mount, but not always the run: `choose_action` and
   * `resume_session` hand the terminal to a selector and this view is mounted
   * again afterwards, on the same conversation and the same image store.
   */
  const isFinalExit = (next: ConversationExit): boolean =>
    next.kind === 'result' || next.kind === 'failed';

  const exit = useCallback((next: ConversationExit) => {
    if (exitedRef.current) {
      return;
    }
    exitedRef.current = true;
    exitReportedRef.current = true;
    if (isFinalExit(next)) {
      // Sealed synchronously with the settle: a capture that finishes afterwards
      // must not write a file the caller has already cleaned up. A hand-off does
      // not seal — the next mount pastes into this very store.
      conversation.sealImages();
      finalExitRef.current = true;
    }
    onExit(next, editorRef.current.history);
  }, [conversation, onExit]);

  // A teardown started outside this view must stop an in-flight submission from
  // touching state or leaving the provider call running.
  useEffect(() => () => {
    exitedRef.current = true;
    for (const work of pendingRef.current) {
      work.controller.abort();
    }
    // Sealed synchronously with the teardown: a capture that ignores the abort
    // must not write a file after the caller cleaned the store up. An unmount
    // that follows a hand-off is not the end of the run, so it leaves the store
    // open for the mount that comes next.
    if (finalExitRef.current || !exitReportedRef.current) {
      conversation.sealImages();
    }
  }, [conversation]);

  const writeEditor = useCallback((next: EditorState) => {
    editorRef.current = next;
    setEditorView(next);
  }, []);

  const updateEditor = useCallback((next: EditorState) => {
    writeEditor(next);
    setCompletionIndex(0);
  }, [writeEditor]);

  const writeQueue = useCallback((next: readonly string[]) => {
    queueRef.current = next;
    setQueueView(next);
  }, []);

  const trackPendingWork = useCallback((work: PendingWork) => {
    pendingRef.current.add(work);
    void work.completion.finally(() => pendingRef.current.delete(work));
  }, []);

  const runSubmission = useCallback(async (
    text: string,
    controller: AbortController,
  ): Promise<void> => {
    try {
      const submitInput = {
        text,
        abortSignal: controller.signal,
        onAssistantChunk: (chunk: string) => {
          if (exitedRef.current || cancellingRef.current) {
            return;
          }
          setStreamingRaw((streamed) => streamed + chunk);
        },
      };
      const outcome = submitMode === 'summarize'
        ? await conversation.createInstruction(submitInput)
        : await conversation.submit(submitInput);
      if (exitedRef.current || cancellingRef.current) {
        return;
      }
      setStreamingRaw('');
      setIsBusy(false);
      switch (outcome.kind) {
        case 'assistant_response':
          setTranscript((entries) => [...entries, transcriptEntry('assistant', outcome.content)]);
          drainQueueRef.current();
          return;
        case 'error':
          setNotice(toSingleLineText(outcome.message));
          drainQueueRef.current();
          return;
        case 'task_instruction':
          void finishRun({ kind: 'choose_action', task: outcome.task });
          return;
      }
    } catch (error) {
      if (cancellingRef.current) {
        return;
      }
      exit({ kind: 'failed', error });
    }
  }, [conversation, exit, submitMode]);

  const startSubmission = useCallback((text: string) => {
    // The seeded auto-submit carries no note of its own; its user line is already
    // in the initial transcript, so an empty row would just be noise.
    if (text !== '') {
      setTranscript((entries) => [...entries, transcriptEntry('user', text)]);
    }
    updateEditor(commitEditorInput(editorRef.current, text));
    setNotice(null);
    setStreamingRaw('');
    setIsBusy(true);
    const controller = new AbortController();
    trackPendingWork({ controller, completion: runSubmission(text, controller) });
  }, [runSubmission, trackPendingWork, updateEditor]);

  /**
   * Every exit drains the in-flight work first. A clipboard capture writes a
   * temp file the caller deletes on teardown, and its placeholder may be part of
   * the text being handed back, so leaving it running past the exit would either
   * resurrect the file or hand over a placeholder with no file behind it.
   */
  const finishRun = useCallback(async (next: ConversationExit): Promise<void> => {
    cancellingRef.current = true;
    // Drain everything: a submission and a clipboard capture can be in flight at
    // the same time, and each one still owns state the caller cleans up after.
    while (pendingRef.current.size > 0) {
      const draining = [...pendingRef.current];
      for (const work of draining) {
        work.controller.abort();
      }
      await Promise.all(draining.map((work) => work.completion));
      for (const work of draining) {
        pendingRef.current.delete(work);
      }
    }
    exit(next);
  }, [exit]);

  const insertAtCaret = useCallback((text: string): void => {
    updateEditor(applyEditorKey(editorRef.current, { kind: 'insert', text }));
  }, [updateEditor]);

  const { routeInput: routeImagePasteInput, captureClipboard: captureClipboardImage } = useImagePaste({
    sink: conversation,
    lang,
    insertAtCaret,
    setNotice,
    track: trackPendingWork,
    isStopped: () => exitedRef.current || cancellingRef.current,
  });

  const applyLocalCommand = useCallback((command: TuiLocalCommand, text: string) => {
    switch (command.kind) {
      case 'cancel':
        void finishRun({ kind: 'result', result: CANCELLED });
        return;
      case 'execute':
        void finishRun({ kind: 'result', result: { action: 'execute', task: command.task } });
        return;
      case 'choose_action':
        void finishRun({ kind: 'choose_action', task: command.task });
        return;
      case 'resume_session':
        // Consumed here, so the command is committed to the history and leaves
        // the prompt; the next mount starts with an empty draft.
        setTranscript((entries) => [...entries, transcriptEntry('user', text)]);
        updateEditor(commitEditorInput(editorRef.current, text));
        setNotice(null);
        void finishRun({ kind: 'resume_session' });
        return;
      case 'paste_image':
        updateEditor(commitEditorInput(editorRef.current, text));
        captureClipboardImage();
        return;
      case 'notice':
        setTranscript((entries) => [...entries, transcriptEntry('user', text)]);
        updateEditor(commitEditorInput(editorRef.current, text));
        setNotice(toSingleLineText(command.message));
        return;
    }
  }, [captureClipboardImage, exit, finishRun, updateEditor]);

  /** One queued or typed line, sent exactly as if it had just been typed. */
  const submitLine = useCallback((text: string) => {
    const command = conversation.resolveLocalCommand(text);
    if (command) {
      applyLocalCommand(command, text);
      return;
    }
    startSubmission(text);
  }, [applyLocalCommand, conversation, startSubmission]);

  /**
   * Sends what was typed while the assistant was answering.
   *
   * Consecutive plain lines go out as one turn, joined by line breaks: they were
   * written as one thought and the session takes them as one message. A command
   * line is sent on its own, because merging it into a message would strip it of
   * its meaning. Whatever a command leaves behind is dropped with the mount when
   * that command ends the conversation phase.
   */
  const drainQueue = useCallback(() => {
    if (exitedRef.current || cancellingRef.current) {
      return;
    }
    const queued = queueRef.current;
    const [head] = queued;
    if (head === undefined) {
      return;
    }
    if (isCommandLine(head)) {
      writeQueue(queued.slice(1));
      submitLine(head);
      return;
    }
    let end = 0;
    while (end < queued.length) {
      const line = queued[end];
      if (line === undefined || isCommandLine(line)) {
        break;
      }
      end += 1;
    }
    writeQueue(queued.slice(end));
    submitLine(queued.slice(0, end).join('\n'));
  }, [submitLine, writeQueue]);
  drainQueueRef.current = drainQueue;

  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (autoSubmit && !autoSubmittedRef.current) {
      autoSubmittedRef.current = true;
      startSubmission('');
    }
  }, [autoSubmit, startSubmission]);

  useInput((input, key) => {
    if (exitedRef.current) {
      return;
    }
    // Ctrl+D cancels next to Ctrl+C, whatever the draft holds, exactly as the
    // readline editor treats the two (lineEditor.ts).
    if (key.ctrl && (input === 'c' || input === 'd')) {
      // A second interrupt stops waiting on a provider that ignores the abort.
      if (cancellingRef.current) {
        exit({ kind: 'result', result: CANCELLED });
        return;
      }
      void finishRun({ kind: 'result', result: CANCELLED });
      return;
    }
    // Only a teardown stops the keyboard: the draft stays editable while the
    // assistant answers, and what is submitted then joins the queue.
    if (cancellingRef.current) {
      return;
    }

    // A terminal pastes a screenshot as raw OSC 1337 bytes, which must be
    // recognized before any key handling or display sanitization sees them.
    if (routeImagePasteInput(input, key)) {
      return;
    }

    if (completions.length > 0) {
      if (key.downArrow) {
        setCompletionIndex((index) => (index + 1) % completions.length);
        return;
      }
      if (key.upArrow) {
        setCompletionIndex((index) => (index + completions.length - 1) % completions.length);
        return;
      }
      if (key.tab) {
        const selected = completions[completionIndex];
        if (selected) {
          updateEditor(replaceEditorText(editorRef.current, `${selected.command} `));
        }
        return;
      }
    }

    // Shift+Enter and Option+Enter insert a line break; plain Enter submits.
    // Both arrive as CSI-u reports once the kitty protocol is negotiated, and
    // Option+Enter also arrives as ESC CR on terminals without it.
    if (key.return && (key.shift || key.meta)) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'newline' }));
      return;
    }
    if (key.return) {
      const text = editorRef.current.text.trim();
      if (!text) {
        return;
      }
      if (isBusy) {
        // Leaving the conversation must not wait behind the queue.
        const command = conversation.resolveLocalCommand(text);
        if (command?.kind === 'cancel') {
          applyLocalCommand(command, text);
          return;
        }
        updateEditor(commitEditorInput(editorRef.current, text));
        writeQueue([...queueRef.current, text]);
        return;
      }
      submitLine(text);
      return;
    }
    if (key.backspace) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'backspace' }));
      return;
    }
    if (key.delete) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'delete' }));
      return;
    }
    if (key.leftArrow) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'left' }));
      return;
    }
    if (key.rightArrow) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'right' }));
      return;
    }
    // With nothing typed, Up reaches for the queue before the history: what was
    // just queued is the nearest thing the user may want to change.
    if (key.upArrow && editorRef.current.text === '' && queueRef.current.length > 0) {
      const queued = queueRef.current;
      const last = queued[queued.length - 1];
      writeQueue(queued.slice(0, -1));
      if (last !== undefined) {
        updateEditor(replaceEditorText(editorRef.current, last));
      }
      return;
    }
    // Inside a multi-line draft the arrows move between its lines; the history
    // takes over at the first and last line, where there is no line to move to.
    if (key.upArrow) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'up', contentWidth }));
      return;
    }
    if (key.downArrow) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'down', contentWidth }));
      return;
    }
    // Home/End keys, plus their readline equivalents.
    if (key.home || (key.ctrl && input === 'a')) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'home' }));
      return;
    }
    if (key.end || (key.ctrl && input === 'e')) {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'end' }));
      return;
    }
    if (key.ctrl && input === 'k') {
      updateEditor(applyEditorKey(editorRef.current, { kind: 'deleteToLineEnd' }));
      return;
    }
    // Ctrl+V pastes the clipboard image, the same gesture the readline editor
    // offers; the terminal's own text paste never reaches this handler.
    if (key.ctrl && input === 'v') {
      captureClipboardImage();
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) {
      return;
    }
    updateEditor(applyEditorKey(editorRef.current, { kind: 'insert', text: input }));
  });

  return (
    <>
      <Static items={transcript}>
        {(entry, index) => (
          <TranscriptEntryView key={index} entry={entry} />
        )}
      </Static>
      <Box flexDirection="column">
        {queue.length > 0 && (
          <Box flexDirection="column">
            {queue.slice(-MAX_QUEUE_ROWS).map((line, index) => (
              <Text key={index} dimColor wrap="truncate-end">{`❯ ${toSingleLineText(line)}`}</Text>
            ))}
            {queue.length > MAX_QUEUE_ROWS && (
              <Text dimColor wrap="truncate-end">
                {ui.queuedMore.replace('{count}', String(queue.length - MAX_QUEUE_ROWS))}
              </Text>
            )}
            <Text dimColor wrap="truncate-end">{ui.queuedHint}</Text>
          </Box>
        )}
        {/* Both rows always render, so the frame height never changes underneath Ink. */}
        <StatusLine busy={isBusy} label={ui.thinking} streamed={streamingPreview} />
        <Text color="red" wrap="truncate-end">{notice === null ? ' ' : notice}</Text>
        <PromptInput
          text={editor.text}
          cursor={editor.cursor}
          contentWidth={contentWidth}
          placeholder={ui.placeholder}
          hint={ui.hint}
          completions={completions}
          completionIndex={completionIndex}
        />
        {/* One row, always drawn, so the frame height stays constant. */}
        <Text dimColor wrap="truncate-end">{modelRow}</Text>
      </Box>
    </>
  );
}
