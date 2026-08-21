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
import type {
  InteractiveResultSource,
  TuiConversation,
  TuiLocalCommand,
} from './tuiConversation.js';
import { useImagePaste, type PendingWork } from './useImagePaste.js';

export interface ConversationUiText {
  thinking: string;
  hint: string;
  placeholder: string;
  /** Shown under the queued lines while the assistant is still answering. */
  queuedHint: string;
  /** `{count}` stands for the queued lines that did not fit on screen. */
  queuedMore: string;
  /** Appended to the status row while a call can still be interrupted. */
  interruptHint: string;
  /** System line left behind when Esc stops an answer. */
  responseInterrupted: string;
  /** System line left behind when Esc stops `/go`. */
  instructionInterrupted: string;
}

/** What the conversation phase asks the surrounding TUI to do next. */
export type ConversationExit =
  | { kind: 'result'; result: InteractiveModeResult }
  /** `source` travels with the task for the modes that record where it came from. */
  | { kind: 'choose_action'; task: string; source?: InteractiveResultSource }
  | { kind: 'resume_session' }
  /** The caller runs `id` with Ink unmounted, then this view is mounted again. */
  | { kind: 'handoff'; id: string }
  | { kind: 'failed'; error: unknown };

/** What survives a mount: the recall history and the lines still waiting. */
export interface ConversationCarryOver {
  readonly history: readonly string[];
  readonly queue: readonly string[];
}

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
  /**
   * True when the caller carries a decision out and mounts this view again. The
   * image store then outlives the decision, and sealing it here would refuse
   * every paste that follows.
   */
  readonly residentSession: boolean;
  /** Lines still waiting from the mount before this one. */
  readonly initialQueue: readonly string[];
  /** Called once, with what the next mount has to carry on from. */
  readonly onExit: (exit: ConversationExit, carried: ConversationCarryOver) => void;
}

const CANCELLED: InteractiveModeResult = { action: 'cancel', task: '' };

/** Queued lines shown above the prompt; the rest are counted in one row. */
const MAX_QUEUE_ROWS = 3;

