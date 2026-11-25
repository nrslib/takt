import { Box, Text, useInput, usePaste, useStdout } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationIpcClient } from '../manager/conversationIpcClient.js';
import { PromptInput } from '../tui/PromptInput.js';
import { TranscriptView, type TranscriptEntry } from '../tui/TranscriptEntryView.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../tui/terminalColors.js';
import { createEditorState, applyEditorKey, commitEditorInput } from '../tui/editorState.js';
import { resolveEditorKey } from '../tui/editorKeys.js';
import { toDisplayText } from '../tui/displayText.js';
import { getLabel } from '../../shared/i18n/index.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { useManagerQuestionAnswer } from '../manager/useManagerQuestionAnswer.js';
import { useManagerSelection } from '../manager/useManagerSelection.js';
import { ManagerAnswerDialog } from '../manager/ManagerAnswerDialog.js';
import { ManagerSelectionDialog } from '../manager/ManagerSelectionDialog.js';
import type { PendingQuestion } from '../manager/inquiryAnswer.js';
import { ManagerSummaryDialog } from '../manager/ManagerSummaryDialog.js';
import { formatPendingSummary } from '../manager/summaryDisplay.js';

export function DirectorView({ client, lang, onExit }: {
  client: Pick<ConversationIpcClient, 'getSnapshot' | 'subscribe' | 'onOutput' | 'submit' | 'refresh' | 'close'>;
  lang: 'ja' | 'en'; onExit(): void;
}) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [editor, setEditor] = useState(() => createEditorState(''));
  const editorRef = useRef(editor);
  const displayed = useRef(new Set<string>());
  const displayedMessages = useRef(new Set<string>());
  const mounted = useRef(true);
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout.columns ?? 80);
  const width = Math.max(1, columns - 6);
  const questionAnswer = useManagerQuestionAnswer(width);
  const selection = useManagerSelection();
  const savingAnswer = useRef(false);
  const submittingProposal = useRef(false);
  const pending = snapshot.state?.pending;
  const [proposalChoice, setProposalChoice] = useState<{ revision: number; approve: boolean } | null>(null);
  const proposalChoiceRef = useRef(proposalChoice);
  const approve = proposalChoice?.revision === pending?.revision && proposalChoice?.approve === true;
  const questions: PendingQuestion[] = snapshot.items.flatMap((item): PendingQuestion[] => {
    if (item.kind !== 'inquiry' || item.inquiry.question.status !== 'pending' || item.inquiry.question.recipient !== 'human') return [];
    const { target, question, objective } = item.inquiry;
    if (target.goalId === null) return [];
    if (objective === undefined) throw new Error('Missing inquiry objective');
    return [{ ...target, question, objective }];
  });
  const append = (message: string, role: TranscriptEntry['role'] = 'assistant'): void => {
    if (mounted.current) setEntries((prior) => [...prior, { role, content: toDisplayText(sanitizeSensitiveText(message)) }]);
  };
  const edit = (next: typeof editor): void => { editorRef.current = next; setEditor(next); };
  useEffect(() => {
    selection.refresh({ questions, goals: [] });
    const target = questionAnswer.answerTarget?.pending;
    if (target !== undefined && !questions.some((entry) => entry.question.id === target.question.id
      && entry.goalId === target.goalId && entry.goalId !== null && target.goalId !== null
      && entry.repositoryDirectory === target.repositoryDirectory)) {
      questionAnswer.clearAnswer(); edit(createEditorState(''));
    }
  }, [snapshot.items]);
  useEffect(() => {
    const resized = (): void => setColumns(stdout.columns ?? 80);
    stdout.on('resize', resized);
    return () => { stdout.off('resize', resized); };
  }, [stdout]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = client.onOutput((output) => {
      if (output.kind === 'user_message' && !displayedMessages.current.has(output.operationId)) {
        displayedMessages.current.add(output.operationId);
        append(output.message, 'user');
      }
      if (output.kind === 'result') append(output.result.kind === 'goal_registered'
        ? getLabel('manager.goalRegistered', lang, { name: output.result.goal.objective, id: output.result.goal.id, branch: output.result.goal.branch })
        : output.result.message);
      if (output.kind === 'notice') {
        if (!displayed.current.has(output.id)) { displayed.current.add(output.id); append(output.message); }
      }
      if (output.kind === 'progress' || output.kind === 'reply') append(output.message);
    });
    const timer = setInterval(() => {
      if (client.getSnapshot().connection === 'connected') void client.refresh().catch((error: unknown) => append(getErrorMessage(error)));
    }, 500);
    return () => { mounted.current = false; clearInterval(timer); unsubscribe(); client.close(); };
  }, [client]);
  useEffect(() => {
    for (const item of snapshot.items) {
      if (item.kind === 'display_event' && !displayed.current.has(item.event.id)) {
        displayed.current.add(item.event.id); append(item.event.message);
      }
    }
  }, [snapshot.items]);
  usePaste((text) => edit(applyEditorKey(editorRef.current, { kind: 'paste', text })));
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'd')) { onExit(); return; }
    if (selection.selection !== null) {
      selection.handleInput(key, (selected) => {
        if (selected.kind === 'answer') { questionAnswer.beginAnswer(selected.target, selected.onCancel); edit(createEditorState('')); }
      });
      return;
    }
    if (questionAnswer.answerTarget !== null) {
      if (questionAnswer.handleNavigation(key, editorRef)) return;
      if (questionAnswer.handleInput(key, key.return, editorRef, async (target, answer) => {
        if (savingAnswer.current || target.goalId === null) return;
        savingAnswer.current = true;
        try {
          const result = await client.submit({ kind: 'answer_question', target: { goalId: target.goalId, repositoryDirectory: target.repositoryDirectory },
            questionId: target.question.id, answer });
          if (result.kind === 'error') append(result.message);
          else { questionAnswer.clearAnswer(); edit(createEditorState('')); await client.refresh(); }
        } catch (error) { append(getErrorMessage(error)); }
        finally { savingAnswer.current = false; }
      })) return;
      const editing = resolveEditorKey(input, key, width);
      if (editing !== null) edit(applyEditorKey(editorRef.current, editing));
      return;
    }
    if (key.ctrl && input === 'r') {
      if (!selection.open('answer', { questions, goals: [] })) append(getLabel('manager.selectionEmpty.answer', lang));
      return;
    }
    if (pending != null && editorRef.current.text.length === 0 && (key.upArrow || key.downArrow || key.return || key.escape)) {
      if (key.upArrow || key.downArrow) {
        proposalChoiceRef.current = { revision: pending.revision, approve: key.upArrow };
        setProposalChoice(proposalChoiceRef.current);
        return;
      }
      const current = client.getSnapshot();
      if (submittingProposal.current || current.connection !== 'connected' || current.readStatus !== 'complete'
        || current.state?.running != null || current.state?.pending?.revision !== pending.revision) return;
      submittingProposal.current = true;
      const chosen = proposalChoiceRef.current;
      void client.submit(chosen?.revision === pending.revision && chosen.approve && !key.escape
        ? { kind: 'approve_summary', revision: pending.revision, conversationId: current.state.conversationId }
        : { kind: 'dismiss_summary', revision: pending.revision, conversationId: current.state.conversationId }).then((result) => {
        if (result.kind === 'error') append(result.message);
      }).catch((error: unknown) => append(getErrorMessage(error))).finally(() => { submittingProposal.current = false; });
      return;
    }
    if (key.escape) {
      const running = snapshot.state?.running;
      if (running !== undefined && running !== null) void client.submit({ kind: 'abort_turn', operationId: running.operationId, generation: running.generation })
        .then((result) => { if (result.kind === 'error') append(result.message); })
        .catch((error: unknown) => append(getErrorMessage(error)));
      return;
    }
    if (key.return && (key.shift || key.meta)) { edit(applyEditorKey(editorRef.current, { kind: 'newline' })); return; }
    if (key.return) {
      const text = editorRef.current.text.trim();
      if (text.length === 0) return;
      edit(commitEditorInput(editorRef.current, text));
      append(text, 'user');
      void client.submit({ kind: 'message', text }, (id) => { displayedMessages.current.add(id); }).then((result) => {
        if (result.kind === 'error') append(result.message);
        else if (result.queuedMessageCount !== undefined) append(getLabel('manager.conversation.queued', lang, { count: String(result.queuedMessageCount) }));
      }).catch((error: unknown) => append(getErrorMessage(error)));
      return;
    }
    const editing = resolveEditorKey(input, key, width);
    if (editing !== null) edit(applyEditorKey(editorRef.current, editing));
  });
  return <Box flexDirection="column" width={columns}>
    <Text bold>director</Text>
    <Text>{getLabel('director.experimentalNotice', lang)}</Text>
    <Text>{getLabel('director.costNotice', lang)}</Text>
    <Text>{getLabel('director.pendingQuestions', lang, { count: String(questions.length) })}</Text>
    <TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} />
    {pending != null && <Text>{formatPendingSummary(pending, lang)}</Text>}
    {pending != null && selection.selection === null && questionAnswer.answerTarget === null && <ManagerSummaryDialog approve={approve} lang={lang} />}
    {selection.selection !== null && <ManagerSelectionDialog selection={selection.selection} lang={lang} />}
    {questionAnswer.answerTarget !== null && selection.selection === null && <ManagerAnswerDialog answerTarget={questionAnswer.answerTarget} bodyText={questionAnswer.bodyText} lang={lang} />}
    {snapshot.error !== null && <Text>{toDisplayText(snapshot.error)}</Text>}
    {snapshot.connection !== 'connected' && <Text>{getLabel('manager.conversation.disconnected', lang)}</Text>}
    {snapshot.readStatus !== 'complete' && <Text>{getLabel(`manager.conversation.${snapshot.readStatus === 'reading' ? 'reading' : 'incomplete'}`, lang)}</Text>}
    {snapshot.state?.interrupted && <Text>{getLabel('manager.conversation.interrupted', lang)}</Text>}
    {snapshot.state?.queuedMessageCount !== undefined && <Text>{getLabel('manager.conversation.waiting', lang, { count: String(snapshot.state.queuedMessageCount) })}</Text>}
    <PromptInput text={editor.text} cursor={editor.cursor} contentWidth={width}
      placeholder={getLabel('director.placeholder', lang)} hint={getLabel('director.inputHint', lang)} completions={[]} completionIndex={0} disabled={selection.selection !== null} />
  </Box>;
}
