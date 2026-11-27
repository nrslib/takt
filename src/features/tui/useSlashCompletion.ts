import { useCallback, useState } from 'react';
import type { Key } from 'ink';
import type { SlashCompletion } from './slashCompletion.js';

export function useSlashCompletion(candidates: readonly SlashCompletion[]) {
  const [completionIndex, setCompletionIndex] = useState(0);
  const [hidden, setHidden] = useState(false);
  const completions = hidden ? [] : candidates;
  const reset = useCallback((): void => {
    setCompletionIndex(0);
    setHidden(false);
  }, []);
  const handleInput = (key: Key, complete: (text: string) => void): boolean => {
    if (completions.length === 0) return false;
    if (key.escape) setHidden(true);
    else if (key.downArrow) setCompletionIndex((index) => (index + 1) % completions.length);
    else if (key.upArrow) setCompletionIndex((index) => (index + completions.length - 1) % completions.length);
    else if (key.tab) {
      const selected = completions[completionIndex];
      if (selected !== undefined) complete(`${selected.command} `);
    } else return false;
    return true;
  };
  return { completions, completionIndex, reset, handleInput };
}
