/**
 * Piece selection helpers (UI layer).
 */

import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { info, warn } from '../../shared/ui/index.js';
import {
  getBookmarkedPieces,
  addBookmark,
  removeBookmark,
} from '../../infra/config/global/index.js';
import {
  findPieceCategories,
  listPieces,
  listPieceEntries,
  loadAllPiecesWithSources,
  getPieceCategories,
  buildCategorizedPieces,
  getCurrentPiece,
  type PieceDirEntry,
  type PieceCategoryNode,
  type CategorizedPieces,
  type MissingPiece,
} from '../../infra/config/index.js';
import { DEFAULT_PIECE_NAME } from '../../shared/constants.js';

/** Top-level selection item: either a piece or a category containing pieces */
export type PieceSelectionItem =
  | { type: 'piece'; name: string }
  | { type: 'category'; name: string; pieces: string[] };

/** Option item for prompt UI */
export interface SelectionOption {
  label: string;
  value: string;
}

/**
 * Build top-level selection items for the piece chooser UI.
 * Root-level pieces and categories are displayed at the same level.
 */
export function buildPieceSelectionItems(entries: PieceDirEntry[]): PieceSelectionItem[] {
  const categories = new Map<string, string[]>();
  const items: PieceSelectionItem[] = [];

  for (const entry of entries) {
    if (entry.category) {
      let pieces = categories.get(entry.category);
      if (!pieces) {
        pieces = [];
        categories.set(entry.category, pieces);
      }
      pieces.push(entry.name);
    } else {
      items.push({ type: 'piece', name: entry.name });
    }
  }

  for (const [name, pieces] of categories) {
    items.push({ type: 'category', name, pieces: pieces.sort() });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

const CATEGORY_VALUE_PREFIX = '__category__:';

/**
 * Build top-level select options from PieceSelectionItems.
 * Categories are encoded with a prefix in the value field.
 */
export function buildTopLevelSelectOptions(
  items: PieceSelectionItem[],
  currentPiece: string,
): SelectionOption[] {
  return items.map((item) => {
    if (item.type === 'piece') {
      const isCurrent = item.name === currentPiece;
      const label = isCurrent ? `${item.name} (current)` : item.name;
      return { label, value: item.name };
    }
    const containsCurrent = item.pieces.some((w) => w === currentPiece);
    const label = containsCurrent ? `📁 ${item.name}/ (current)` : `📁 ${item.name}/`;
    return { label, value: `${CATEGORY_VALUE_PREFIX}${item.name}` };
  });
}

/**
 * Parse a top-level selection result.
 * Returns the category name if a category was selected, or null if a piece was selected directly.
 */
export function parseCategorySelection(selected: string): string | null {
  if (selected.startsWith(CATEGORY_VALUE_PREFIX)) {
    return selected.slice(CATEGORY_VALUE_PREFIX.length);
  }
  return null;
}

/**
 * Build select options for pieces within a category.
 */
export function buildCategoryPieceOptions(
  items: PieceSelectionItem[],
  categoryName: string,
  currentPiece: string,
): SelectionOption[] | null {
  const categoryItem = items.find(
    (item) => item.type === 'category' && item.name === categoryName,
  );
  if (!categoryItem || categoryItem.type !== 'category') return null;

  return categoryItem.pieces.map((qualifiedName) => {
    const displayName = qualifiedName.split('/').pop() ?? qualifiedName;
    const isCurrent = qualifiedName === currentPiece;
    const label = isCurrent ? `${displayName} (current)` : displayName;
    return { label, value: qualifiedName };
  });
}

const BOOKMARK_MARK = ' [*]';

/**
 * Add [*] suffix to bookmarked items without changing order.
 * Pure function — does not mutate inputs.
 */
export function applyBookmarks(
  options: SelectionOption[],
  bookmarkedPieces: string[],
): SelectionOption[] {
  const bookmarkedSet = new Set(bookmarkedPieces);

  return options.map((opt) => {
    if (bookmarkedSet.has(opt.value)) {
      return { ...opt, label: `${opt.label}${BOOKMARK_MARK}` };
    }
    return opt;
  });
}

/**
 * Warn about missing pieces referenced by categories.
 */
export function warnMissingPieces(missing: MissingPiece[]): void {
  for (const { categoryPath, pieceName } of missing) {
    const pathLabel = categoryPath.join(' / ');
    warn(`Piece "${pieceName}" in category "${pathLabel}" not found`);
  }
}

function categoryContainsPiece(node: PieceCategoryNode, piece: string): boolean {
  if (node.pieces.includes(piece)) return true;
  for (const child of node.children) {
    if (categoryContainsPiece(child, piece)) return true;
  }
  return false;
}

function buildCategoryLevelOptions(
  categories: PieceCategoryNode[],
  pieces: string[],
  currentPiece: string,
  rootCategories: PieceCategoryNode[],
  currentPathLabel: string,
): {
  options: SelectionOption[];
  categoryMap: Map<string, PieceCategoryNode>;
} {
  const options: SelectionOption[] = [];
  const categoryMap = new Map<string, PieceCategoryNode>();

  for (const category of categories) {
    const containsCurrent = currentPiece.length > 0 && categoryContainsPiece(category, currentPiece);
    const label = containsCurrent
      ? `📁 ${category.name}/ (current)`
      : `📁 ${category.name}/`;
    const value = `${CATEGORY_VALUE_PREFIX}${category.name}`;
    options.push({ label, value });
    categoryMap.set(category.name, category);
  }

  for (const pieceName of pieces) {
    const isCurrent = pieceName === currentPiece;
    const alsoIn = findPieceCategories(pieceName, rootCategories)
      .filter((path) => path !== currentPathLabel);
    const alsoInLabel = alsoIn.length > 0 ? `also in ${alsoIn.join(', ')}` : '';

    let label = `🎼 ${pieceName}`;
    if (isCurrent && alsoInLabel) {
      label = `🎼 ${pieceName} (current, ${alsoInLabel})`;
    } else if (isCurrent) {
      label = `🎼 ${pieceName} (current)`;
    } else if (alsoInLabel) {
      label = `🎼 ${pieceName} (${alsoInLabel})`;
    }

    options.push({ label, value: pieceName });
  }

  return { options, categoryMap };
}

async function selectPieceFromCategoryTree(
  categories: PieceCategoryNode[],
  currentPiece: string,
  hasSourceSelection: boolean,
  rootPieces: string[] = [],
): Promise<string | null> {
  if (categories.length === 0 && rootPieces.length === 0) {
    info('No pieces available for configured categories.');
    return null;
  }

  const stack: PieceCategoryNode[] = [];

  while (true) {
    const currentNode = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const currentCategories = currentNode ? currentNode.children : categories;
    const currentPieces = currentNode ? currentNode.pieces : rootPieces;
    const currentPathLabel = stack.map((node) => node.name).join(' / ');

    const { options, categoryMap } = buildCategoryLevelOptions(
      currentCategories,
      currentPieces,
      currentPiece,
      categories,
      currentPathLabel,
    );

    if (options.length === 0) {
      if (stack.length === 0) {
        info('No pieces available for configured categories.');
        return null;
      }
      stack.pop();
      continue;
    }

    const buildOptionsWithBookmarks = (): SelectionOption[] =>
      applyBookmarks(options, getBookmarkedPieces());

    const message = currentPathLabel.length > 0
      ? `Select piece in ${currentPathLabel}:`
      : 'Select piece category:';

    const selected = await selectOption<string>(message, buildOptionsWithBookmarks(), {
      cancelLabel: (stack.length > 0 || hasSourceSelection) ? '← Go back' : 'Cancel',
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        // Don't handle bookmark keys for categories
        if (parseCategorySelection(value)) {
          return null; // Delegate to default handler
        }

        if (key === 'b') {
          addBookmark(value);
          return buildOptionsWithBookmarks();
        }

        if (key === 'r') {
          removeBookmark(value);
          return buildOptionsWithBookmarks();
        }

        return null; // Delegate to default handler
      },
    });

    if (!selected) {
      if (stack.length > 0) {
        stack.pop();
        continue;
      }
      return null;
    }

    const categoryName = parseCategorySelection(selected);
    if (categoryName) {
      const nextNode = categoryMap.get(categoryName);
      if (!nextNode) continue;
      stack.push(nextNode);
      continue;
    }

    return selected;
  }
}

const CURRENT_PIECE_VALUE = '__current__';
const CUSTOM_CATEGORY_PREFIX = '__custom_category__:';

type TopLevelSelection =
  | { type: 'current' }
  | { type: 'piece'; name: string }
  | { type: 'category'; node: PieceCategoryNode };

async function selectTopLevelPieceOption(
  categorized: CategorizedPieces,
  currentPiece: string,
): Promise<TopLevelSelection | null> {
  const buildOptions = (): SelectOptionItem<string>[] => {
    const options: SelectOptionItem<string>[] = [];
    const bookmarkedPieces = getBookmarkedPieces();

    // 1. Current piece
    if (currentPiece) {
      options.push({
        label: `🎼 ${currentPiece} (current)`,
        value: CURRENT_PIECE_VALUE,
      });
    }

    // 2. Bookmarked pieces (individual items)
    for (const pieceName of bookmarkedPieces) {
      if (pieceName === currentPiece) continue;
      options.push({
        label: `🎼 ${pieceName} [*]`,
        value: pieceName,
      });
    }

    // 3. Categories
    for (const category of categorized.categories) {
      options.push({
        label: `📁 ${category.name}/`,
        value: `${CUSTOM_CATEGORY_PREFIX}${category.name}`,
      });
    }

    return options;
  };

  if (buildOptions().length === 0) return null;

  const result = await selectOption<string>('Select piece:', buildOptions(), {
    onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
      if (value === CURRENT_PIECE_VALUE || value.startsWith(CUSTOM_CATEGORY_PREFIX)) {
        return null;
      }

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

  if (!result) return null;

  if (result === CURRENT_PIECE_VALUE) {
    return { type: 'current' };
  }

  if (result.startsWith(CUSTOM_CATEGORY_PREFIX)) {
    const categoryName = result.slice(CUSTOM_CATEGORY_PREFIX.length);
    const node = categorized.categories.find(c => c.name === categoryName);
    if (!node) return null;
    return { type: 'category', node };
  }

  return { type: 'piece', name: result };
}

/**
 * Select piece from categorized pieces (hierarchical UI).
 */
export async function selectPieceFromCategorizedPieces(
  categorized: CategorizedPieces,
  currentPiece: string,
): Promise<string | null> {
  while (true) {
    const selection = await selectTopLevelPieceOption(categorized, currentPiece);
    if (!selection) return null;

    if (selection.type === 'current') return currentPiece;

    if (selection.type === 'piece') return selection.name;

    if (selection.type === 'category') {
      const piece = await selectPieceFromCategoryTree(
        selection.node.children,
        currentPiece,
        true,
        selection.node.pieces,
      );
      if (piece) return piece;
      continue;
    }
  }
}

async function selectPieceFromEntriesWithCategories(
  entries: PieceDirEntry[],
  currentPiece: string,
): Promise<string | null> {
  if (entries.length === 0) return null;

  const items = buildPieceSelectionItems(entries);
  const availablePieces = entries.map((entry) => entry.name);
  const hasCategories = items.some((item) => item.type === 'category');

  if (!hasCategories) {
    const baseOptions: SelectionOption[] = availablePieces.map((name) => ({
      label: name === currentPiece ? `🎼 ${name} (current)` : `🎼 ${name}`,
      value: name,
    }));

    const buildFlatOptions = (): SelectionOption[] =>
      applyBookmarks(baseOptions, getBookmarkedPieces());

    return selectOption<string>('Select piece:', buildFlatOptions(), {
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        if (key === 'b') {
          addBookmark(value);
          return buildFlatOptions();
        }
        if (key === 'r') {
          removeBookmark(value);
          return buildFlatOptions();
        }
        return null; // Delegate to default handler
      },
    });
  }

  // Loop until user selects a piece or cancels at top level
  while (true) {
    const buildTopLevelOptions = (): SelectionOption[] =>
      applyBookmarks(buildTopLevelSelectOptions(items, currentPiece), getBookmarkedPieces());

    const selected = await selectOption<string>('Select piece:', buildTopLevelOptions(), {
      onKeyPress: (key: string, value: string): SelectOptionItem<string>[] | null => {
        // Don't handle bookmark keys for categories
        if (parseCategorySelection(value)) {
          return null; // Delegate to default handler
        }

        if (key === 'b') {
          addBookmark(value);
          return buildTopLevelOptions();
        }

        if (key === 'r') {
          removeBookmark(value);
          return buildTopLevelOptions();
        }

        return null; // Delegate to default handler
      },
    });
    if (!selected) return null;

    const categoryName = parseCategorySelection(selected);
    if (categoryName) {
      const categoryOptions = buildCategoryPieceOptions(items, categoryName, currentPiece);
      if (!categoryOptions) continue;

      const buildCategoryOptions = (): SelectionOption[] =>
        applyBookmarks(categoryOptions, getBookmarkedPieces());

      const pieceSelection = await selectOption<string>(`Select piece in ${categoryName}:`, buildCategoryOptions(), {
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
          return null; // Delegate to default handler
        },
      });

      // If piece selected, return it. If cancelled (null), go back to top level
      if (pieceSelection) return pieceSelection;
      continue;
    }

    return selected;
  }
}

/**
 * Select piece from directory entries (builtin separated).
 */
export async function selectPieceFromEntries(
  entries: PieceDirEntry[],
  currentPiece: string,
): Promise<string | null> {
  const builtinEntries = entries.filter((entry) => entry.source === 'builtin');
  const customEntries = entries.filter((entry) => entry.source !== 'builtin');

  if (builtinEntries.length > 0 && customEntries.length > 0) {
    const selectedSource = await selectOption<'custom' | 'builtin'>('Select piece source:', [
      { label: `Custom pieces (${customEntries.length})`, value: 'custom' },
      { label: `Builtin pieces (${builtinEntries.length})`, value: 'builtin' },
    ]);
    if (!selectedSource) return null;
    const sourceEntries = selectedSource === 'custom' ? customEntries : builtinEntries;
    return selectPieceFromEntriesWithCategories(sourceEntries, currentPiece);
  }

  const entriesToUse = customEntries.length > 0 ? customEntries : builtinEntries;
  return selectPieceFromEntriesWithCategories(entriesToUse, currentPiece);
}

export interface SelectPieceOptions {
  fallbackToDefault?: boolean;
}

export async function selectPiece(
  cwd: string,
  options?: SelectPieceOptions,
): Promise<string | null> {
  const fallbackToDefault = options?.fallbackToDefault !== false;
  const categoryConfig = getPieceCategories();
  const currentPiece = getCurrentPiece(cwd);

  if (categoryConfig) {
    const allPieces = loadAllPiecesWithSources(cwd);
    if (allPieces.size === 0) {
      if (fallbackToDefault) {
        info(`No pieces found. Using default: ${DEFAULT_PIECE_NAME}`);
        return DEFAULT_PIECE_NAME;
      }
      info('No pieces found.');
      return null;
    }
    const categorized = buildCategorizedPieces(allPieces, categoryConfig);
    warnMissingPieces(categorized.missingPieces.filter((missing) => missing.source === 'user'));
    return selectPieceFromCategorizedPieces(categorized, currentPiece);
  }

  const availablePieces = listPieces(cwd);
  if (availablePieces.length === 0) {
    if (fallbackToDefault) {
      info(`No pieces found. Using default: ${DEFAULT_PIECE_NAME}`);
      return DEFAULT_PIECE_NAME;
    }
    info('No pieces found.');
    return null;
  }

  const entries = listPieceEntries(cwd);
  return selectPieceFromEntries(entries, currentPiece);
}
