import { useManagerImages } from './useManagerImages.js';
import { basename } from 'node:path';
import { Box, Text, useStdout } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { useManagerAbortConfirmation, type ManagerGoalConfirmationTarget } from './useManagerAbortConfirmation.js';
import { useManagerQuestionAnswer, type SaveManagerAnswer } from './useManagerQuestionAnswer.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import { MAKE_GOAL_COMMAND, useManagerInput } from './useManagerInput.js';
import { ManagerAnswerDialog } from './ManagerAnswerDialog.js';
import { ManagerAbortDialog } from './ManagerAbortDialog.js';
import { ManagerSummaryDialog } from './ManagerSummaryDialog.js';
import { formatPendingSummary } from './summaryDisplay.js';
import { ManagerSelectionDialog } from './ManagerSelectionDialog.js';
import { ManagerEpicDialog, formatManagerEpicDetail } from './ManagerEpicDialog.js';
import { layoutQuestionBody } from './questionBodyLayout.js';
import { useManagerEpics } from './useManagerEpics.js';
import { isGoalSelectionCandidate, useManagerSelection, type GoalOperation, type ManagerSelectedTarget, type ManagerSelectionCommand } from './useManagerSelection.js';
import { formatGoalName } from './goalDisplay.js';
import type { ManagerExecutionContext } from './startupResolution.js';
import type { ConversationIpcClient } from './conversationIpcClient.js';
import type { ConversationCommand, OperationResult } from './conversationPort.js';
import { CLEAR_COMMAND } from './conversationCommands.js';
import type { ConversationActivity } from '../../shared/types/conversation-activity.js';
import { MAX_VISIBLE_ROWS, PromptInput } from '../tui/PromptInput.js';
import { layoutPromptRows } from '../tui/promptLayout.js';
import { resolveSlashCompletions } from '../tui/slashCompletion.js';
import { useSlashCompletion } from '../tui/useSlashCompletion.js';
import { TranscriptView, type TranscriptEntry } from '../tui/TranscriptEntryView.js';
import { StatusLine } from '../tui/StatusLine.js';
import { applyEditorKey, createEditorState, type EditorState } from '../tui/editorState.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../tui/terminalColors.js';
import { toDisplayText, toSingleLineText } from '../tui/displayText.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { measureWidth } from '../../shared/utils/grapheme.js';
import { formatElapsedTime, truncateStatusText } from '../tui/statusText.js';
import { ToolActivityView } from '../tui/ToolActivityView.js';
import { MAX_QUEUE_ROWS, QueueView } from '../tui/QueueView.js';
import { MARKER_WIDTH } from '../tui/transcriptOutput.js';
import { ToolActivityDisplayStore, toolTurnKey } from './toolActivityDisplayStore.js';
import { completedToolTranscript, createToolActivityViewState, moveToolActivityView, toggleToolActivityView, toolActivityViewPage } from '../tui/toolActivityViewState.js';
import type { ToolActivityEntry } from '../../shared/tool-activity/types.js';
import { toolActivityGroupSummary } from '../../shared/tool-activity/presentation.js';

const MANAGER_COMMANDS = [{ command: MAKE_GOAL_COMMAND, labelKey: 'manager.makeGoalDescription' },
  { command: '/verify', labelKey: 'interactive.commands.verify' }, { command: CLEAR_COMMAND, labelKey: 'manager.clearDescription' }];
const MIN_STATUS_HEADING_WIDTH = 12;
/** 画面とスクロールバックを消し、カーソルを左上へ戻す。 */
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';

const DEFAULT_MANAGER_REFRESH_INTERVAL_MS = 500;

