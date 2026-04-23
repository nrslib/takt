import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { addBookmark, getBookmarkedWorkflows, removeBookmark } from '../../infra/config/global/index.js';
import { info } from '../../shared/ui/index.js';
import { applyBookmarks, type SelectionOption } from './options.js';

export async function selectFlatWorkflowOptions(
  options: SelectionOption[],
  emptyMessage: string,
): Promise<string | null> {
  if (options.length === 0) {
    info(emptyMessage);
    return null;
  }

  const buildOptions = (): SelectionOption[] =>
    applyBookmarks(options, getBookmarkedWorkflows());

  return selectOption<string>('Select workflow:', buildOptions(), {
    onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
      if (key === 'b') {
        addBookmark(value);
        return buildOptions();
      }
      if (key === 'r') {
        removeBookmark(value);
        return buildOptions();
      }
      return null;
    },
  });
}
