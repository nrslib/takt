import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { PromptInput } from '../tui/PromptInput.js';
import { TranscriptView, type TranscriptEntry } from '../tui/TranscriptEntryView.js';
import { StatusLine } from '../tui/StatusLine.js';
import { applyEditorKey, commitEditorInput, createEditorState } from '../tui/editorState.js';
import { resolveEditorKey } from '../tui/editorKeys.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../tui/terminalColors.js';
import { toDisplayText } from '../tui/displayText.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { ManagerConversationSession, PendingManagerSummary } from './conversationSession.js';
import { readManagerDisplayEvents } from './savedEvents.js';

export function ManagerView({ cwd, lang, session, initialDiagnostics, onExit }: {
  cwd: string; lang: 'en' | 'ja'; session: ManagerConversationSession; onExit: () => void;
  initialDiagnostics: readonly string[];
}): ReactElement {
  const [editor, setEditor] = useState(() => createEditorState(''));
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => initialDiagnostics.map((content) => ({
    role: 'assistant', content: toDisplayText(content),
  })));
  const [pending, setPending] = useState<PendingManagerSummary | null>(null);
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const registering = useRef(false);
  const selected = useRef(false);
  const mounted = useRef(true);
  const displayed = useRef(new Set<string>());
  const { stdout } = useStdout();
  const contentWidth = Math.max(1, (stdout.columns ?? 80) - 6);
  const ja = lang === 'ja';
  useEffect(() => {
    mounted.current = true;
    void refreshEvents();
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  const append = (content: string): void => {
    if (mounted.current) setEntries((previous) => [...previous, { role: 'assistant', content: toDisplayText(content) }]);
  };
  const refreshEvents = async (): Promise<void> => {
    try {
      const { events, diagnostics } = await readManagerDisplayEvents(cwd);
      for (const event of events) {
        if (displayed.current.has(event.id) || !mounted.current) continue;
        displayed.current.add(event.id);
        append(event.message);
      }
      for (const diagnostic of diagnostics) append(diagnostic);
    } catch (error) { append(getErrorMessage(error)); }
  };
  const resetChoice = (): void => { selected.current = false; setApprove(false); };
  const submit = async (text: string): Promise<void> => {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setPending(null);
    resetChoice();
    setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(text) }]);
    try {
      await refreshEvents();
      const result = await session.handleUserMessage({ text, abortSignal: controller.signal });
      if (active.current !== controller || !mounted.current) return;
      if (result.kind !== 'goal_registered') append(result.message);
      setPending(session.getPendingSummary());
    } catch (error) {
      append(getErrorMessage(error));
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const register = async (revision: number): Promise<void> => {
    registering.current = true;
    setBusy(true);
    setPending(null);
    resetChoice();
    try {
      const result = await session.approveSummary(revision);
      append(result.kind === 'goal_registered'
        ? `${ja ? 'ゴール登録完了' : 'Goal registered'}: ${result.goal.id}\n${result.goal.branch}`
        : result.message);
    } catch (error) {
      append(getErrorMessage(error));
    } finally {
      registering.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useInput((input, key) => {
    if (registering.current) return;
    if (key.ctrl && input === 'c') {
      active.current?.abort();
      onExit();
      return;
    }
    if (active.current !== null) {
      if (key.escape) {
        active.current.abort();
        active.current = null;
        setPending(null);
        setBusy(false);
      }
      return;
    }
    if (pending !== null) {
      if (key.upArrow || key.downArrow) {
        selected.current = key.upArrow;
        setApprove(selected.current);
        return;
      }
      if (key.return) {
        if (selected.current) void register(pending.revision);
        else { session.dismissSummary(pending.revision); setPending(null); resetChoice(); }
        return;
      }
      if (key.escape) { session.dismissSummary(pending.revision); setPending(null); resetChoice(); return; }
      // Typing resumes conversation and leaves the summary unavailable to UI approval.
      session.dismissSummary(pending.revision);
      setPending(null);
      resetChoice();
    }
    if (key.return) {
      if (key.shift || key.meta) {
        setEditor((previous) => applyEditorKey(previous, { kind: 'newline' }));
      } else if (editor.text.trim() !== '') {
        setEditor(commitEditorInput(editor, editor.text));
        void submit(editor.text);
      }
      return;
    }
    const editKey = resolveEditorKey(input, key, contentWidth);
    if (editKey !== null) setEditor((previous) => applyEditorKey(previous, editKey));
  });
  return (
    <Box flexDirection="column">
      <Text bold>{`manager — ${ja ? '実験的機能' : 'Experimental'}`}</Text>
      <Text>{toDisplayText(cwd)}</Text>
      <TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} />
      {pending !== null && (
        <Box borderStyle="round" flexDirection="column">
          <Text bold>{ja ? '登録する要約' : 'Summary to register'}</Text>
          <Text>{toDisplayText(pending.summary.objective)}</Text>
          <Text>{`${ja ? '範囲外' : 'Out of scope'}: ${toDisplayText(JSON.stringify(pending.summary.outOfScope))}`}</Text>
          <Text>{`${ja ? '受け入れ条件' : 'Acceptance criteria'}: ${toDisplayText(JSON.stringify(pending.summary.acceptanceCriteria))}`}</Text>
          {pending.summary.startBranch !== undefined && <Text>{`startBranch: ${toDisplayText(pending.summary.startBranch)}`}</Text>}
          {pending.summary.integrationBranch !== undefined && <Text>{`integrationBranch: ${toDisplayText(pending.summary.integrationBranch)}`}</Text>}
          <Text inverse={approve}>{ja ? '登録を承認' : 'Approve registration'}</Text>
          <Text inverse={!approve}>{ja ? '会話を続ける' : 'Continue conversation'}</Text>
          <Text dimColor>{ja ? '↑ 承認 / ↓ 続行 / Enter 決定' : '↑ Approve / ↓ Continue / Enter Select'}</Text>
        </Box>
      )}
      <StatusLine busy={busy} label={ja ? '処理中' : 'Working'} streamed="" />
      <PromptInput text={editor.text} cursor={editor.cursor} contentWidth={contentWidth}
        placeholder={ja ? 'ゴールを相談してください' : 'Discuss your goal'}
        hint="Enter: send / Shift+Enter: newline / Esc: interrupt / Ctrl+C: exit"
        completions={[]} completionIndex={0} disabled={busy || pending !== null} />
    </Box>
  );
}