export function ManagerView({ cwd, lang, client, initialDiagnostics, onExit, assignment, refreshIntervalMs = DEFAULT_MANAGER_REFRESH_INTERVAL_MS }: {
  assignment: ManagerExecutionContext['assignment'];
  cwd: string; lang: 'en' | 'ja';
  client: Pick<ConversationIpcClient, 'getSnapshot' | 'subscribe' | 'onOutput' | 'submit' | 'refresh' | 'close' | 'prepareImage' | 'getImageDirectory'>;
  onExit: () => void; initialDiagnostics: readonly string[];
  /** 接続中の定期 refresh の間隔（ミリ秒）。設定 manager.refresh_interval_ms と環境変数 TAKT_MANAGER_REFRESH_INTERVAL_MS で変更できる。操作直後の refresh は待たずに即時に行う。 */
  refreshIntervalMs?: number;
}): ReactElement {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [toolDisplays] = useState(() => new ToolActivityDisplayStore(client));
  const { display: toolDisplay, ready: toolReady } = useSyncExternalStore(toolDisplays.subscribe, toolDisplays.getSnapshot);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const editorRef = useRef(createEditorState(''));
  const [editor, setEditor] = useState(editorRef.current);
  const answerEditorRef = useRef(createEditorState(''));
  const [answerEditor, setAnswerEditor] = useState(answerEditorRef.current);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => initialDiagnostics.map((content) => ({ role: 'system', content: toDisplayText(content) })));
  const [transcriptGeneration, setTranscriptGeneration] = useState(0);
  const [approve, setApprove] = useState(false);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<{ operationId: string; generation: number; value: ConversationActivity } | null>(null);
  const [toolView, setToolView] = useState(createToolActivityViewState);
  const toolViewTurn = useRef<string | undefined>(undefined);
  const submitting = useRef(0);
  const [summarizing, setSummarizing] = useState(false);
  const summaryOperation = useRef<string | null>(null);
  const clearOperation = useRef<string | null>(null);
  const active = useRef(false);
  const registering = useRef(false);
  const selected = useRef(false);
  const mounted = useRef(true);
  const exiting = useRef(false);
  const displayed = useRef(new Set<string>());
  const displayedMessages = useRef(new Set<string>());
  const displayedResults = useRef(new Set<string>());
  const handledResults = useRef(new Set<string>());
  const displayedSummaries = useRef(new Set<string>());
  const interruptedTurn = useRef<{ operationId: string; generation?: number } | null>(null);
  const clock = useRef<{ operationId: string; generation?: number; startedAt: number } | null>(null);
  const [, tick] = useState(0);
  const lastError = useRef<string | null>(null);
  const pendingAnswers = useRef(new Map<string, { text: string; questionId: string }>());
  const savingAnswer = useRef<{ operationId: string | null } | null>(null);
  const goalOperations = useRef(new Map<string, { kind: GoalOperation; goal: ManagerGoalConfirmationTarget['goal'] }>());
  const { stdout, write } = useStdout();
  const [columns, setColumns] = useState(() => stdout.columns);
  const [rows, setRows] = useState(() => stdout.rows);
  const toolColumns = useRef(columns);
  toolColumns.current = columns;
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
  const appendUserMessage = (message: { operationId: string; message: string }): void => {
    if (displayedMessages.current.has(message.operationId)) return;
    displayedMessages.current.add(message.operationId);
    append(message.message, 'user');
  };
  const committedTools = useRef(new Set<string>());
  const appendTool = (entry: ToolActivityEntry): void => {
    const key = JSON.stringify([entry.context?.operationId, entry.context?.generation, entry.key]);
    if (committedTools.current.has(key) || entry.status === 'running') return;
    committedTools.current.add(key);
    const content = completedToolTranscript(entry, toolColumns.current ?? 80, {
      compact: '', expanded: '', more: getLabel('tui.ui.toolHistoryMore', lang), end: '', completion: getLabel('tui.ui.toolHistoryCompletion', lang),
      running: getLabel('tui.ui.toolHistoryRunning', lang),
    });
    if (mounted.current) setEntries((previous) => [...previous, { role: 'tool', content: toDisplayText(content) }]);
  };
  const send = async (command: ConversationCommand, onAccepted?: (id: string) => void): Promise<string | null> => {
    submitting.current++;
    setSending(true);
    try {
      const result = await client.submit(command, onAccepted);
      // A queued message waits in the queue area above the input, not in the log:
      // a line here would land in the middle of the turn that is still running.
      if (result.kind === 'accepted') return result.operationId;
      if (command.kind === 'message' && command.display !== false) append(command.text, 'user');
      append(result.kind === 'error' ? result.message : getLabel('manager.conversation.busy', lang));
      if (result.kind === 'error') void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
      return null;
    } catch (error) {
      // Acceptance may have succeeded before the connection failed. The next
      // snapshot supplies its operationId; an anonymous local echo would duplicate it.
      append(getErrorMessage(error)); return null;
    }
    finally { submitting.current--; if (mounted.current) setSending(submitting.current > 0); }
  };
  const summaryApproval = useManagerSummaryApproval({ selected, setApprove, resetChoice,
    dismissSummary: async (revision) => {
      const conversationId = client.getSnapshot().state?.conversationId;
      if (conversationId === undefined) return;
      if (await send({ kind: 'dismiss_summary', revision, conversationId }) === null) {
        setPending(client.getSnapshot().state?.pending ?? null);
      }
    } });
  const { pending, setPending } = summaryApproval;
  const edit = (next: EditorState): void => { editorRef.current = next; setEditor(next); };
  const editAnswer = (next: EditorState): void => { answerEditorRef.current = next; setAnswerEditor(next); };
  const currentAssignment = snapshot.items.find((item) => item.kind === 'assignment')?.assignment ?? assignment;
  if (currentAssignment.kind === 'daemon') throw new Error('Manager view received a director assignment');
  const epicItems = snapshot.items.flatMap((item) => item.kind === 'epic' ? [item] : []);
  const epics = useManagerEpics(epicItems);
  const epicsOpen = epics.navigation !== null;
  const epicDetailLines = epics.navigation?.kind !== 'detail' || epics.selected === undefined
    ? [] : formatManagerEpicDetail(epics.selected, lang, bodyWidth);
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
  /** 結果を会話ログへ一度だけ積む。ライブの配送とスナップショットからの復元で同じ表示にする。 */
  const appendResult = (result: OperationResult, operationId: string, goal?: ManagerGoalConfirmationTarget['goal']): void => {
    if (displayedResults.current.has(operationId)) return;
    displayedResults.current.add(operationId);
    // 保存済みの結果がライブより先に届いても消すように、表示の入口で判定する。
    if (clearOperation.current === operationId && result.kind === 'notice' && mounted.current) {
      // Static は書き出した行を端末に残し、何件目まで書いたかも覚えている。配列を空にするだけでは
      // 前の会話が画面に残り、続く通知も書かれないため、端末を消してから Static を作り直す。
      // 消去は新しい Static が書き出す前に済ませる必要があるので、描画後の Effect ではなくここで行う。
      if (stdout.isTTY) write(CLEAR_TERMINAL);
      setEntries([]);
      setTranscriptGeneration((generation) => generation + 1);
    }
    if (result.kind === 'goal_registered') append(getLabel('manager.goalRegistered', lang, {
      name: formatGoalName(result.goal.objective), id: result.goal.id, branch: result.goal.branch,
    }));
    else {
      const message = goal !== undefined && result.kind === 'notice'
        ? formatGoalName(goal.objective) + '\n' + result.message : result.message;
      append(message, result.kind === 'reply' ? 'assistant' : 'system');
    }
    if (result.kind === 'error' && result.answerSaved) append(getLabel('manager.conversation.answer_saved', lang));
  };
  const showResult = (result: OperationResult, operationId: string): void => {
    // 保存済みの結果がスナップショットから先に表示されていても、ライブの結果を受けた後処理は省かない。
    if (handledResults.current.has(operationId)) return;
    handledResults.current.add(operationId);
    const goalOperation = goalOperations.current.get(operationId);
    appendResult(result, operationId, goalOperation?.goal);
    goalOperations.current.delete(operationId);
    if (goalOperation?.kind === 'abort') setAbortTarget(result.kind === 'error'
      ? { goal: goalOperation.goal, retry: true, kind: 'abort' } : null);
    if (summaryOperation.current === operationId) {
      if (result.kind === 'reply' && latest.current.state?.pending == null) append(getLabel('manager.goSummaryUnavailable', lang));
      summaryOperation.current = null;
      setSummarizing(false);
    }
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
    const observeState = (): void => {
      const current = client.getSnapshot();
      if (current.connection === 'connected' && current.readStatus === 'complete') {
        for (const item of current.items) {
          if (item.kind === 'user_message') {
            if (!item.pending || current.state?.running?.operationId === item.operationId) appendUserMessage(item);
          } else if (item.kind === 'tool_history') {
            for (const entry of item.history.history.entries) appendTool(entry);
          } else if (item.kind === 'turn_result') appendResult(item.result, item.operationId);
        }
      }
      const state = current.state;
      if (state?.interrupted && state.running === null && observedRunning != null) {
        interruptedTurn.current = { operationId: observedRunning.operationId, generation: observedRunning.generation };
      }
      observedRunning = state?.running;
    };
    observeState();
    const unsubscribeState = client.subscribe(observeState);
    const unsubscribe = client.onOutput((output) => {
      if (output.kind === 'user_message') {
        appendUserMessage(output);
      } else if (output.kind === 'tool_completed') {
        if (toolDisplays.getSnapshot().ready) appendTool(output.entry);
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
    }, refreshIntervalMs);
    return () => { mounted.current = false; clearInterval(timer); unsubscribeState(); unsubscribe(); client.close(); };
  }, [client]);
  const register = async (revision: number): Promise<void> => {
    const current = client.getSnapshot();
    if (current.connection !== 'connected' || current.readStatus !== 'complete'
      || registering.current || current.state?.pending?.revision !== revision) return;
    const conversationId = current.state.conversationId;
    registering.current = true;
    resetChoice();
    if (await send({ kind: 'approve_summary', revision, conversationId }) === null) registering.current = false;
  };
  const submit = (text: string): void => {
    const summaryRequest = text.trim() === MAKE_GOAL_COMMAND;
    if (summaryRequest) setSummarizing(true);
    resetChoice();
    const imageAttachmentIds = images.ids(text);
    void send({ kind: 'message', ...(imageAttachmentIds.length === 0 ? {} : { imageAttachmentIds }), text: summaryRequest ? getLabel('manager.goSummaryRequest', lang) : text,
      ...(summaryRequest ? { display: false, requestProposal: true } : {}) },
      (id) => {
        if (summaryRequest) summaryOperation.current = id;
        if (text.trim() === CLEAR_COMMAND) clearOperation.current = id;
      })
      .then((id) => { if (id === null && summaryRequest) setSummarizing(false); });
  };
  const changeGoal = async (kind: GoalOperation, target: ManagerGoalConfirmationTarget['goal'], confirmed = false, retry = false): Promise<void> => {
    const current = retry ? target : goals.find((goal) => goal.id === target.id && isGoalSelectionCandidate(kind, goal));
    if (current === undefined) {
      append(getLabel('manager.selectionChanged', lang));
      // 確認の途中で対象が消えたら、確認を閉じないと通常の入力に戻れない。
      if (confirmed) { setAbortTarget(null); resetChoice(); }
      return;
    }
    if ((kind === 'abort' || kind === 'delete') && !confirmed) { setAbortTarget({ goal: current, retry: false, kind }); return; }
    await send({ kind: `${kind}_goal`, goalId: current.id }, (id) => {
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
    epics.close();
    clearAnswer(); setAbortTarget(null); resetChoice();
    if (!selection.open(kind, display)) append(getLabel('manager.selectionEmpty.' + kind, lang));
    void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
  };
  const openEpics = (): void => {
    clearAnswer();
    if (!epicsOpen) setAbortTarget(null);
    resetChoice(); selection.close(); epics.open();
    void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
  };
  const visibleEditor = answerTarget === null ? editor : answerEditor;
  const conversationInput = !epicsOpen && answerTarget === null && selection.selection === null && abortTarget === null;
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const images = useManagerImages({ lang, client, enabled: conversationInput && !exiting.current,
    insert: (text) => { edit(applyEditorKey(editorRef.current, { kind: 'insert', text })); slashCompletion.reset(); },
    notice: setImageNotice,
  });
  const summaryVisible = !epicsOpen && !registering.current && pending !== null && selection.selection === null && answerTarget === null && abortTarget === null;
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
  const epicTitleLines = epics.navigation === null ? [] : layoutQuestionBody(getLabel(
    epics.navigation.kind === 'list' ? 'manager.epics.listTitle' : 'manager.epics.detailTitle', lang), bodyWidth);
  const epicHintLines = epics.navigation === null ? [] : layoutQuestionBody(getLabel(
    epics.navigation.kind === 'list' ? 'manager.epics.listHint' : 'manager.epics.detailHint', lang), bodyWidth);
  const noticeMessages = [
    ...(snapshot.connection === 'connected' ? [] : [getLabel('manager.conversation.disconnected', lang)]),
    ...(snapshot.readStatus === 'reading' ? [getLabel('manager.conversation.reading', lang)] : []),
    ...(snapshot.readStatus === 'incomplete' ? [getLabel('manager.conversation.incomplete', lang)] : []),
    ...(state?.interrupted ? [getLabel('manager.conversation.interrupted', lang)] : []),
  ];
  const epicNoticeLines = epicsOpen ? noticeMessages.flatMap((text) => layoutQuestionBody(text, statusWidth)) : [];
  const epicFooterLines: string[] = [];
  if (epicsOpen) {
    let line = '';
    for (const item of hintItems) {
      if (line !== '' && measureWidth(line + item) > statusWidth) {
        epicFooterLines.push(...layoutQuestionBody(line, statusWidth));
        line = '';
      }
      line += item;
    }
    epicFooterLines.push(...layoutQuestionBody(line, statusWidth));
  }
  // Reserve dialog/prompt borders, status/footer rows and Ink's final line break.
  const epicChromeRows = 2 + epicTitleLines.length + epicHintLines.length + epicNoticeLines.length
    + 1 + 2 + epicFooterLines.length + (splitStatus ? 2 : 1) + 1;
  const minimumEpicRows = epics.navigation?.kind === 'list' ? 2 : 1;
  const epicPromptRows = Math.max(1, Math.min(MAX_VISIBLE_ROWS,
    epicsOpen ? layoutPromptRows(visibleEditor.text, visibleEditor.cursor, contentWidth).rows.length : MAX_VISIBLE_ROWS,
    (rows ?? 24) - epicChromeRows - minimumEpicRows));
  const epicPageRows = Math.max(minimumEpicRows, (rows ?? 24) - epicChromeRows - epicPromptRows);
  const toolContext = toolDisplay.history.entries().at(-1)?.context;
  const toolTurn = running != null ? toolTurnKey(running) : toolContext?.operationId === undefined ? undefined
    : toolTurnKey({ operationId: toolContext.operationId, generation: toolContext.generation });
  const currentToolView = toolViewTurn.current === toolTurn ? toolView : createToolActivityViewState();
  const allToolGroups = toolReady ? toolDisplay.groups() : [];
  const toolGroups = currentToolView.expanded ? allToolGroups : allToolGroups.flatMap((group) => {
    const entries = group.entries.filter((entry) => entry.status === 'running');
    return entries.length === 0 ? [] : [{ ...group, summary: toolActivityGroupSummary(entries[0]!, entries.length), entries }];
  });
  const toolLabels = {
    compact: getLabel('manager.toolHistoryCompact', lang), expanded: getLabel('manager.toolHistoryExpanded', lang),
    more: getLabel('tui.ui.toolHistoryMore', lang), end: getLabel('tui.ui.toolHistoryEnd', lang),
    completion: getLabel('tui.ui.toolHistoryCompletion', lang), running: getLabel('tui.ui.toolHistoryRunning', lang),
  };
  const toolPageColumns = (columns ?? 80) - MARKER_WIDTH;
  const queuedMessages = snapshot.items.flatMap((item) => item.kind === 'user_message' && item.pending
    && item.operationId !== running?.operationId ? [item.message] : []);
  const queueRows = conversationInput && queuedMessages.length > 0
    ? 1 + Math.min(MAX_QUEUE_ROWS, queuedMessages.length) : 0;
  const hiddenQueued = queuedMessages.length - Math.max(0, queueRows - 1);
  const queueHeading = [getLabel('tui.ui.queuedCount', lang, { count: String(queuedMessages.length) }),
    ...(hiddenQueued > 0 ? [getLabel('tui.ui.queuedMore', lang, { count: String(hiddenQueued) })] : [])].join('  ');
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
  const toolContentHeight = epicsOpen || selection.selection !== null || answerTarget !== null || abortTarget !== null ? 0
    : Math.max(0, (rows ?? 24) - promptRows - 2 - completionRows - 1 - hintRows - queueRows
      - (splitStatus ? 2 : 1) - (summaryVisible ? 6 : 0)
      - Number(snapshot.connection !== 'connected') - Number(snapshot.readStatus !== 'complete') - Number(state?.interrupted === true));
  const toolHeight = !toolReady || allToolGroups.length === 0 ? 0
    : toolGroups.length === 0 ? Math.min(1, toolContentHeight) : toolContentHeight;
  const toolPage = toolActivityViewPage(toolDisplay, toolGroups, currentToolView, toolPageColumns,
    Math.max(0, toolHeight - 1), toolLabels);
  useEffect(() => {
    if (toolViewTurn.current === toolTurn) return;
    toolViewTurn.current = toolTurn;
    setToolView(createToolActivityViewState());
  }, [toolTurn]);
  useManagerInput({
    exiting, active, registering, savingAnswer, editorRef: answerTarget === null ? editorRef : answerEditorRef,
    edit: answerTarget === null ? edit : editAnswer, submit, images,
    onExit: () => { void images.stop().then(onExit); }, contentWidth, canApprove,
    abortTurn: () => {
      const running = latest.current.state?.running;
      if (running != null) void send({ kind: 'abort_turn', operationId: running.operationId, generation: running.generation }, () => {
        interruptedTurn.current = { operationId: running.operationId, generation: running.generation };
      });
    },
    abortConfirmation, questionAnswer, summaryApproval, selection, selectTarget,
    confirmGoalOperation: (target) => changeGoal(target.kind, target.goal, true, target.retry), saveAnswer, register, openMenu,
    epicsOpen, openEpics,
    handleEpicInput: (key) => epics.handleInput(key, Math.max(0, epicDetailLines.length - epicPageRows), epicPageRows),
    slashCompletion,
    browseTools: (direction) => {
      if (toolHeight <= 0) return;
      setToolView((current) => direction === 'toggle' ? toggleToolActivityView(current)
        : moveToolActivityView(current,
          toolActivityViewPage(toolDisplay, toolGroups, current, toolPageColumns, Math.max(0, toolHeight - 1), toolLabels), direction));
    },
    onInputUnavailable: (confirming) => append(getLabel(confirming === 'delete'
      ? 'manager.inputUnavailableDuringDelete' : 'manager.inputUnavailableDuringAbort', lang)),
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
    <TranscriptView key={transcriptGeneration} entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
      startupNotice={getLabel('manager.experimentalNotice', lang)} />
    {epicsOpen ? epicNoticeLines.length > 0 && <Text wrap="truncate-end">{epicNoticeLines.join('\n')}</Text>
      : noticeMessages.map((text) => <Text key={text}>{text}</Text>)}
    {epics.navigation !== null && <ManagerEpicDialog navigation={epics.navigation} epics={epicItems} index={epics.index}
      detailLines={epicDetailLines} pageRows={epicPageRows} titleLines={epicTitleLines} hintLines={epicHintLines}
      lang={lang} workspace={currentAssignment.kind === 'workspace'} />}
    {selection.selection !== null && <ManagerSelectionDialog selection={selection.selection} lang={lang} />}
    {answerTarget !== null && selection.selection === null && <ManagerAnswerDialog answerTarget={answerTarget} bodyText={questionAnswer.bodyText} lang={lang} />}
    {!epicsOpen && abortTarget !== null && selection.selection === null && <ManagerAbortDialog abortTarget={abortTarget} approve={approve} lang={lang} />}
    {summaryVisible && <ManagerSummaryDialog approve={approve} lang={lang} />}
    {!epicsOpen && toolHeight > 0 && <ToolActivityView page={toolPage} state={currentToolView} labels={toolLabels} height={toolHeight} />}
    {imageNotice !== null && <Text color="red">{imageNotice}</Text>}
    <StatusLine busy={busy} label={statusLabel} streamed="" />
    {queueRows > 0 && <QueueView heading={queueHeading}
      lines={queuedMessages.slice(0, queueRows - 1).map((message) => sanitizeSensitiveText(message))} />}
    <PromptInput text={visibleEditor.text} cursor={visibleEditor.cursor} contentWidth={contentWidth}
      placeholder={answerTarget === null ? (ja ? 'ゴールを相談してください' : 'Discuss your goal') : (ja ? '回答を入力してください' : 'Enter your answer')}
      hint={inputHint} showHint={false}
      maxVisibleRows={epicsOpen ? epicPromptRows : undefined}
      completions={conversationInput ? slashCompletion.completions : []}
      completionIndex={slashCompletion.completionIndex}
      maxVisibleCompletions={3}
      disabled={epicsOpen || selection.selection !== null || abortTarget !== null || selectingSummary} />
    {epicsOpen ? <Text dimColor wrap="truncate-end">{epicFooterLines.join('\n')}</Text> : <Box flexWrap="wrap">{hintItems.map((item) =>
      <Box key={item} width={measureWidth(item)} flexShrink={0}><Text dimColor>{item}</Text></Box>,
    )}</Box>}
    <Box flexDirection={splitStatus ? 'column' : 'row'} width={statusWidth}>
      <Box width={headingWidth} flexShrink={0}><Text dimColor wrap="truncate-middle">{assignmentHeading}</Text></Box>
      <Text dimColor wrap="truncate-end">{splitStatus ? statusDetails : ` | ${statusDetails}`}</Text>
    </Box>
  </Box>;
}
