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

export function DirectorView({ client, lang, onExit }: {
  client: Pick<ConversationIpcClient, 'getSnapshot' | 'subscribe' | 'onOutput' | 'submit' | 'refresh' | 'close'>;
  lang: 'ja' | 'en'; onExit(): void;
}) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [editor, setEditor] = useState(() => createEditorState(''));
  const editorRef = useRef(editor);
  const submitting = useRef(false);
  const displayed = useRef(new Set<string>());
  const displayedMessages = useRef(new Set<string>());
  const mounted = useRef(true);
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout.columns ?? 80);
  const width = Math.max(1, columns - 6);
  const append = (message: string, role: TranscriptEntry['role'] = 'assistant'): void => {
    if (mounted.current) setEntries((prior) => [...prior, { role, content: toDisplayText(sanitizeSensitiveText(message)) }]);
  };
  const edit = (next: typeof editor): void => { editorRef.current = next; setEditor(next); };
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
      if (output.kind === 'result' && output.result.kind !== 'goal_registered') append(output.result.message);
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
  usePaste((text) => edit(applyEditorKey(editorRef.current, { kind: 'insert', text })));
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'd')) { onExit(); return; }
    if (key.return && (key.shift || key.meta)) { edit(applyEditorKey(editorRef.current, { kind: 'newline' })); return; }
    if (key.return) {
      const text = editorRef.current.text.trim();
      if (text.length === 0) return;
      if (submitting.current || snapshot.state?.running != null) { append(getLabel('manager.conversation.busy', lang)); return; }
      submitting.current = true;
      edit(commitEditorInput(editorRef.current, text));
      append(text, 'user');
      void client.submit({ kind: 'message', text }, (id) => { displayedMessages.current.add(id); }).then((result) => {
        if (result.kind === 'error') append(result.message);
        else if (result.kind === 'busy') append(getLabel('manager.conversation.busy', lang));
      }).catch((error: unknown) => append(getErrorMessage(error))).finally(() => { submitting.current = false; });
      return;
    }
    const editing = resolveEditorKey(input, key, width);
    if (editing !== null) edit(applyEditorKey(editorRef.current, editing));
  });
  return <Box flexDirection="column" width={columns}>
    <Text bold>director</Text>
    <Text>{getLabel('director.experimentalNotice', lang)}</Text>
    <Text>{getLabel('director.costNotice', lang)}</Text>
    <TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} />
    {snapshot.error !== null && <Text>{toDisplayText(snapshot.error)}</Text>}
    {snapshot.connection !== 'connected' && <Text>{getLabel('manager.conversation.disconnected', lang)}</Text>}
    {snapshot.readStatus !== 'complete' && <Text>{getLabel(`manager.conversation.${snapshot.readStatus === 'reading' ? 'reading' : 'incomplete'}`, lang)}</Text>}
    {snapshot.state?.interrupted && <Text>{getLabel('manager.conversation.interrupted', lang)}</Text>}
    <PromptInput text={editor.text} cursor={editor.cursor} contentWidth={width}
      placeholder={getLabel('director.placeholder', lang)} hint="Enter / Ctrl+C" completions={[]} completionIndex={0} disabled={false} />
  </Box>;
}
