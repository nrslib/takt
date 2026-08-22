import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { toDisplayText } from './displayText.js';
import { resolveEditorKey } from './editorKeys.js';
import {
  applyEditorKey,
  createEditorState,
  type EditorState,
} from './editorState.js';
import { PromptInput } from './PromptInput.js';
import { resolvePromptContentWidth } from './promptLayout.js';

/**
 * One line of text, asked for on its own screen.
 *
 * The exec menus ask for a name, a number, a sentence — questions that carry
 * their own wording ("Assistant> ", "Facet name (custom): "). That wording is
 * drawn above the box rather than inside it: the box keeps its `❯` marker and
 * the layout keeps measuring only the text the user typed.
 */
export interface PromptScreenProps {
  /** The question, as the caller words it. */
  readonly question: string;
  /** What the keys do, including whether an empty answer means anything. */
  readonly hint: string;
  readonly placeholder: string;
  readonly initialText: string;
  /** Null when the user backed out rather than answered. */
  readonly onDone: (answer: string | null) => void;
}

export function PromptScreen({
  question,
  hint,
  placeholder,
  initialText,
  onDone,
}: PromptScreenProps): ReactElement {
  // Ink can deliver several keypresses before React re-renders, so the ref is
  // the authoritative buffer and the state is its render mirror.
  const editorRef = useRef<EditorState>(createEditorState(toDisplayText(initialText)));
  const [editor, setEditorView] = useState<EditorState>(editorRef.current);
  const doneRef = useRef(false);
  const { stdout } = useStdout();
  const contentWidth = resolvePromptContentWidth(stdout?.columns);

  const edit = useCallback((next: EditorState) => {
    editorRef.current = next;
    setEditorView(next);
  }, []);

  const finish = useCallback((answer: string | null) => {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    onDone(answer);
  }, [onDone]);

  useInput((input, key) => {
    if (doneRef.current) {
      return;
    }
    // Backing out is Esc or either interrupt, exactly as the readline editor
    // treats them.
    if (key.escape || (key.ctrl && (input === 'c' || input === 'd'))) {
      finish(null);
      return;
    }
    // Shift+Enter and Option+Enter insert a line break; plain Enter answers.
    if (key.return && (key.shift || key.meta)) {
      edit(applyEditorKey(editorRef.current, { kind: 'newline' }));
      return;
    }
    if (key.return) {
      finish(editorRef.current.text);
      return;
    }
    const editorKey = resolveEditorKey(input, key, contentWidth);
    if (editorKey === null) {
      return;
    }
    edit(applyEditorKey(editorRef.current, editorKey));
  });

  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">{toDisplayText(question)}</Text>
      <PromptInput
        text={editor.text}
        cursor={editor.cursor}
        contentWidth={contentWidth}
        placeholder={placeholder}
        hint={hint}
        completions={[]}
        completionIndex={0}
        disabled={false}
      />
    </Box>
  );
}
