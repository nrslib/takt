import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { addBookmark, getBookmarkedWorkflows, removeBookmark } from '../../infra/config/global/index.js';
import type { WorkflowDirEntry } from '../../infra/config/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  applyBookmarks,
  buildCategoryWorkflowOptions,
  buildUserDefinedWorkflowOptions,
  buildWorkflowOptionLabel,
  buildWorkflowSourceOptions,
  buildTopLevelSelectOptions,
  buildWorkflowSelectionItems,
  parseCategorySelection,
  splitEntriesBySource,
  type SelectionOption,
  type WorkflowSourceSelection,
} from './options.js';
import { selectFlatWorkflowOptions } from './flatSelection.js';

async function selectBuiltinWorkflowFromEntries(
  entries: WorkflowDirEntry[],
): Promise<string | null> {
  const items = buildWorkflowSelectionItems(entries);
  const hasCategories = items.some((item) => item.type === 'category');

  if (!hasCategories) {
    const baseOptions: SelectionOption[] = entries.map((entry) => ({
      label: buildWorkflowOptionLabel(entry.name, entry.source),
      value: entry.name,
    }));
    return selectFlatWorkflowOptions(baseOptions, 'No builtin workflows available.');
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

async function selectUserDefinedWorkflowEntries(
  entries: WorkflowDirEntry[],
): Promise<string | null> {
  return selectFlatWorkflowOptions(
    buildUserDefinedWorkflowOptions(entries),
    'No user-defined workflows available.',
  );
}

export async function selectWorkflowFromEntries(
  entries: WorkflowDirEntry[],
): Promise<string | null> {
  if (entries.length === 0) {
    return null;
  }

  const { builtinEntries, userDefinedEntries } = splitEntriesBySource(entries);

  while (true) {
    const selectedSource = await selectOption<WorkflowSourceSelection>(
      'Select workflow source:',
      buildWorkflowSourceOptions(builtinEntries.length, userDefinedEntries.length),
    );
    if (!selectedSource) {
      return null;
    }

    if (selectedSource === 'builtin') {
      if (builtinEntries.length === 0) {
        await selectBuiltinWorkflowFromEntries(builtinEntries);
        continue;
      }
      return selectBuiltinWorkflowFromEntries(builtinEntries);
    }

    if (userDefinedEntries.length === 0) {
      await selectUserDefinedWorkflowEntries(userDefinedEntries);
      continue;
    }

    return selectUserDefinedWorkflowEntries(userDefinedEntries);
  }
}
