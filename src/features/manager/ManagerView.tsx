import { useManagerAbortConfirmation, type ManagerAbortTarget } from './useManagerAbortConfirmation.js';
import { useManagerQuestionAnswer, type SaveManagerAnswer } from './useManagerQuestionAnswer.js';
import type { AppendManagerAnswerPermission, PendingQuestion } from './inquiryAnswer.js';
import { appendScopedPermission } from './scopedPermissionStorage.js';
import { resolveAssignedProjectRoot } from './assignment.js';
import { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import { useManagerInput } from './useManagerInput.js';
import { ManagerQueuedMessages } from './ManagerQueuedMessages.js';
import { ManagerAnswerDialog } from './ManagerAnswerDialog.js';
import { ManagerAbortDialog } from './ManagerAbortDialog.js';
import { ManagerSummaryDialog } from './ManagerSummaryDialog.js';
import { ManagerHelp } from './ManagerHelp.js';
import { ManagerSelectionDialog } from './ManagerSelectionDialog.js';
import { isGoalSelectionCandidate, useManagerSelection, type ManagerSelectedTarget, type ManagerSelectionCommand } from './useManagerSelection.js';
import { formatGoalName } from './goalDisplay.js';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
import { readManagerDisplayEvents, type ManagerDisplayGoal, type ManagerDisplayNotice } from './savedEvents.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

type PendingOperation =
  | { kind: 'summary' }
  | { kind: 'register'; revision: number }
  | { kind: 'goal'; operation: 'pause' | 'resume' | 'abort'; target: ManagerDisplayGoal };

export function ManagerView({ cwd, lang, session, initialDiagnostics, onExit, startup, assignment }: {
  assignment?: ManagerAssignment;
  cwd: string; lang: 'en' | 'ja'; session: ManagerConversationSession; onExit: () => void;
  initialDiagnostics: readonly string[];
  startup?: { run: (signal: AbortSignal) => Promise<readonly string[]>; fail: (error: unknown) => void };
}): ReactElement {
  const [currentAssignment, setCurrentAssignment] = useState<ManagerAssignment | undefined>();
  const editorRef = useRef(createEditorState(''));
  const [editor, setEditor] = useState(editorRef.current);
  const answerEditorRef = useRef(createEditorState(''));
  const [answerEditor, setAnswerEditor] = useState(answerEditorRef.current);
  const [queued, setQueued] = useState<string[]>([]);
  const [operations, setOperations] = useState<PendingOperation[]>([]);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => initialDiagnostics.map((content) => ({
    role: 'assistant', content: toDisplayText(content),
  })));
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(true);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [goals, setGoals] = useState<ManagerDisplayGoal[]>([]);
  const [notices, setNotices] = useState<ManagerDisplayNotice[]>([]);
  const displaySnapshot = useRef({ assignment: currentAssignment, questions, goals, notices });
  const active = useRef<AbortController | null>(null);
  const polling = useRef(false);
  const registering = useRef(false);
  const selected = useRef(false);
  const mounted = useRef(true);
  const starting = useRef(true);
  const [startedAt] = useState(() => Date.now());
  const startupBoundaries = useRef<ReadonlyMap<string, number>>(new Map());
  const exiting = useRef(false);
  const menuRequest = useRef(0);
  const displayed = useRef(new Set<string>());
  const lastRefreshError = useRef<string | undefined>(undefined);
  const { waitUntilRenderFlush } = useApp();
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => stdout.columns);
  useEffect(() => {
    const handleResize = (): void => { setColumns(stdout.columns); };
    stdout.on('resize', handleResize);
    return () => { stdout.off('resize', handleResize); };
  }, [stdout]);
  const contentWidth = Math.max(1, (columns ?? 80) - 6);
  const bodyWidth = Math.max(1, (columns ?? 80) - 2);
  const ja = lang === 'ja';
  const resetChoice = (): void => { selected.current = false; setApprove(false); };
  const abortConfirmation = useManagerAbortConfirmation({ selected, setApprove, resetChoice });
  const { abortTarget, setAbortTarget } = abortConfirmation;
  const questionAnswer = useManagerQuestionAnswer(bodyWidth);
  const { answerTarget, clearAnswer, beginAnswer } = questionAnswer;
  const selection = useManagerSelection(bodyWidth);
  const summaryApproval = useManagerSummaryApproval({ selected, setApprove, resetChoice, session });
  const { pending, setPending } = summaryApproval;
  const edit = (next: EditorState): void => {
    editorRef.current = next;
    setEditor(next);
  };
  const editAnswer = (next: EditorState): void => {
    answerEditorRef.current = next;
    setAnswerEditor(next);
  };
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        try {
          const resolved = await session.getAssignment();
          startupBoundaries.current = new Map((resolved?.repositoryDirectories ?? [cwd]).map((directory) => [directory, startedAt]));
        } catch (error) {
          startupBoundaries.current = new Map((assignment?.repositoryDirectories ?? [cwd]).map((directory) => [directory, startedAt]));
          reportRefreshError(error);
        }
        if (startup !== undefined) {
          const controller = new AbortController();
          active.current = controller;
          try {
            // Flush the experimental notice before starting background work.
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
          }
        }
        await refreshEvents();
      } finally {
        starting.current = false;
        if (mounted.current) setBusy(false);
      }
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
  const refreshEvents = async (): Promise<{ questions: PendingQuestion[]; goals: ManagerDisplayGoal[]; notices: ManagerDisplayNotice[] }> => {
    const resolved = await session.getAssignment();
    const snapshot = await readManagerDisplayEvents(cwd, lang, resolved, startupBoundaries.current, startedAt);
    const savedQuestions = snapshot.questions;
    const savedGoals = snapshot.goals;
    const savedNotices = snapshot.notices;
    if (mounted.current) {
      const previous = displaySnapshot.current;
      if (!isDeepStrictEqual(previous.assignment, resolved)) setCurrentAssignment(resolved);
      if (!isDeepStrictEqual(previous.questions, savedQuestions)) setQuestions(savedQuestions);
      if (!isDeepStrictEqual(previous.goals, savedGoals)) setGoals(savedGoals);
      if (!isDeepStrictEqual(previous.notices, savedNotices)) setNotices(savedNotices);
      displaySnapshot.current = { assignment: resolved, questions: savedQuestions, goals: savedGoals, notices: savedNotices };
    }
    for (const event of [...snapshot.events, ...snapshot.diagnostics]) {
      const id = JSON.stringify([cwd, event.id]);
      if (displayed.current.has(id) || !mounted.current) continue;
      displayed.current.add(id);
      if (!event.suppressInitialDisplay) append(event.message);
    }
    lastRefreshError.current = undefined;
    return { questions: savedQuestions, goals: savedGoals, notices: savedNotices };
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
  const submit = async (text: string, summaryRequest: boolean): Promise<void> => {
    setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(text) }]);
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setPending(null);
    resetChoice();
    try {
      await refreshEvents();
      if (active.current !== controller || !mounted.current || controller.signal.aborted) return;
      const result = await session.handleUserMessage({
        text,
        abortSignal: controller.signal, onNotification: append,
      });
      if (active.current !== controller || !mounted.current) return;
      await appendResult(result, controller.signal);
      const summary = session.getPendingSummary();
      setPending(summary);
      if (summaryRequest && result.kind === 'reply' && summary === null) append(getLabel('manager.goSummaryUnavailable', lang));
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
      || active.current !== null || busy || abortTarget !== null || answerTarget !== null || selection.selection !== null) return;
    const operation = operations[0];
    if (operation !== undefined) {
      setOperations((previous) => previous.slice(1));
      if (operation.kind === 'summary') void submit(getLabel('manager.goSummaryRequest', lang), true);
      else if (operation.kind === 'register') void register(operation.revision);
      else void changeGoal(operation.operation, operation.target, 'select');
      return;
    }
    const text = queued[0];
    if (text === undefined) return;
    setQueued((previous) => previous.slice(1));
    void submit(text, false);
  }, [queued, operations, busy, abortTarget, answerTarget, selection.selection]);
  const changeGoal = async (kind: 'pause' | 'resume' | 'abort', target: ManagerDisplayGoal,
    phase: 'select' | 'confirm' | 'retry'): Promise<void> => {
    if (active.current !== null) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    resetChoice();
    try {
      if (phase !== 'retry') {
        const snapshot = await refreshEvents();
        if (active.current !== controller || !mounted.current || controller.signal.aborted) return;
        const latest = snapshot.goals.find((goal) => goal.id === target.id && isGoalSelectionCandidate(kind, goal));
        if (latest === undefined) {
          setAbortTarget(null);
          append(getLabel('manager.selectionChanged', lang));
          if (!selection.open('goal', snapshot)) append(getLabel('manager.selectionEmpty.goal', lang));
          return;
        }
        target = latest;
        if (kind === 'abort' && phase === 'select') {
          setAbortTarget({ goal: target, retry: false });
          return;
        }
      }
      const options = { goalId: target.id, abortSignal: controller.signal };
      setPending(null);
      const result = await (kind === 'pause' ? session.pauseGoal(options)
        : kind === 'resume' ? session.resumeGoal(options) : session.abortGoal(options));
      if (active.current !== controller || !mounted.current) return;
      if (kind === 'abort') setAbortTarget(result.kind === 'error' ? { goal: target, retry: true } : null);
      await appendResult(result.kind === 'reply'
        ? { ...result, message: `${formatGoalName(target.objective)}\n${result.message}` } : result, controller.signal);
      await refreshEvents();
    } catch (error) { if (!controller.signal.aborted) await reportFailure(error); }
    finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const selectTarget = (selected: ManagerSelectedTarget): void => {
    if (selected.kind === 'answer') {
      editAnswer(createEditorState(''));
      beginAnswer(selected.target,
        displaySnapshot.current.assignment ?? { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] }, selected.onCancel);
    } else setOperations((previous) => [...previous, { kind: 'goal', operation: selected.kind, target: selected.target }]);
  };
  const abortGoal = (target: ManagerAbortTarget): Promise<void> => changeGoal('abort', target.goal, target.retry ? 'retry' : 'confirm');
  const saveAnswer: SaveManagerAnswer = async (target, answer, permission): Promise<void> => {
    if (active.current !== null) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setPending(null);
    try {
      const appendPermission: AppendManagerAnswerPermission | undefined = permission === undefined ? undefined : async (assignment) => {
        let scope = permission.scope;
        if (scope.kind === 'project') {
          scope = { kind: 'project', projectDirectory: await resolveAssignedProjectRoot(scope.projectDirectory, assignment) };
        }
        controller.signal.throwIfAborted();
        try {
          await appendScopedPermission({ scope, heading: '許可', sentence: permission.sentence });
        } catch (error) {
          throw new Error(getLabel('manager.permissionAppendFailed', lang, { reason: getErrorMessage(error) }), { cause: error });
        }
      };
      controller.signal.throwIfAborted();
      const result = await session.answerQuestion({
        ...(target.goalId === null ? { goalId: null, owner: target.owner }
          : { goalId: target.goalId, repositoryDirectory: target.repositoryDirectory }),
        questionId: target.question.id, answer, abortSignal: controller.signal,
        ...(appendPermission === undefined ? {} : { appendPermission }),
      });
      if (result.answerSaved) {
        clearAnswer();
        editAnswer(createEditorState(''));
        setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(answer.text ?? '') }]);
      }
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
    if (registering.current || session.getPendingSummary()?.revision !== revision) return;
    registering.current = true;
    setBusy(true);
    setPending(null);
    resetChoice();
    try {
      const result = await session.approveSummary(revision);
      if (result.kind === 'goal_registered') append(getLabel('manager.goalRegistered', lang, {
        name: formatGoalName(result.goal.objective), id: result.goal.id, branch: result.goal.branch,
      }));
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
  const openMenu = (kind: ManagerSelectionCommand): void => {
    if (kind === 'answer' && registering.current) return;
    const request = ++menuRequest.current;
    if (kind !== 'notice') {
      clearAnswer();
      setAbortTarget(null);
      resetChoice();
    }
    void refreshEvents().then((snapshot) => {
      if (!mounted.current || exiting.current || request !== menuRequest.current || (kind === 'answer' && registering.current)) return;
      if (kind === 'notice') {
        if (snapshot.notices.length === 0) return;
        clearAnswer();
        setAbortTarget(null);
        resetChoice();
      }
      if (!selection.open(kind, snapshot) && kind !== 'notice') append(getLabel(`manager.selectionEmpty.${kind}`, lang));
    }).catch(reportRefreshError);
  };
  const queueRegistration = async (revision: number): Promise<void> => {
    setOperations((previous) => previous.some((operation) => operation.kind === 'register' && operation.revision === revision)
      ? previous : [...previous, { kind: 'register', revision }]);
  };
  const summarize = (): void => {
    const summary = session.getPendingSummary();
    if (summary !== null) void queueRegistration(summary.revision);
    else setOperations((previous) => previous.some((operation) => operation.kind === 'summary')
      ? previous : [...previous, { kind: 'summary' }]);
  };
  const visibleEditor = answerTarget === null ? editor : answerEditor;
  const summaryVisible = pending !== null && selection.selection === null && answerTarget === null && abortTarget === null;
  const selectingSummary = summaryVisible && editor.text === '';
  const cancelMenuRequest = (): void => { menuRequest.current += 1; };
  useManagerInput({
    exiting, active, registering, editorRef: answerTarget === null ? editorRef : answerEditorRef,
    edit: answerTarget === null ? edit : editAnswer, setQueued, onExit, contentWidth, session,
    abortConfirmation, questionAnswer, summaryApproval, selection, selectTarget, abortGoal, saveAnswer,
    register: queueRegistration,
    openMenu, summarize, cancelMenuRequest, cancelOperations: () => { cancelMenuRequest(); setOperations([]); },
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
      <Text>{getLabel('manager.counts', lang, {
        goals: String(goals.filter((goal) => isGoalSelectionCandidate('abort', goal)).length),
        questions: String(questions.length),
      })}</Text>
      {queued.length > 0 && <ManagerQueuedMessages queued={queued} ja={ja} />}
      {selection.selection !== null && <ManagerSelectionDialog selection={selection.selection} bodyText={selection.bodyText} lang={lang} />}
      {answerTarget !== null && <ManagerAnswerDialog answerTarget={answerTarget} bodyText={questionAnswer.bodyText} lang={lang} />}
      {abortTarget !== null && <ManagerAbortDialog abortTarget={abortTarget.goal} retry={abortTarget.retry} approve={approve} lang={lang} />}
      {summaryVisible && <>
        <ManagerSummaryDialog pending={pending} approve={approve} ja={ja} />
        <Text dimColor>{getLabel('manager.summaryHint', lang)}</Text>
      </>}
      <ManagerHelp lang={lang} />
      <StatusLine busy={busy} label={ja ? '処理中' : 'Working'} streamed="" />
      <PromptInput text={visibleEditor.text} cursor={visibleEditor.cursor} contentWidth={contentWidth}
        placeholder={answerTarget === null ? (ja ? 'ゴールを相談してください' : 'Discuss your goal') : (ja ? '回答を入力してください' : 'Enter your answer')}
        hint={getLabel(selectingSummary ? 'manager.summaryInputHint' : 'manager.inputHint', lang)}
        completions={[]} completionIndex={0} disabled={selection.selection !== null || abortTarget !== null || selectingSummary} />
    </Box>
  );
}
