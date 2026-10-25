import { basename } from 'node:path';
import { Box, Text, useStdout } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { useManagerAbortConfirmation, type ManagerAbortTarget } from './useManagerAbortConfirmation.js';
import { useManagerQuestionAnswer, type SaveManagerAnswer } from './useManagerQuestionAnswer.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import { useManagerInput } from './useManagerInput.js';
import { ManagerAnswerDialog } from './ManagerAnswerDialog.js';
import { ManagerAbortDialog } from './ManagerAbortDialog.js';
import { ManagerSummaryDialog } from './ManagerSummaryDialog.js';
import { ManagerHelp } from './ManagerHelp.js';
import { ManagerSelectionDialog } from './ManagerSelectionDialog.js';
import { isGoalSelectionCandidate, useManagerSelection, type ManagerSelectedTarget, type ManagerSelectionCommand } from './useManagerSelection.js';
import { formatGoalName } from './goalDisplay.js';
import type { ManagerExecutionContext } from './startupResolution.js';
import type { ConversationIpcClient } from './conversationIpcClient.js';
import type { ConversationCommand, OperationResult } from './conversationPort.js';
import { PromptInput } from '../tui/PromptInput.js';
import { TranscriptView, type TranscriptEntry } from '../tui/TranscriptEntryView.js';
import { StatusLine } from '../tui/StatusLine.js';
import { createEditorState, type EditorState } from '../tui/editorState.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../tui/terminalColors.js';
import { toDisplayText, toSingleLineText } from '../tui/displayText.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { measureWidth } from '../../shared/utils/grapheme.js';