/** `/go` asks the session for a task instruction rather than for a reply. */
function isInstructionRequest(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed === '/go' || trimmed.startsWith('/go ');
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
  residentSession,
  initialQueue,
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
  const queueRef = useRef<readonly string[]>(initialQueue);
  const [queue, setQueueView] = useState<readonly string[]>(initialQueue);
  /**
   * The call Esc would stop, and the id that says whose outcome may still be
   * applied: an interrupted call settles later, and by then its answer belongs
   * to a turn the user already walked away from.
   */
  const inFlightRef = useRef<{
    readonly id: number;
    readonly controller: AbortController;
    /** True while the call is building a task instruction rather than a reply. */
    readonly isInstruction: boolean;
  } | null>(null);
  const submissionCountRef = useRef(0);
  /** True from the moment this view decides to hand the terminal to a selector. */
  const [isFinishing, setIsFinishing] = useState(false);
  /** Set by Esc so the completion list closes without touching the draft. */
  const [completionsHidden, setCompletionsHidden] = useState(false);
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
  const allCompletions = useMemo(
    () => resolveSlashCompletions(editor.text, lang, conversation.commandAvailability),
    [conversation.commandAvailability, editor.text, lang],
  );
  const completions = completionsHidden ? [] : allCompletions;
  const streamingPreview = useMemo(() => toDisplayText(streamingRaw), [streamingRaw]);
  // The model name comes from config or `--model`, so it crosses the display
  // boundary like any other outside text before it reaches a fixed-height row.
  const modelRow = useMemo(() => toSingleLineText(modelLabel), [modelLabel]);

  /**
   * Every exit ends this mount, but not always the run: a hand-off gives the
   * terminal to a selector, and in a resident session even a finished decision
   * comes back here once it has been carried out. Only an exit that nothing
   * follows may seal the image store — the mount after it pastes into that very
   * store.
   */
  const isFinalExit = (next: ConversationExit): boolean =>
    next.kind === 'failed' || (next.kind === 'result' && !residentSession);

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
    onExit(next, { history: editorRef.current.history, queue: queueRef.current });
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
    // Editing the draft is what brings a dismissed list back.
    setCompletionsHidden(false);
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
    submissionId: number,
  ): Promise<void> => {
    /** False once this call was interrupted or the view moved on. */
    const isCurrent = (): boolean =>
      !exitedRef.current
      && !cancellingRef.current
      && inFlightRef.current?.id === submissionId;
    try {
      const submitInput = {
        text,
        abortSignal: controller.signal,
        onAssistantChunk: (chunk: string) => {
          if (!isCurrent()) {
            return;
          }
          setStreamingRaw((streamed) => streamed + chunk);
        },
      };
      const outcome = submitMode === 'summarize'
        ? await conversation.createInstruction(submitInput)
        : await conversation.submit(submitInput);
      if (!isCurrent()) {
        // Interrupted: the user is back at the prompt, and this answer is theirs
        // to ask for again.
        return;
      }
      inFlightRef.current = null;
      // Past the interruption check, so an adapter that keeps a transcript of its
      // own records exactly the turns the view accepted.
      outcome.commit?.();
      setStreamingRaw('');
      setIsBusy(false);
      // What the call would have told a terminal it does not own — the provider
      // taking images as paths, for one — belongs above the answer it came with.
      const notices = outcome.notices ?? [];
      if (notices.length > 0) {
        setTranscript((entries) => [
          ...entries,
          ...notices.map((note) => transcriptEntry('system', note)),
        ]);
      }
      switch (outcome.kind) {
        case 'assistant_response':
          setTranscript((entries) => [...entries, transcriptEntry('assistant', outcome.content)]);
          drainQueueRef.current();
          return;
        case 'error':
          // Into the transcript, not the one-line notice: the next send clears
          // that row, and the queue may start the next send immediately.
          setTranscript((entries) => [...entries, transcriptEntry('system', outcome.message)]);
          drainQueueRef.current();
          return;
        case 'task_instruction':
          void finishRun({
            kind: 'choose_action',
            task: outcome.task,
            ...(outcome.source ? { source: outcome.source } : {}),
          });
          return;
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      inFlightRef.current = null;
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
    submissionCountRef.current += 1;
    const submissionId = submissionCountRef.current;
    inFlightRef.current = {
      id: submissionId,
      controller,
      isInstruction: submitMode === 'summarize' || isInstructionRequest(text),
    };
    trackPendingWork({ controller, completion: runSubmission(text, controller, submissionId) });
  }, [runSubmission, submitMode, trackPendingWork, updateEditor]);

  /**
   * Esc while a call is running. The call is aborted, and whatever was typed
   * while it ran goes out as the next turn — stopping an answer is not a reason
   * to hold back the messages the user already sent. With an empty queue the
   * view simply returns to an idle prompt.
   *
   * The partial answer is dropped rather than committed: what is on screen is a
   * one-line tail of a stream, and writing that into the transcript would leave
   * a torn message standing next to the finished ones. The system line below it
   * is what records that the turn was stopped.
   */
  const interruptSubmission = useCallback((): boolean => {
    const inFlight = inFlightRef.current;
    if (inFlight === null) {
      return false;
    }
    inFlightRef.current = null;
    inFlight.controller.abort();
    setStreamingRaw('');
    setIsBusy(false);
    setNotice(null);
    setTranscript((entries) => [
      ...entries,
      transcriptEntry('system', inFlight.isInstruction
        ? ui.instructionInterrupted
        : ui.responseInterrupted),
    ]);
    // Read after the note is recorded, so the transcript reads: interrupted,
    // then the queued line, then the answer to it.
    drainQueueRef.current();
    return true;
  }, [ui.instructionInterrupted, ui.responseInterrupted]);

  /**
   * Every exit drains the in-flight work first. A clipboard capture writes a
   * temp file the caller deletes on teardown, and its placeholder may be part of
   * the text being handed back, so leaving it running past the exit would either
   * resurrect the file or hand over a placeholder with no file behind it.
   */
  const finishRun = useCallback(async (next: ConversationExit): Promise<void> => {
    cancellingRef.current = true;
    // The terminal is about to belong to a selector, so the prompt stops taking
    // keys at the moment the decision is made rather than when the tree goes.
    setIsFinishing(true);
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
        void finishRun({
          kind: 'result',
          result: {
            action: 'execute',
            task: command.task,
            ...(command.source ? { source: command.source } : {}),
          },
        });
        return;
      case 'choose_action':
        void finishRun({
          kind: 'choose_action',
          task: command.task,
          ...(command.source ? { source: command.source } : {}),
        });
        return;
      case 'resume_session':
        // Consumed here, so the command is committed to the history and leaves
        // the prompt; the next mount starts with an empty draft.
        setTranscript((entries) => [...entries, transcriptEntry('user', text)]);
        updateEditor(commitEditorInput(editorRef.current, text));
        setNotice(null);
        void finishRun({ kind: 'resume_session' });
        return;
      case 'handoff':
        setTranscript((entries) => [...entries, transcriptEntry('user', text)]);
        updateEditor(commitEditorInput(editorRef.current, text));
        setNotice(null);
        void finishRun({ kind: 'handoff', id: command.id });
        return;
      // Neither of these ends the mount, so whatever was queued behind them
      // still has to go out.
      case 'paste_image':
        updateEditor(commitEditorInput(editorRef.current, text));
        captureClipboardImage();
        drainQueueRef.current();
        return;
      case 'notice':
        setTranscript((entries) => [...entries, transcriptEntry('user', text)]);
        updateEditor(commitEditorInput(editorRef.current, text));
        setNotice(toSingleLineText(command.message));
        drainQueueRef.current();
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
    if (conversation.isCommandLine(head)) {
      writeQueue(queued.slice(1));
      submitLine(head);
      return;
    }
    let end = 0;
    while (end < queued.length) {
      const line = queued[end];
      if (line === undefined || conversation.isCommandLine(line)) {
        break;
      }
      end += 1;
    }
    writeQueue(queued.slice(end));
    submitLine(queued.slice(0, end).join('\n'));
  }, [conversation, submitLine, writeQueue]);
  drainQueueRef.current = drainQueue;

  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (autoSubmit && !autoSubmittedRef.current) {
      autoSubmittedRef.current = true;
      startSubmission('');
    }
  }, [autoSubmit, startSubmission]);

  // Lines carried over from the mount before this one were already submitted by
  // the user, so this mount sends them rather than waiting for another key.
  const carriedQueueRef = useRef(false);
  useEffect(() => {
    if (carriedQueueRef.current || autoSubmit || queueRef.current.length === 0) {
      return;
    }
    carriedQueueRef.current = true;
    drainQueueRef.current();
  }, [autoSubmit]);

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

    if (key.escape) {
      // An open completion list is what Esc closes first; only then does Esc
      // reach the call that is running.
      if (completions.length > 0) {
        setCompletionsHidden(true);
        return;
      }
      interruptSubmission();
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
      // Read from the ref, not the rendered flag: two Enters can arrive before
      // React re-renders, and the second must still see the call the first one
      // started.
      if (inFlightRef.current !== null) {
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
        <StatusLine
          busy={isBusy}
          label={`${ui.thinking} ${ui.interruptHint}`}
          streamed={streamingPreview}
        />
        <Text color="red" wrap="truncate-end">{notice === null ? ' ' : notice}</Text>
        <PromptInput
          text={editor.text}
          cursor={editor.cursor}
          contentWidth={contentWidth}
          placeholder={ui.placeholder}
          hint={ui.hint}
          completions={completions}
          completionIndex={completionIndex}
          disabled={isFinishing}
        />
        {/* One row, always drawn, so the frame height stays constant. */}
        <Text dimColor wrap="truncate-end">{modelRow}</Text>
      </Box>
    </>
  );
}
