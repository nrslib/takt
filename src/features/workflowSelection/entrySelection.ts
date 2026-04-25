import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { addBookmark, getBookmarkedWorkflows, removeBookmark } from '../../infra/config/global/index.js';
import type { WorkflowDirEntry } from '../../infra/config/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  applyBookmarks,
  buildCategoryWorkflowOptions,
  buildTopLevelSelectOptions,
  buildWorkflowSelectionItems,
  parseCategorySelection,
  type SelectionOption,
} from './options.js';

async function selectWorkflowFromEntriesWithCategories(
  entries: WorkflowDirEntry[],
): Promise<string | null> {
  if (entries.length === 0) {
    return null;
  }

  const items = buildWorkflowSelectionItems(entries);
  const availableWorkflows = entries.map((entry) => entry.name);
  const hasCategories = items.some((item) => item.type === 'category');

  if (!hasCategories) {
    const baseOptions: SelectionOption[] = availableWorkflows.map((name) => ({
      label: `🎼 ${sanitizeTerminalText(name)}`,
      value: name,
    }));
    const buildFlatOptions = (): SelectionOption[] =>
      applyBookmarks(baseOptions, getBookmarkedWorkflows());

    return selectOption<string>('Select workflow:', buildFlatOptions(), {
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        if (key === 'b') {
          addBookmark(value);
          return buildFlatOptions();
        }
        if (key === 'r') {
          removeBookmark(value);
          return buildFlatOptions();
        }
        return null;
      },
    });
  }

  while (true) {
    const buildTopLevelOptions = (): SelectionOption[] =>
      applyBookmarks(buildTopLevelSelectOptions(items), getBookmarkedWorkflows());

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

export async function selectWorkflowFromEntries(
  entries: WorkflowDirEntry[],
): Promise<string | null> {
  const builtinEntries = entries.filter((entry) => entry.source === 'builtin');
  const customEntries = entries.filter((entry) => entry.source !== 'builtin');

  if (builtinEntries.length > 0 && customEntries.length > 0) {
    const selectedSource = await selectOption<'custom' | 'builtin'>(
      'Select workflow source:',
      [
        { label: `Custom workflows (${customEntries.length})`, value: 'custom' },
        { label: `Builtin workflows (${builtinEntries.length})`, value: 'builtin' },
      ],
    );
    if (!selectedSource) {
      return null;
    }
    return selectWorkflowFromEntriesWithCategories(
      selectedSource === 'custom' ? customEntries : builtinEntries,
    );
  }

  return selectWorkflowFromEntriesWithCategories(
    customEntries.length > 0 ? customEntries : builtinEntries,
  );
}
