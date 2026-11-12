import { basename } from 'node:path';
import { Box, Text, useStdout } from 'ink';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { useManagerAbortConfirmation, type ManagerAbortTarget } from './useManagerAbortConfirmation.js';
import { useManagerQuestionAnswer, type SaveManagerAnswer } from './useManagerQuestionAnswer.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import { MAKE_GOAL_COMMAND, useManagerInput } from './useManagerInput.js';
import { ManagerAnswerDialog } from './ManagerAnswerDialog.js';
import { ManagerAbortDialog } from './ManagerAbortDialog.js';
import { ManagerSummaryDialog } from './ManagerSummaryDialog.js';
import { formatPendingSummary } from './summaryDisplay.js';
import { ManagerSelectionDialog } from './ManagerSelectionDialog.js';
import { isGoalSelectionCandidate, useManagerSelection, type ManagerSelectedTarget, type ManagerSelectionCommand } from './useManagerSelection.js';
import { formatGoalName } from './goalDisplay.js';
import type { ManagerExecutionContext } from './startupResolution.js';
import type { ConversationIpcClient } from './conversationIpcClient.js';
import type { ConversationCommand, OperationResult } from './conversationPort.js';
import type { ConversationActivity } from '../../shared/types/conversation-activity.js';
import { MAX_VISIBLE_ROWS, PromptInput } from '../tui/PromptInput.js';
import { resolveSlashCompletions } from '../tui/slashCompletion.js';
import { useSlashCompletion } from '../tui/useSlashCompletion.js';
import { TranscriptView, type TranscriptEntry } from '../tui/TranscriptEntryView.js';
import { StatusLine } from '../tui/StatusLine.js';
import { createEditorState, type EditorState } from '../tui/editorState.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../tui/terminalColors.js';
import { toDisplayText, toSingleLineText } from '../tui/displayText.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { measureWidth } from '../../shared/utils/grapheme.js';
import { formatElapsedTime, truncateStatusText } from '../tui/statusText.js';
import { ToolActivityDisplay } from '../../shared/ui/ToolActivityDisplay.js';
import { ToolActivityView } from '../tui/ToolActivityView.js';
import { createToolActivityViewState, mergeToolActivityTranscript, moveToolActivityView, toggleToolActivityView, toolActivityViewPage,
  type ToolActivityTranscriptRange } from '../tui/toolActivityViewState.js';
import { layoutPromptRows } from '../tui/promptLayout.js';

const MANAGER_COMMANDS = [{ command: MAKE_GOAL_COMMAND, labelKey: 'manager.makeGoalDescription' },
  { command: '/verify', labelKey: 'interactive.commands.verify' }];
