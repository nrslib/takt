import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { PromptInput } from '../tui/PromptInput.js';
import { TranscriptView, type TranscriptEntry } from '../tui/TranscriptEntryView.js';
import { StatusLine } from '../tui/StatusLine.js';
import { applyEditorKey, commitEditorInput, createEditorState } from '../tui/editorState.js';
import { resolveEditorKey } from '../tui/editorKeys.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../tui/terminalColors.js';
import { toDisplayText } from '../tui/displayText.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import type { ManagerConversationSession, PendingManagerSummary } from './conversationSession.js';
import { readManagerDisplayEvents } from './savedEvents.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';

type PendingQuestion = { goalId: string; objective: string; question: GoalQuestion };

function toDisplayBullet(item: string): string {
  return `- ${toDisplayText(item).replace(/\n/g, '\n  ')}`;
}

export function ManagerView({ cwd, lang, session, initialDiagnostics, onExit, startup }: {
  cwd: string; lang: 'en' | 'ja'; session: ManagerConversationSession; onExit: () => void;
  initialDiagnostics: readonly string[];
  startup?: { run: (signal: AbortSignal) => Promise<readonly string[]>; fail: (error: unknown) => void };
}): ReactElement {
  const [editor, setEditor] = useState(() => createEditorState(''));
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => initialDiagnostics.map((content) => ({
    role: 'assistant', content: toDisplayText(content),
  })));
  const [pending, setPending] = useState<PendingManagerSummary | null>(null);
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(startup !== undefined);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [answerTarget, setAnswerTarget] = useState<{ pending: PendingQuestion; choice: number | null } | null>(null);
  const active = useRef<AbortController | null>(null);
  const registering = useRef(false);
  const selected = useRef(false);
  const answerChoice = useRef<number | null>(null);
  const mounted = useRef(true);
  const starting = useRef(startup !== undefined);
  const exiting = useRef(false);
  const displayed = useRef(new Set<string>());
  const { waitUntilRenderFlush } = useApp();
  const { stdout } = useStdout();
  const contentWidth = Math.max(1, (stdout.columns ?? 80) - 6);
  const ja = lang === 'ja';
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      if (startup !== undefined) {
        const controller = new AbortController();
        active.current = controller;
        try {
          // Recovery can call the provider too, so stdout must contain the notices first.
          await waitUntilRenderFlush();
          if (!mounted.current || controller.signal.aborted) return;
          const diagnostics = await startup.run(controller.signal);
          if (!mounted.current || controller.signal.aborted) return;
          for (const diagnostic of diagnostics) append(diagnostic);
        } catch (error) {
          if (!controller.signal.aborted) startup.fail(error);
          return;
        } finally {
          if (active.current === controller) active.current = null;
          starting.current = false;
          if (mounted.current) setBusy(false);
        }
      }
      await refreshEvents();
    })().catch((error: unknown) => append(getErrorMessage(error)));
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  const append = (content: string): void => {
    if (mounted.current) setEntries((previous) => [...previous, { role: 'assistant', content: toDisplayText(content) }]);
  };
  const refreshEvents = async (): Promise<PendingQuestion[]> => {
    const { events, diagnostics, questions: savedQuestions } = await readManagerDisplayEvents(cwd);
    if (mounted.current) setQuestions(savedQuestions);
    for (const event of [...events, ...diagnostics]) {
      if (displayed.current.has(event.id) || !mounted.current) continue;
      displayed.current.add(event.id);
      append(event.message);
    }
    return savedQuestions;
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
      const savedQuestions = await refreshEvents();
      if (text.startsWith('/answer ')) {
        const questionId = text.slice('/answer '.length).trim();
        const target = savedQuestions.find((saved) => saved.question.id === questionId);
        if (target === undefined) append(ja ? '回答待ちの質問が見つかりません' : 'Pending question not found');
        else {
          answerChoice.current = target.question.options === undefined ? null : 0;
          setAnswerTarget({ pending: target, choice: answerChoice.current });
        }
        return;
      }
      const result = await session.handleUserMessage({ text, abortSignal: controller.signal });
      if (active.current !== controller || !mounted.current) return;
      append(result.message);
      setPending(session.getPendingSummary());
      await refreshEvents();
    } catch (error) {
      append(getErrorMessage(error));
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const saveAnswer = async (target: PendingQuestion, text: string): Promise<void> => {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setAnswerTarget(null);
    setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(text) }]);
    try {
      const result = await session.answerQuestion({
        goalId: target.goalId, questionId: target.question.id, text, abortSignal: controller.signal,
      });
      append(result.message);
      await refreshEvents();
    } catch (error) { append(getErrorMessage(error)); }
    finally {
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
      if (result.kind === 'goal_registered') append(result.turn.message);
      await refreshEvents();
    } catch (error) {
      append(getErrorMessage(error));
    } finally {
      registering.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useInput((input, key) => {
    if (exiting.current || registering.current) return;
    if (key.ctrl && input === 'c') {
      exiting.current = true;
      active.current?.abort();
      onExit();
      return;
    }
    if (starting.current) return;
    if (active.current !== null) {
      if (key.escape) {
        active.current.abort();
        active.current = null;
        setPending(null);
        setBusy(false);
      }
      return;
    }
    if (answerTarget !== null) {
      if (key.escape) { setAnswerTarget(null); return; }
      const options = answerTarget.pending.question.options ?? [];
      if (answerChoice.current !== null && (key.upArrow || key.downArrow)) {
        const next = answerChoice.current + (key.upArrow ? -1 : 1);
        answerChoice.current = Math.max(0, Math.min(options.length, next));
        setAnswerTarget({ ...answerTarget, choice: answerChoice.current });
        return;
      }
      if (key.return && answerChoice.current !== null) {
        if (answerChoice.current === options.length) {
          answerChoice.current = null;
          setAnswerTarget({ ...answerTarget, choice: null });
        } else void saveAnswer(answerTarget.pending, options[answerChoice.current]!);
        return;
      }
      if (key.return && !(key.shift || key.meta) && editor.text.trim() !== '') {
        setEditor(commitEditorInput(editor, editor.text));
        void saveAnswer(answerTarget.pending, editor.text);
        return;
      }
      if (answerChoice.current !== null) {
        answerChoice.current = null;
        setAnswerTarget({ ...answerTarget, choice: null });
      }
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
      {questions.length > 0 && (
        <Box borderStyle="round" flexDirection="column">
          <Text bold>{ja ? '回答待ちの質問' : 'Pending questions'}</Text>
          {questions.map(({ goalId, objective, question }) => (
            <Box key={JSON.stringify([goalId, question.id])} flexDirection="column">
              <Text>{toDisplayText(`${goalId}: ${objective}\n${question.id}: ${question.body}`)}</Text>
              {question.options !== undefined && <Text>{toDisplayText(question.options.join(' / '))}</Text>}
              {question.recommendation !== undefined && <Text>{`${ja ? '推奨' : 'Recommendation'}: ${toDisplayText(question.recommendation)}`}</Text>}
              <Text dimColor>{toDisplayText(`/answer ${question.id}`)}</Text>
            </Box>
          ))}
        </Box>
      )}
      {answerTarget !== null && (
        <Box borderStyle="round" flexDirection="column">
          <Text bold>{toDisplayText(answerTarget.pending.question.body)}</Text>
          {answerTarget.choice !== null ? (
            <>
              {answerTarget.pending.question.options?.map((option, index) => (
                <Text key={index} inverse={answerTarget.choice === index}>{toDisplayText(option)}</Text>
              ))}
              <Text inverse={answerTarget.choice === answerTarget.pending.question.options?.length}>
                {ja ? '自由記述' : 'Free text'}
              </Text>
              <Text dimColor>{ja ? '↑↓ 選択 / Enter 決定 / Esc 戻る' : '↑↓ Choose / Enter Select / Esc Back'}</Text>
            </>
          ) : <Text>{ja ? '回答を入力してください' : 'Enter your answer'}</Text>}
        </Box>
      )}
      {pending !== null && (
        <Box borderStyle="round" flexDirection="column">
          <Text bold>{ja ? '登録する要約' : 'Summary to register'}</Text>
          <Text>{toDisplayText(pending.summary.objective)}</Text>
          <Text>{`${ja ? '範囲外' : 'Out of scope'}:`}</Text>
          {pending.summary.outOfScope.map((item, index) => <Text key={index}>{toDisplayBullet(item)}</Text>)}
          <Text>{`${ja ? '受け入れ条件' : 'Acceptance criteria'}:`}</Text>
          {pending.summary.acceptanceCriteria.map((item, index) => <Text key={index}>{toDisplayBullet(item)}</Text>)}
          {pending.summary.startBranch !== undefined && <Text>{`startBranch: ${toDisplayText(pending.summary.startBranch)}`}</Text>}
          {pending.summary.integrationBranch !== undefined && <Text>{`integrationBranch: ${toDisplayText(pending.summary.integrationBranch)}`}</Text>}
          <Text inverse={approve}>{ja ? '登録を承認' : 'Approve registration'}</Text>
          <Text inverse={!approve}>{ja ? '会話を続ける' : 'Continue conversation'}</Text>
          <Text dimColor>{ja ? '↑ 承認 / ↓ 続行 / Enter 決定' : '↑ Approve / ↓ Continue / Enter Select'}</Text>
        </Box>
      )}
      <Box flexDirection="column" flexShrink={0}>
        <Text color="yellow">{getLabel('manager.experimentalNotice', lang)}</Text>
        <Text color="yellow">{getLabel('manager.costNotice', lang)}</Text>
      </Box>
      <StatusLine busy={busy} label={ja ? '処理中' : 'Working'} streamed="" />
      <PromptInput text={editor.text} cursor={editor.cursor} contentWidth={contentWidth}
        placeholder={answerTarget === null ? (ja ? 'ゴールを相談してください' : 'Discuss your goal') : (ja ? '回答を入力してください' : 'Enter your answer')}
        hint="Enter: send / Shift+Enter: newline / Esc: interrupt / Ctrl+C: exit"
        completions={[]} completionIndex={0} disabled={busy || pending !== null} />
    </Box>
  );
}