export function ManagerView({ cwd, lang, client, initialDiagnostics, onExit, assignment }: {
  assignment: ManagerExecutionContext['assignment'];
  cwd: string; lang: 'en' | 'ja';
  client: Pick<ConversationIpcClient, 'getSnapshot' | 'subscribe' | 'onOutput' | 'submit' | 'refresh' | 'close'>;
  onExit: () => void; initialDiagnostics: readonly string[];
}): ReactElement {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const editorRef = useRef(createEditorState(''));
  const [editor, setEditor] = useState(editorRef.current);
  const answerEditorRef = useRef(createEditorState(''));
  const [answerEditor, setAnswerEditor] = useState(answerEditorRef.current);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => initialDiagnostics.map((content) => ({ role: 'assistant', content: toDisplayText(content) })));
  const [approve, setApprove] = useState(false);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const [summarizing, setSummarizing] = useState(false);
  const summaryOperation = useRef<string | null>(null);
  const active = useRef(false);
  const registering = useRef(false);
  const selected = useRef(false);
  const mounted = useRef(true);
  const exiting = useRef(false);
  const displayed = useRef(new Set<string>());
  const lastError = useRef<string | null>(null);
  const pendingAnswer = useRef<{ text: string; operationId?: string } | null>(null);
  const goalOperations = useRef(new Map<string, { kind: 'pause' | 'resume' | 'abort'; goal: ManagerAbortTarget['goal'] }>());
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
  const state = snapshot.state;
  const busy = sending || state?.running != null;
  active.current = busy;
  const canApprove = snapshot.connection === 'connected' && snapshot.readStatus === 'complete' && !busy;
  const append = (content: string): void => {
    if (mounted.current) setEntries((previous) => [...previous, { role: 'assistant', content: toDisplayText(sanitizeSensitiveText(content)) }]);
  };
  const send = async (command: ConversationCommand, onAccepted?: (id: string) => void): Promise<string | null> => {
    if (submitting.current && command.kind !== 'abort_turn') { append(getLabel('manager.conversation.busy', lang)); return null; }
    submitting.current = true;
    setSending(true);
    try {
      const result = await client.submit(command, onAccepted);
      if (result.kind === 'accepted') return result.operationId;
      append(result.kind === 'error' ? result.message : getLabel('manager.conversation.busy', lang));
      if (result.kind === 'error') void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
      return null;
    } catch (error) { append(getErrorMessage(error)); return null; }
    finally { submitting.current = false; if (mounted.current) setSending(false); }
  };
  const summaryApproval = useManagerSummaryApproval({ selected, setApprove, resetChoice,
    dismissSummary: async (revision) => {
      if (await send({ kind: 'dismiss_summary', revision }) === null) {
        setPending(client.getSnapshot().state?.pending ?? null);
      }
    } });
  const { pending, setPending } = summaryApproval;
  const edit = (next: EditorState): void => { editorRef.current = next; setEditor(next); };
  const editAnswer = (next: EditorState): void => { answerEditorRef.current = next; setAnswerEditor(next); };
  const currentAssignment = snapshot.items.find((item) => item.kind === 'assignment')?.assignment ?? assignment;
  const goals = snapshot.items.flatMap((item) => item.kind === 'goal' ? [item.goal] : []);
  const questions: PendingQuestion[] = snapshot.items.flatMap((item): PendingQuestion[] => {
    if (item.kind !== 'inquiry') return [];
    const { target, question, objective } = item.inquiry;
    if (target.goalId === null) return [{ ...target, question }];
    if (objective === undefined) throw new Error('Missing inquiry objective');
    return [{ ...target, question, objective }];
  });
  const notices = snapshot.items.flatMap((item) => item.kind === 'notice' ? [item.notice] : []);
  const display = { questions, goals, notices, repositoryDirectories: currentAssignment.repositoryDirectories };
  useEffect(() => {
    setPending(state?.pending ?? null);
    resetChoice();
  }, [state?.revision, state?.pending]);
  useEffect(() => {
    if (snapshot.error !== null && snapshot.error !== lastError.current) append(snapshot.error);
    lastError.current = snapshot.error;
    for (const item of snapshot.items) {
      if (item.kind !== 'display_event' || displayed.current.has(item.event.id)) continue;
      displayed.current.add(item.event.id);
      if (!item.event.suppressInitialDisplay) append(item.event.message);
    }
    if (snapshot.readStatus === 'complete') selection.refresh(display);
  }, [snapshot.items, snapshot.readStatus, snapshot.error]);
  const showResult = (result: OperationResult, operationId: string): void => {
    const goalOperation = goalOperations.current.get(operationId);
    goalOperations.current.delete(operationId);
    if (result.kind === 'goal_registered') append(getLabel('manager.goalRegistered', lang, {
      name: formatGoalName(result.goal.objective), id: result.goal.id, branch: result.goal.branch,
    }));
    else append(goalOperation !== undefined && result.kind === 'reply'
      ? formatGoalName(goalOperation.goal.objective) + '\n' + result.message : result.message);
    if (goalOperation?.kind === 'abort') setAbortTarget(result.kind === 'error'
      ? { goal: goalOperation.goal, retry: true } : null);
    if (summaryOperation.current === operationId) {
      if (result.kind === 'reply' && latest.current.state?.pending == null) append(getLabel('manager.goSummaryUnavailable', lang));
      summaryOperation.current = null;
      setSummarizing(false);
    }
    if (result.kind === 'error' && result.permissionAppended) append(getLabel('manager.conversation.permission_appended', lang));
    if (result.kind === 'error' && result.answerSaved) append(getLabel('manager.conversation.answer_saved', lang));
    if ('answerSaved' in result && result.answerSaved && pendingAnswer.current?.operationId === operationId) {
      clearAnswer();
      editAnswer(createEditorState(''));
      const text = pendingAnswer.current.text;
      setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(text) }]);
      pendingAnswer.current = null;
    }
    registering.current = false;
    void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
  };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = client.onOutput((output) => {
      if (output.kind === 'result') showResult(output.result, output.operationId);
      else if (output.kind === 'progress' || output.kind === 'reply' || output.kind === 'notice') append(output.message);
    });
    const timer = setInterval(() => {
      if (latest.current.connection === 'connected' && latest.current.readStatus !== 'reading') {
        void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
      }
    }, 500);
    return () => { mounted.current = false; clearInterval(timer); unsubscribe(); client.close(); };
  }, [client]);
  const register = async (revision: number): Promise<void> => {
    const current = client.getSnapshot();
    if (current.connection !== 'connected' || current.readStatus !== 'complete'
      || current.state?.running != null || submitting.current || current.state?.pending?.revision !== revision) return;
    registering.current = true;
    resetChoice();
    if (await send({ kind: 'approve_summary', revision }) === null) registering.current = false;
  };
  const submit = (text: string, summaryRequest = false): void => {
    if (!summaryRequest) setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(text) }]);
    else setSummarizing(true);
    resetChoice();
    void send({ kind: 'message', text }, summaryRequest ? (id) => { summaryOperation.current = id; } : undefined)
      .then((id) => { if (id === null && summaryRequest) setSummarizing(false); });
  };
  const summarize = (): void => {
    if (latest.current.state?.pending != null) void register(latest.current.state.pending.revision);
    else submit(getLabel('manager.goSummaryRequest', lang), true);
  };
  const changeGoal = async (kind: 'pause' | 'resume' | 'abort', target: ManagerAbortTarget['goal'], confirmed = false, retry = false): Promise<void> => {
    const current = retry ? target : goals.find((goal) => goal.id === target.id && isGoalSelectionCandidate(kind, goal));
    if (current === undefined) { append(getLabel('manager.selectionChanged', lang)); return; }
    if (kind === 'abort' && !confirmed) { setAbortTarget({ goal: current, retry: false }); return; }
    await send({ kind: kind === 'pause' ? 'pause_goal' : kind === 'resume' ? 'resume_goal' : 'abort_goal', goalId: current.id }, (id) => {
      goalOperations.current.set(id, { kind, goal: current });
      setAbortTarget(null);
    });
  };
  const selectTarget = (target: ManagerSelectedTarget): void => {
    if (target.kind === 'answer') {
      editAnswer(createEditorState(''));
      beginAnswer(target.target, currentAssignment, target.onCancel);
    } else void changeGoal(target.kind, target.target);
  };
  const saveAnswer: SaveManagerAnswer = async (target, answer, permission) => {
    pendingAnswer.current = { text: answer.text ?? '' };
    const operationId = await send({ kind: 'answer_question', target: target.goalId === null
      ? { goalId: null, owner: target.owner } : { goalId: target.goalId, repositoryDirectory: target.repositoryDirectory },
      questionId: target.question.id, answer, ...(permission === undefined ? {} : { permission }) },
    (id) => { if (pendingAnswer.current !== null) pendingAnswer.current.operationId = id; });
    if (operationId === null) pendingAnswer.current = null;
  };
  const openMenu = (kind: ManagerSelectionCommand): void => {
    if (kind === 'answer' && registering.current) return;
    if (kind === 'notice' && notices.length === 0) {
      append(getLabel('manager.selectionEmpty.notice', lang));
      void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
      return;
    }
    if (kind === 'repository' && display.repositoryDirectories.length === 0) {
      append(getLabel('manager.selectionEmpty.repository', lang));
      return;
    }
    if (kind !== 'repository') { clearAnswer(); setAbortTarget(null); resetChoice(); }
    if (!selection.open(kind, display)) append(getLabel('manager.selectionEmpty.' + kind, lang));
    void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
  };
  const visibleEditor = answerTarget === null ? editor : answerEditor;
  const summaryVisible = pending !== null && selection.selection === null && answerTarget === null && abortTarget === null;
  const selectingSummary = summaryVisible && editor.text === '';
  const repositoryDirectories = currentAssignment.repositoryDirectories;
  const startupRepositoryDirectory = assignment.startupRepositoryDirectory ?? cwd;
  const headingRepository = repositoryDirectories.includes(startupRepositoryDirectory) ? startupRepositoryDirectory : repositoryDirectories[0];
  const assignmentHeading = headingRepository === undefined ? getLabel('manager.selectionEmpty.repository', lang)
    : getLabel(repositoryDirectories.length > 1 ? 'manager.assignmentHeadingMultiple' : 'manager.assignmentHeading', lang, {
      name: toSingleLineText(basename(headingRepository)), count: String(repositoryDirectories.length - 1),
    });
  const inputHint = getLabel(selectingSummary ? 'manager.summaryInputHint' : 'manager.inputHint', lang);
  const hintSeparator = selectingSummary ? ' / ' : '  ';
  const hintItems = inputHint.split(hintSeparator);
  useManagerInput({
    exiting, active, registering, editorRef: answerTarget === null ? editorRef : answerEditorRef,
    edit: answerTarget === null ? edit : editAnswer, submit, onExit, contentWidth, canApprove,
    abortTurn: () => { const running = latest.current.state?.running; if (running != null) void send({ kind: 'abort_turn', operationId: running.operationId }); },
    abortConfirmation, questionAnswer, summaryApproval, selection, selectTarget,
    abortGoal: (target) => changeGoal('abort', target.goal, true, target.retry), saveAnswer, register, openMenu, summarize,
    onInputUnavailable: () => append(getLabel('manager.inputUnavailableDuringAbort', lang)),
  });
  return <Box flexDirection="column">
    <Text bold wrap="truncate-middle">{assignmentHeading}</Text>
    <Text>{getLabel('manager.counts', lang, { goals: String(goals.filter((goal) => isGoalSelectionCandidate('abort', goal)).length), questions: String(questions.length) })}</Text>
    <TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} />
    {snapshot.connection !== 'connected' && <Text>{getLabel('manager.conversation.disconnected', lang)}</Text>}
    {snapshot.readStatus === 'reading' && <Text>{getLabel('manager.conversation.reading', lang)}</Text>}
    {snapshot.readStatus === 'incomplete' && <Text>{getLabel('manager.conversation.incomplete', lang)}</Text>}
    {state?.interrupted && <Text>{getLabel('manager.conversation.interrupted', lang)}</Text>}
    {selection.selection !== null && <ManagerSelectionDialog selection={selection.selection} bodyText={selection.bodyText} lang={lang} />}
    {answerTarget !== null && selection.selection === null && <ManagerAnswerDialog answerTarget={answerTarget} bodyText={questionAnswer.bodyText} lang={lang} />}
    {abortTarget !== null && selection.selection === null && <ManagerAbortDialog abortTarget={abortTarget.goal} retry={abortTarget.retry} approve={approve} lang={lang} />}
    {summaryVisible && <>
      <ManagerSummaryDialog pending={pending} approve={approve} ja={ja} />
      {canApprove && <Text dimColor>{getLabel('manager.summaryHint', lang)}</Text>}
    </>}
    <ManagerHelp lang={lang} />
    <StatusLine busy={busy} label={summarizing ? getLabel('manager.summaryWorking', lang) : ja ? '処理中' : 'Working'} streamed="" />
    <PromptInput text={visibleEditor.text} cursor={visibleEditor.cursor} contentWidth={contentWidth}
      placeholder={answerTarget === null ? (ja ? 'ゴールを相談してください' : 'Discuss your goal') : (ja ? '回答を入力してください' : 'Enter your answer')}
      hint={inputHint} showHint={false} completions={[]} completionIndex={0}
      disabled={selection.selection !== null || abortTarget !== null || selectingSummary} />
    <Box flexWrap="wrap">{hintItems.map((item, index) => {
      const text = item + (index < hintItems.length - 1 ? hintSeparator : '');
      return <Box key={item} width={measureWidth(text)} flexShrink={0}><Text dimColor>{text}</Text></Box>;
    })}</Box>
  </Box>;
}
