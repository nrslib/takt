import { useManagerAbortConfirmation } from './useManagerAbortConfirmation.js';
import { useManagerQuestionAnswer, type PendingQuestion } from './useManagerQuestionAnswer.js';
import { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import { classifyManagerGoInput, useManagerInput } from './useManagerInput.js';
import { ManagerQueuedMessages } from './ManagerQueuedMessages.js';
import { ManagerAbortedGoals } from './ManagerAbortedGoals.js';
import { ManagerPausedGoals } from './ManagerPausedGoals.js';
import { ManagerPendingQuestions } from './ManagerPendingQuestions.js';
import { ManagerAnswerDialog } from './ManagerAnswerDialog.js';
import { ManagerAbortDialog } from './ManagerAbortDialog.js';
import { ManagerSummaryDialog } from './ManagerSummaryDialog.js';
import { ManagerHelp } from './ManagerHelp.js';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { findAssignedGoalRepository } from './assignment.js';
import type { ManagerAssignment } from './startupResolution.js';
import { Box, Text, useApp, useStdout } from 'ink';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { PromptInput } from '../tui/PromptInput.js';
import { TranscriptView, type TranscriptEntry } from '../tui/TranscriptEntryView.js';
import { StatusLine } from '../tui/StatusLine.js';
import { createEditorState, type EditorState } from '../tui/editorState.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../tui/terminalColors.js';
import { toDisplayText } from '../tui/displayText.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import type { ManagerConversationSession } from './conversationSession.js';
import { readManagerDisplayEvents, type ManagerDisplayGoal } from './savedEvents.js';
import { GoalIdSchema } from '../../infra/goals/schema.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import { GoalStore } from '../../infra/goals/store.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

export function ManagerView({ cwd, lang, session, initialDiagnostics, onExit, startup, assignment }: {
  assignment?: ManagerAssignment;
  cwd: string; lang: 'en' | 'ja'; session: ManagerConversationSession; onExit: () => void;
  initialDiagnostics: readonly string[];
  startup?: { run: (signal: AbortSignal) => Promise<readonly string[]>; fail: (error: unknown) => void };
}): ReactElement {
  const [currentAssignment, setCurrentAssignment] = useState<ManagerAssignment | undefined>();
  const editorRef = useRef(createEditorState(''));
  const [editor, setEditor] = useState(editorRef.current);
  const [queued, setQueued] = useState<string[]>([]);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => initialDiagnostics.map((content) => ({
    role: 'assistant', content: toDisplayText(content),
  })));
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(startup !== undefined);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [goals, setGoals] = useState<ManagerDisplayGoal[]>([]);
  const displaySnapshot = useRef({ assignment: currentAssignment, questions, goals });
  const active = useRef<AbortController | null>(null);
  const polling = useRef(false);
  const registering = useRef(false);
  const selected = useRef(false);
  const mounted = useRef(true);
  const starting = useRef(startup !== undefined);
  const exiting = useRef(false);
  const displayed = useRef(new Set<string>());
  const lastRefreshError = useRef<string | undefined>(undefined);
  const { waitUntilRenderFlush } = useApp();
  const { stdout } = useStdout();
  const contentWidth = Math.max(1, (stdout.columns ?? 80) - 6);
  const ja = lang === 'ja';
  const resetChoice = (): void => { selected.current = false; setApprove(false); };
  const abortConfirmation = useManagerAbortConfirmation({ selected, setApprove, resetChoice });
  const { abortTarget, setAbortTarget } = abortConfirmation;
  const questionAnswer = useManagerQuestionAnswer();
  const { answerTarget, setAnswerTarget, beginAnswer } = questionAnswer;
  const summaryApproval = useManagerSummaryApproval({ selected, setApprove, resetChoice, session });
  const { pending, setPending } = summaryApproval;
  const edit = (next: EditorState): void => {
    editorRef.current = next;
    setEditor(next);
  };
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      if (startup !== undefined) {
        const controller = new AbortController();
        active.current = controller;
        try {
          // Flush the experimental and cost notices before starting background work.
          await waitUntilRenderFlush();
          if (!mounted.current || controller.signal.aborted) return;
          const diagnostics = await startup.run(controller.signal);
          if (!mounted.current || controller.signal.aborted) return;
          for (const diagnostic of diagnostics) append(diagnostic);
        } catch (error) {
          if (!controller.signal.aborted) {
            exiting.current = true;
            setQueued([]);
            startup.fail(error);
          }
          return;
        } finally {
          if (active.current === controller) active.current = null;
          starting.current = false;
          if (mounted.current) setBusy(false);
        }
      }
      await refreshEvents();
    })().catch(reportRefreshError);
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  const append = (content: string): void => {
    if (mounted.current) setEntries((previous) => [...previous, { role: 'assistant', content: toDisplayText(content) }]);
  };
  const reportRefreshError = (error: unknown): void => {
    const message = getErrorMessage(error);
    if (lastRefreshError.current !== message) append(message);
    lastRefreshError.current = message;
  };
  const reportFailure = async (error: unknown): Promise<void> => {
    append(sanitizeSensitiveText(getErrorMessage(error)));
    const notification = await notifyManagerTurnFailure(cwd, undefined, error);
    if (notification !== undefined) append(notification);
  };
  const appendResult = async (result: { kind: string; message: string }, signal?: AbortSignal): Promise<void> => {
    if (result.kind === 'error' && !signal?.aborted) await reportFailure(new Error(result.message));
    else append(result.message);
  };
  const refreshEvents = async (): Promise<PendingQuestion[]> => {
    const resolved = await session.getAssignment();
    const snapshots = await Promise.all((resolved?.repositoryDirectories ?? [cwd]).map(async (directory) => ({
      directory, snapshot: await readManagerDisplayEvents(directory, lang),
    })));
    const savedQuestions = snapshots.flatMap(({ snapshot }) => snapshot.questions);
    const savedGoals = snapshots.flatMap(({ snapshot }) => snapshot.goals);
    if (mounted.current) {
      const previous = displaySnapshot.current;
      if (!isDeepStrictEqual(previous.assignment, resolved)) setCurrentAssignment(resolved);
      if (!isDeepStrictEqual(previous.questions, savedQuestions)) setQuestions(savedQuestions);
      if (!isDeepStrictEqual(previous.goals, savedGoals)) setGoals(savedGoals);
      displaySnapshot.current = { assignment: resolved, questions: savedQuestions, goals: savedGoals };
    }
    for (const { directory, snapshot } of snapshots) {
      for (const event of [...snapshot.events, ...snapshot.diagnostics]) {
        const id = JSON.stringify([directory, event.id]);
        if (displayed.current.has(id) || !mounted.current) continue;
        displayed.current.add(id);
        append(event.message);
      }
    }
    lastRefreshError.current = undefined;
    return savedQuestions;
  };
  useEffect(() => {
    const timer = setInterval(() => {
      if (!mounted.current || exiting.current || starting.current || polling.current) return;
      polling.current = true;
      void refreshEvents().catch(reportRefreshError)
        .finally(() => { polling.current = false; });
    }, 500);
    return () => clearInterval(timer);
  }, []);
  const submit = async (text: string): Promise<void> => {
    setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(text) }]);
    const go = classifyManagerGoInput(text);
    if (go === 'arguments') {
      append(getLabel('manager.goUsage', lang));
      return;
    }
    if (go === 'command') {
      const summary = session.getPendingSummary();
      if (summary !== null) { await register(summary.revision); return; }
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setPending(null);
    resetChoice();
    try {
      const savedQuestions = await refreshEvents();
      const command = !/[\r\n]/u.test(text) ? /^\/(pause|resume|abort)(?:[\t ]+(.*))?$/u.exec(text) : null;
      if (command !== null) {
        const goalId = command[2]?.trim();
        if (goalId === undefined || goalId === '') append(getLabel('manager.goalExecutionUsage', lang));
        else if (!GoalIdSchema.safeParse(goalId).success) append(getLabel('manager.invalidGoalId', lang));
        else if (command[1] === 'abort') {
          const resolved = await session.getAssignment();
          const repository = resolved === undefined ? cwd : await findAssignedGoalRepository(goalId, resolved);
          const goal = await new GoalStore(repository).get(goalId);
          if (active.current !== controller || !mounted.current) return;
          if (goal.status === 'completed' && goal.executionStatus !== 'aborted') {
            append(getLabel('manager.completedGoalCannotAbort', lang, { goalId }));
          } else setAbortTarget(goal);
        }
        else {
          const options = { goalId, abortSignal: controller.signal };
          const result = await (command[1] === 'pause' ? session.pauseGoal(options) : session.resumeGoal(options));
          if (active.current !== controller || !mounted.current) return;
          await appendResult(result, controller.signal);
          await refreshEvents();
        }
        return;
      }
      if (text.startsWith('/answer ')) {
        const questionId = text.slice('/answer '.length).trim();
        const target = savedQuestions.find((saved) => saved.question.id === questionId);
        if (target === undefined) append(ja ? '回答待ちの質問が見つかりません' : 'Pending question not found');
        else beginAnswer(target);
        return;
      }
      const result = await session.handleUserMessage({
        text: go === 'command' ? getLabel('manager.goSummaryRequest', lang) : text,
        abortSignal: controller.signal, onNotification: append,
      });
      if (active.current !== controller || !mounted.current) return;
      await appendResult(result, controller.signal);
      const summary = session.getPendingSummary();
      setPending(summary);
      if (go === 'command' && result.kind === 'reply' && summary === null) append(getLabel('manager.goSummaryUnavailable', lang));
      await refreshEvents();
    } catch (error) {
      if (!controller.signal.aborted) await reportFailure(error);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(registering.current);
      }
    }
  };
  useEffect(() => {
    if (!mounted.current || exiting.current || starting.current || registering.current
      || active.current !== null || busy || abortTarget !== null || answerTarget !== null) return;
    const text = queued[0];
    if (text === undefined) return;
    setQueued((previous) => previous.slice(1));
    void submit(text);
  }, [queued, busy, abortTarget, answerTarget]);
  const abortGoal = async (goalId: string): Promise<void> => {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setAbortTarget(null);
    resetChoice();
    try {
      const result = await session.abortGoal({ goalId, abortSignal: controller.signal });
      await appendResult(result, controller.signal);
      await refreshEvents();
    } catch (error) { if (!controller.signal.aborted) await reportFailure(error); }
    finally {
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
      await appendResult(result, controller.signal);
      await refreshEvents();
    } catch (error) { if (!controller.signal.aborted) await reportFailure(error); }
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
      if (result.kind === 'goal_registered') append(`${ja ? 'ゴール登録完了' : 'Goal registered'}: ${result.goal.id}\n${result.goal.branch}`);
      else await appendResult(result);
      if (result.kind === 'goal_registered') append(result.turn.message);
      await refreshEvents();
    } catch (error) {
      await reportFailure(error);
    } finally {
      registering.current = false;
      if (mounted.current) setBusy(active.current !== null);
    }
  };
  useManagerInput({
    exiting, active, registering, editorRef, edit, setQueued, onExit, contentWidth, session,
    abortConfirmation, questionAnswer, summaryApproval, abortGoal, saveAnswer, register,
    onInputUnavailable: () => append(getLabel('manager.inputUnavailableDuringAbort', lang)),
  });
  return (
    <Box flexDirection="column">
      <Text bold>{`manager — ${ja ? '実験的機能' : 'Experimental'}`}</Text>
      <Text>{toDisplayText(currentAssignment?.kind === 'workspace'
        ? `${currentAssignment.name} (${currentAssignment.repositoryDirectories.length})`
        : assignment?.kind === 'workspace'
          ? `${assignment.name} (${assignment.repositoryDirectories.length})` : basename(cwd))}</Text>
      <Text dimColor>{toDisplayText(cwd)}</Text>
      <TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} />
      {queued.length > 0 && <ManagerQueuedMessages queued={queued} ja={ja} />}
      {goals.some((goal) => goal.executionStatus === 'aborted') && <ManagerAbortedGoals goals={goals} lang={lang} />}
      {goals.some(isGoalPaused) && <ManagerPausedGoals goals={goals} lang={lang} />}
      {questions.length > 0 && <ManagerPendingQuestions questions={questions} lang={lang} />}
      {answerTarget !== null && <ManagerAnswerDialog answerTarget={answerTarget} lang={lang} />}
      {abortTarget !== null && <ManagerAbortDialog abortTarget={abortTarget} approve={approve} lang={lang} />}
      {pending !== null && <ManagerSummaryDialog pending={pending} approve={approve} ja={ja} />}
      <ManagerHelp lang={lang} />
      <StatusLine busy={busy} label={ja ? '処理中' : 'Working'} streamed="" />
      <PromptInput text={editor.text} cursor={editor.cursor} contentWidth={contentWidth}
        placeholder={answerTarget === null ? (ja ? 'ゴールを相談してください' : 'Discuss your goal') : (ja ? '回答を入力してください' : 'Enter your answer')}
        hint="Enter: send / Shift+Enter: newline / Esc: interrupt / Ctrl+C: exit"
        completions={[]} completionIndex={0} disabled={abortTarget !== null || (pending !== null && editor.text === '')} />
    </Box>
  );
}