const MIN_STATUS_HEADING_WIDTH = 12;

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
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => initialDiagnostics.map((content) => ({ role: 'system', content: toDisplayText(content) })));
  const [approve, setApprove] = useState(false);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<{ operationId: string; generation: number; value: ConversationActivity } | null>(null);
  const [toolView, setToolView] = useState(createToolActivityViewState);
  const displayedTools = useRef<{ turn: string | undefined; rows: ToolActivityTranscriptRange[] }>({ turn: undefined, rows: [] });
  const toolViewTurn = useRef<string | undefined>(undefined);
  const submitting = useRef(0);
  const [summarizing, setSummarizing] = useState(false);
  const summaryOperation = useRef<string | null>(null);
  const active = useRef(false);
  const registering = useRef(false);
  const selected = useRef(false);
  const mounted = useRef(true);
  const exiting = useRef(false);
  const displayed = useRef(new Set<string>());
  const displayedMessages = useRef(new Set<string>());
  const displayedResults = useRef(new Set<string>());
  const displayedSummaries = useRef(new Set<string>());
  const interruptedTurn = useRef<{ operationId: string; generation?: number } | null>(null);
  const clock = useRef<{ operationId: string; generation?: number; startedAt: number } | null>(null);
  const [, tick] = useState(0);
  const lastError = useRef<string | null>(null);
  const pendingAnswers = useRef(new Map<string, { text: string; questionId: string }>());
  const savingAnswer = useRef<{ operationId: string | null } | null>(null);
  const goalOperations = useRef(new Map<string, { kind: 'pause' | 'resume' | 'abort'; goal: ManagerAbortTarget['goal'] }>());
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => stdout.columns);
  const [rows, setRows] = useState(() => stdout.rows);
  useEffect(() => {
    const handleResize = (): void => { setColumns(stdout.columns); setRows(stdout.rows); };
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
  const selection = useManagerSelection();
  const slashCompletion = useSlashCompletion(resolveSlashCompletions(editor.text, lang, { formalSpec: true }, MANAGER_COMMANDS));
  const state = snapshot.state;
  const busy = sending || state?.running != null || (state?.queuedMessageCount ?? 0) > 0;
  const running = state?.running;
  if (running == null) clock.current = null;
  else if (clock.current?.operationId !== running.operationId || clock.current?.generation !== running.generation) {
    clock.current = { operationId: running.operationId, generation: running.generation, startedAt: running.startedAt ?? Date.now() };
  }
  useEffect(() => {
    if (running == null) return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running?.operationId, running?.generation]);
  const currentActivity = snapshot.connection === 'connected' && running?.operationId === activity?.operationId
    && running?.generation === activity?.generation ? activity?.value : undefined;
  const activityLabel = currentActivity?.kind === 'tool' ? sanitizeSensitiveText(toSingleLineText(currentActivity.description ?? currentActivity.tool))
    : currentActivity === undefined ? undefined
    : getLabel(currentActivity.kind === 'thinking' ? 'tui.ui.extendedThinking'
      : currentActivity.kind === 'responding' ? 'tui.ui.responding' : 'tui.ui.thinking', lang);
  useEffect(() => {
    setActivity((current) => snapshot.connection === 'connected' && current?.operationId === running?.operationId
      && current?.generation === running?.generation ? current : null);
  }, [running?.operationId, running?.generation, snapshot.connection]);
  active.current = busy;
  const canApprove = snapshot.connection === 'connected' && snapshot.readStatus === 'complete';
  const append = (content: string, role: TranscriptEntry['role'] = 'system'): void => {
    if (mounted.current) setEntries((previous) => [...previous, { role, content: toDisplayText(sanitizeSensitiveText(content)) }]);
  };
  const send = async (command: ConversationCommand, onAccepted?: (id: string) => void): Promise<string | null> => {
    submitting.current++;
    setSending(true);
    try {
      const result = await client.submit(command, onAccepted);
      if (result.kind === 'accepted') {
        if (result.queuedMessageCount !== undefined) append(getLabel('manager.conversation.queued', lang, { count: String(result.queuedMessageCount) }));
        return result.operationId;
      }
      append(result.kind === 'error' ? result.message : getLabel('manager.conversation.busy', lang));
      if (result.kind === 'error') void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
      return null;
    } catch (error) { append(getErrorMessage(error)); return null; }
    finally { submitting.current--; if (mounted.current) setSending(submitting.current > 0); }
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
  if (currentAssignment.kind === 'daemon') throw new Error('Manager view received a director assignment');
  const goals = snapshot.items.flatMap((item) => item.kind === 'goal' ? [item.goal] : []);
  const questions: PendingQuestion[] = snapshot.items.flatMap((item): PendingQuestion[] => {
    if (item.kind !== 'inquiry') return [];
    const { target, question, objective } = item.inquiry;
    if (target.goalId === null) return [{ ...target, question }];
    if (objective === undefined) throw new Error('Missing inquiry objective');
    return [{ ...target, question, objective }];
  });
  const display = { questions, goals };
  useEffect(() => {
    if (snapshot.connection !== 'connected' || snapshot.readStatus === 'complete') savingAnswer.current = null;
  }, [snapshot.connection, snapshot.readStatus]);
  useEffect(() => {
    if (snapshot.connection !== 'connected' || snapshot.readStatus !== 'complete' || answerTarget === null) return;
    if (!questions.some(({ question }) => question.id === answerTarget.pending.question.id)) {
      clearAnswer(answerTarget.pending.question.id);
      editAnswer(createEditorState(''));
    }
  }, [snapshot.connection, snapshot.readStatus, snapshot.items]);
  useEffect(() => {
    setPending(state?.pending ?? null);
    resetChoice();
  }, [state?.revision, state?.pending]);
  useEffect(() => {
    if (state?.pending == null) return;
    const key = `${state.conversationId}:${state.pending.revision}`;
    if (displayedSummaries.current.has(key)) return;
    const content = formatPendingSummary(state.pending, lang);
    displayedSummaries.current.add(key);
    append(content, 'assistant');
  }, [state?.conversationId, state?.pending, lang]);
  useEffect(() => {
    if (snapshot.error !== null && snapshot.error !== lastError.current) append(snapshot.error);
    lastError.current = snapshot.error;
    for (const item of snapshot.items) {
      if (item.kind !== 'display_event' || displayed.current.has(item.event.id)) continue;
      displayed.current.add(item.event.id);
      append(item.event.message);
    }
    if (snapshot.readStatus === 'complete') selection.refresh(display);
  }, [snapshot.items, snapshot.readStatus, snapshot.error]);
  const showResult = (result: OperationResult, operationId: string): void => {
    if (displayedResults.current.has(operationId)) return;
    displayedResults.current.add(operationId);
    const goalOperation = goalOperations.current.get(operationId);
    goalOperations.current.delete(operationId);
    if (result.kind === 'goal_registered') append(getLabel('manager.goalRegistered', lang, {
      name: formatGoalName(result.goal.objective), id: result.goal.id, branch: result.goal.branch,
    }));
    else {
      const message = goalOperation !== undefined && result.kind === 'notice'
        ? formatGoalName(goalOperation.goal.objective) + '\n' + result.message : result.message;
      append(message, result.kind === 'reply' ? 'assistant' : 'system');
    }
    if (goalOperation?.kind === 'abort') setAbortTarget(result.kind === 'error'
      ? { goal: goalOperation.goal, retry: true } : null);
    if (summaryOperation.current === operationId) {
      if (result.kind === 'reply' && latest.current.state?.pending == null) append(getLabel('manager.goSummaryUnavailable', lang));
      summaryOperation.current = null;
      setSummarizing(false);
    }
    if (result.kind === 'error' && result.answerSaved) append(getLabel('manager.conversation.answer_saved', lang));
    const answer = pendingAnswers.current.get(operationId);
    pendingAnswers.current.delete(operationId);
    if (savingAnswer.current?.operationId === operationId) savingAnswer.current = null;
    if ('answerSaved' in result && result.answerSaved && answer !== undefined) {
      if (clearAnswer(answer.questionId)) editAnswer(createEditorState(''));
      setEntries((previous) => [...previous, { role: 'user', content: toDisplayText(answer.text) }]);
    }
    registering.current = false;
    void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
  };
  useEffect(() => {
    mounted.current = true;
    let observedRunning = client.getSnapshot().state?.running;
    const unsubscribeState = client.subscribe(() => {
      const state = client.getSnapshot().state;
      if (state?.interrupted && state.running === null && observedRunning != null) {
        interruptedTurn.current = { operationId: observedRunning.operationId, generation: observedRunning.generation };
      }
      observedRunning = state?.running;
    });
    const unsubscribe = client.onOutput((output) => {
      if (output.kind === 'user_message') {
        if (!displayedMessages.current.has(output.operationId)) {
          displayedMessages.current.add(output.operationId);
          append(output.message, 'user');
        }
      } else if (output.kind === 'result') {
        setActivity((current) => current?.operationId === output.operationId ? null : current);
        showResult(output.result, output.operationId);
      } else if (output.kind === 'activity') {
        const current = client.getSnapshot();
        const running = current.state?.running;
        if (current.connection === 'connected' && running?.operationId === output.operationId && running.generation === output.generation) {
          setActivity({ operationId: output.operationId, generation: output.generation, value: output.activity });
        }
      } else if (output.kind === 'turn_text') {
        const current = client.getSnapshot();
        const running = current.state?.running;
        const interrupted = interruptedTurn.current;
        if (current.connection === 'connected'
          && !(interrupted?.operationId === output.operationId && interrupted.generation === output.generation)
          && (running == null || running.operationId === output.operationId && running.generation === output.generation)) {
          append(output.message, 'assistant');
        }
      } else if (output.kind === 'progress' || output.kind === 'reply' || output.kind === 'notice') {
        append(output.message, output.kind === 'reply' ? 'assistant' : 'system');
      }
    });
    const timer = setInterval(() => {
      if (latest.current.connection === 'connected' && latest.current.readStatus !== 'reading') {
        void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
      }
    }, 500);
    return () => { mounted.current = false; clearInterval(timer); unsubscribeState(); unsubscribe(); client.close(); };
  }, [client]);
  const register = async (revision: number): Promise<void> => {
    const current = client.getSnapshot();
    if (current.connection !== 'connected' || current.readStatus !== 'complete'
      || registering.current || current.state?.pending?.revision !== revision) return;
    registering.current = true;
    resetChoice();
    if (await send({ kind: 'approve_summary', revision }) === null) registering.current = false;
  };
  const submit = (text: string): void => {
    const summaryRequest = text.trim() === MAKE_GOAL_COMMAND;
    if (!summaryRequest) {
      const content = displayedTools.current.rows.map((range) => range.text.replace(/\n$/u, '') + (range.omitted ? '…' : '')).join('\n');
      if (content !== '') append(content);
      displayedTools.current.rows = [];
      append(text, 'user');
    }
    else setSummarizing(true);
    resetChoice();
    void send({ kind: 'message', text: summaryRequest ? getLabel('manager.goSummaryRequest', lang) : text,
      ...(summaryRequest ? { display: false } : {}) },
      (id) => {
        if (summaryRequest) summaryOperation.current = id;
        else displayedMessages.current.add(id);
      })
      .then((id) => { if (id === null && summaryRequest) setSummarizing(false); });
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
      beginAnswer(target.target, target.onCancel);
    } else void changeGoal(target.kind, target.target);
  };
  const saveAnswer: SaveManagerAnswer = async (target, answer) => {
    if (savingAnswer.current) return;
    const saving: { operationId: string | null } = { operationId: null };
    savingAnswer.current = saving;
    const operationId = await send({ kind: 'answer_question', target: target.goalId === null
      ? { goalId: null, owner: target.owner } : { goalId: target.goalId, repositoryDirectory: target.repositoryDirectory },
      questionId: target.question.id, answer },
    (id) => {
      saving.operationId = id;
      let text = answer.text ?? '';
      if (answer.report !== undefined) {
        const choice = getLabel(`manager.answerChoices.${answer.report}`, lang);
        text = text.trim() === '' ? choice : `${choice}\n${text}`;
      }
      pendingAnswers.current.set(id, { text, questionId: target.question.id });
    });
    if (operationId === null && savingAnswer.current === saving) savingAnswer.current = null;
  };
  const openMenu = (kind: ManagerSelectionCommand): void => {
    if (kind === 'answer' && registering.current) return;
    clearAnswer(); setAbortTarget(null); resetChoice();
    if (!selection.open(kind, display)) append(getLabel('manager.selectionEmpty.' + kind, lang));
    void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
  };
  const visibleEditor = answerTarget === null ? editor : answerEditor;
  const conversationInput = answerTarget === null && selection.selection === null && abortTarget === null;
  const summaryVisible = !registering.current && pending !== null && selection.selection === null && answerTarget === null && abortTarget === null;
  const selectingSummary = summaryVisible && editor.text === '';
  const repositoryDirectories = currentAssignment.repositoryDirectories;
  const startupRepositoryDirectory = assignment.startupRepositoryDirectory ?? cwd;
  const headingRepository = repositoryDirectories.includes(startupRepositoryDirectory) ? startupRepositoryDirectory : repositoryDirectories[0];
  const assignmentHeading = headingRepository === undefined ? getLabel('manager.selectionEmpty.repository', lang)
    : getLabel(repositoryDirectories.length > 1 ? 'manager.assignmentHeadingMultiple' : 'manager.assignmentHeading', lang, {
      name: toSingleLineText(basename(headingRepository)), count: String(repositoryDirectories.length - 1),
    });
  const inputHint = getLabel(selectingSummary
    ? (busy ? 'manager.summaryInputHintWorking' : 'manager.summaryInputHint')
    : 'manager.inputHint', lang);
  const hintSeparator = selectingSummary ? ' / ' : '  ';
  const hintItems = inputHint.split(hintSeparator).map((item, index, items) =>
    item + (index < items.length - 1 ? hintSeparator : ''));
  const statusDetails = getLabel('manager.counts', lang, {
    goals: String(goals.filter((goal) => isGoalSelectionCandidate('abort', goal) && !goal.awaitingHumanMerge).length),
    awaiting: String(goals.filter((goal) => isGoalSelectionCandidate('abort', goal) && goal.awaitingHumanMerge).length),
    questions: String(questions.length),
  });
  const statusWidth = Math.max(1, columns ?? 80);
  const availableHeadingWidth = statusWidth - measureWidth(` | ${statusDetails}`);
  const splitStatus = availableHeadingWidth < MIN_STATUS_HEADING_WIDTH;
  const headingWidth = Math.min(measureWidth(assignmentHeading), splitStatus ? statusWidth : availableHeadingWidth);
  const toolHistory = snapshot.items.find((item) => item.kind === 'tool_history')?.history;
  const toolTurn = running != null ? JSON.stringify([running.operationId, running.generation])
    : toolHistory === undefined ? undefined : JSON.stringify([toolHistory.operationId, toolHistory.generation]);
  const currentToolView = toolViewTurn.current === toolTurn ? toolView : createToolActivityViewState();
  const toolDisplay = useMemo(() => {
    const display = new ToolActivityDisplay('silent', false, () => {}, false);
    if (toolHistory !== undefined && (running == null
      || toolHistory.operationId === running.operationId && toolHistory.generation === running.generation)) {
      display.restore({ ...toolHistory.history, entries: toolHistory.history.entries.filter((entry) =>
        entry.status !== 'running' || !toolHistory.finished && running != null) });
    }
    return display;
  }, [toolHistory, running?.operationId, running?.generation]);
  const toolGroups = toolDisplay.groups();
  const toolLabels = {
    compact: getLabel('tui.ui.toolHistoryCompact', lang), expanded: getLabel('tui.ui.toolHistoryExpanded', lang),
    more: getLabel('tui.ui.toolHistoryMore', lang), end: getLabel('tui.ui.toolHistoryEnd', lang),
    completion: getLabel('tui.ui.toolHistoryCompletion', lang),
  };
  const promptRows = Math.min(MAX_VISIBLE_ROWS, layoutPromptRows(visibleEditor.text, visibleEditor.cursor, contentWidth).rows.length);
  const completionRows = conversationInput ? Math.min(3, slashCompletion.completions.length) : 0;
  let hintRows = 1;
  let hintRowWidth = 0;
  for (const item of hintItems) {
    const width = measureWidth(item);
    if (hintRowWidth > 0 && hintRowWidth + width > statusWidth) {
      hintRows++;
      hintRowWidth = 0;
    }
    hintRowWidth += width;
  }
  const toolHeight = selection.selection !== null || answerTarget !== null || abortTarget !== null || toolGroups.length === 0 ? 0
    : Math.max(0, (rows ?? 24) - promptRows - 2 - completionRows - 1 - hintRows
      - (splitStatus ? 2 : 1) - (summaryVisible ? 6 : 0)
      - Number(snapshot.connection !== 'connected') - Number(snapshot.readStatus !== 'complete') - Number(state?.interrupted === true));
  const toolPage = toolActivityViewPage(toolDisplay, toolGroups, currentToolView, columns ?? 80,
    Math.max(0, toolHeight - 1), toolLabels);
  useEffect(() => {
    if (displayedTools.current.turn !== toolTurn) {
      const content = displayedTools.current.rows.map((range) => range.text.replace(/\n$/u, '') + (range.omitted ? '…' : '')).join('\n');
      if (content !== '') append(content);
      displayedTools.current = { turn: toolTurn, rows: [] };
      toolViewTurn.current = toolTurn;
      setToolView(createToolActivityViewState());
    }
    displayedTools.current.rows = mergeToolActivityTranscript(displayedTools.current.rows, toolPage.transcript ?? []);
  }, [toolTurn, toolPage]);
  useManagerInput({
    exiting, active, registering, savingAnswer, editorRef: answerTarget === null ? editorRef : answerEditorRef,
    edit: answerTarget === null ? edit : editAnswer, submit, onExit, contentWidth, canApprove,
    abortTurn: () => {
      const running = latest.current.state?.running;
      if (running != null) void send({ kind: 'abort_turn', operationId: running.operationId, generation: running.generation }, () => {
        interruptedTurn.current = { operationId: running.operationId, generation: running.generation };
      });
    },
    abortConfirmation, questionAnswer, summaryApproval, selection, selectTarget,
    abortGoal: (target) => changeGoal('abort', target.goal, true, target.retry), saveAnswer, register, openMenu,
    slashCompletion,
    browseTools: (direction) => {
      if (toolHeight <= 0) return;
      setToolView((current) => direction === 'toggle' ? toggleToolActivityView(current)
        : moveToolActivityView(current,
          toolActivityViewPage(toolDisplay, toolGroups, current, columns ?? 80, Math.max(0, toolHeight - 1), toolLabels), direction));
    },
    onInputUnavailable: () => append(getLabel('manager.inputUnavailableDuringAbort', lang)),
  });
  const baseLabel = activityLabel ?? (state?.queuedMessageCount
    ? getLabel('manager.conversation.waiting', lang, { count: String(state.queuedMessageCount) })
    : summarizing ? getLabel('manager.summaryWorking', lang)
    : running?.kind === 'turn' ? getLabel('tui.ui.thinking', lang) : ja ? '処理中' : 'Working');
  const elapsed = clock.current === null ? undefined
    : formatElapsedTime(Math.max(0, Math.floor((Date.now() - (running?.startedAt ?? clock.current.startedAt)) / 1000)));
  const displayedActivity = elapsed === undefined ? baseLabel
    : truncateStatusText(baseLabel, (columns ?? 80) - 2 - measureWidth(elapsed) - 1);
  const statusLabel = elapsed === undefined ? displayedActivity
    : displayedActivity === '' ? elapsed : `${displayedActivity} ${elapsed}`;
  return <Box flexDirection="column">
    <TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
      startupNotice={getLabel('manager.experimentalNotice', lang)} />
    {snapshot.connection !== 'connected' && <Text>{getLabel('manager.conversation.disconnected', lang)}</Text>}
    {snapshot.readStatus === 'reading' && <Text>{getLabel('manager.conversation.reading', lang)}</Text>}
    {snapshot.readStatus === 'incomplete' && <Text>{getLabel('manager.conversation.incomplete', lang)}</Text>}
    {state?.interrupted && <Text>{getLabel('manager.conversation.interrupted', lang)}</Text>}
    {selection.selection !== null && <ManagerSelectionDialog selection={selection.selection} lang={lang} />}
    {answerTarget !== null && selection.selection === null && <ManagerAnswerDialog answerTarget={answerTarget} bodyText={questionAnswer.bodyText} lang={lang} />}
    {abortTarget !== null && selection.selection === null && <ManagerAbortDialog abortTarget={abortTarget.goal} retry={abortTarget.retry} approve={approve} lang={lang} />}
    {summaryVisible && <ManagerSummaryDialog approve={approve} lang={lang} />}
    {toolHeight > 0 && <ToolActivityView page={toolPage} state={currentToolView} labels={toolLabels} height={toolHeight} />}
    <StatusLine busy={busy} label={statusLabel} streamed="" />
    <PromptInput text={visibleEditor.text} cursor={visibleEditor.cursor} contentWidth={contentWidth}
      placeholder={answerTarget === null ? (ja ? 'ゴールを相談してください' : 'Discuss your goal') : (ja ? '回答を入力してください' : 'Enter your answer')}
      hint={inputHint} showHint={false}
      completions={conversationInput ? slashCompletion.completions : []}
      completionIndex={slashCompletion.completionIndex}
      maxVisibleCompletions={3}
      maxVisibleRows={MAX_VISIBLE_ROWS}
      disabled={selection.selection !== null || abortTarget !== null || selectingSummary} />
    <Box flexWrap="wrap">{hintItems.map((text) =>
      <Box key={text} width={measureWidth(text)} flexShrink={0}><Text dimColor>{text}</Text></Box>)}</Box>
    <Box flexDirection={splitStatus ? 'column' : 'row'} width={statusWidth}>
      <Box width={headingWidth} flexShrink={0}><Text dimColor wrap="truncate-middle">{assignmentHeading}</Text></Box>
      <Text dimColor wrap="truncate-end">{splitStatus ? statusDetails : ` | ${statusDetails}`}</Text>
    </Box>
  </Box>;
}
