import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { addBookmark, getBookmarkedWorkflows, removeBookmark } from '../../infra/config/global/index.js';
import type { WorkflowDirEntry } from '../../infra/config/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  applyBookmarks,
  buildCategoryWorkflowOptions,
  buildUserDefinedWorkflowOptions,
  buildTopLevelSelectOptions,
  buildWorkflowSelectionItems,
  parseCategorySelection,
  splitEntriesBySource,
  type SelectionOption,
} from './options.js';

function buildTopLevelOptions(entries: WorkflowDirEntry[]): {
  items: ReturnType<typeof buildWorkflowSelectionItems>;
  options: SelectionOption[];
} {
  const { builtinEntries, userDefinedEntries } = splitEntriesBySource(entries);
  const items = buildWorkflowSelectionItems(builtinEntries);
  const options = [
    ...buildTopLevelSelectOptions(items),
    ...buildUserDefinedWorkflowOptions(
      userDefinedEntries.map(({ name, source }) => ({ name, source })),
    ),
  ];

  return { items, options };
}

export async function selectWorkflowFromEntries(
  entries: WorkflowDirEntry[],
): Promise<string | null> {
  if (entries.length === 0) {
    return null;
  }

  const { items, options } = buildTopLevelOptions(entries);

  while (true) {
    const buildTopLevelOptions = (): SelectionOption[] =>
      applyBookmarks(options, getBookmarkedWorkflows());

    const selected = await selectOption<string>('Select workflow:', buildTopLevelOptions(), {
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        if (parseCategorySelection(value)) {
          return null;
        }
        if (key === 'b') {
          addBookmark(value);
          return buildTopLevelOptions();
        }
        if (key === 'r') {
          removeBookmark(value);
          return buildTopLevelOptions();
        }
        return null;
      },
    });
    if (!selected) {
      return null;
    }

    const categoryName = parseCategorySelection(selected);
    if (!categoryName) {
      return selected;
    }

    const categoryOptions = buildCategoryWorkflowOptions(items, categoryName);
    if (!categoryOptions) {
      continue;
    }

    const buildCategoryOptions = (): SelectionOption[] =>
      applyBookmarks(categoryOptions, getBookmarkedWorkflows());

    const workflowSelection = await selectOption<string>(
      `Select workflow in ${sanitizeTerminalText(categoryName)}:`,
      buildCategoryOptions(),
      {
        cancelLabel: '← Go back',
        onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
          if (key === 'b') {
            addBookmark(value);
            return buildCategoryOptions();
          }
          if (key === 'r') {
            removeBookmark(value);
            return buildCategoryOptions();
          }
          return null;
        },
      },
    );

    if (workflowSelection) {
      return workflowSelection;
    }
  }
}
