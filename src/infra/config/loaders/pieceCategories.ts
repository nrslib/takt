/**
 * Piece category configuration loader and helpers.
 *
 * Categories are loaded from a single source: the user's piece-categories.yaml file.
 * If the file doesn't exist, it's auto-copied from builtin defaults.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import { getLanguage, getBuiltinPiecesEnabled, getDisabledBuiltins } from '../global/globalConfig.js';
import { ensureUserCategoriesFile } from '../global/pieceCategories.js';
import { getLanguageResourcesDir } from '../../resources/index.js';
import { listBuiltinPieceNames } from './pieceResolver.js';
import type { PieceWithSource } from './pieceResolver.js';

const CategoryConfigSchema = z.object({
  piece_categories: z.record(z.string(), z.unknown()).optional(),
  show_others_category: z.boolean().optional(),
  others_category_name: z.string().min(1).optional(),
}).passthrough();

export interface PieceCategoryNode {
  name: string;
  pieces: string[];
  children: PieceCategoryNode[];
}

export interface CategoryConfig {
  pieceCategories: PieceCategoryNode[];
  showOthersCategory: boolean;
  othersCategoryName: string;
}

export interface CategorizedPieces {
  categories: PieceCategoryNode[];
  allPieces: Map<string, PieceWithSource>;
  missingPieces: MissingPiece[];
}

export interface MissingPiece {
  categoryPath: string[];
  pieceName: string;
}

interface RawCategoryConfig {
  piece_categories?: Record<string, unknown>;
  show_others_category?: boolean;
  others_category_name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parsePieces(raw: unknown, sourceLabel: string, path: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`pieces must be an array in ${sourceLabel} at ${path.join(' > ')}`);
  }
  const pieces: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`piece name must be a non-empty string in ${sourceLabel} at ${path.join(' > ')}`);
    }
    pieces.push(item);
  }
  return pieces;
}

function parseCategoryNode(
  name: string,
  raw: unknown,
  sourceLabel: string,
  path: string[],
): PieceCategoryNode {
  if (!isRecord(raw)) {
    throw new Error(`category "${name}" must be an object in ${sourceLabel} at ${path.join(' > ')}`);
  }

  const pieces = parsePieces(raw.pieces, sourceLabel, path);
  const children: PieceCategoryNode[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'pieces') continue;
    if (!isRecord(value)) {
      throw new Error(`category "${key}" must be an object in ${sourceLabel} at ${[...path, key].join(' > ')}`);
    }
    children.push(parseCategoryNode(key, value, sourceLabel, [...path, key]));
  }

  return { name, pieces, children };
}

function parseCategoryTree(raw: unknown, sourceLabel: string): PieceCategoryNode[] {
  if (!isRecord(raw)) {
    throw new Error(`piece_categories must be an object in ${sourceLabel}`);
  }
  const categories: PieceCategoryNode[] = [];
  for (const [name, value] of Object.entries(raw)) {
    categories.push(parseCategoryNode(name, value, sourceLabel, [name]));
  }
  return categories;
}

function parseCategoryConfig(raw: unknown, sourceLabel: string): CategoryConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const hasPieceCategories = Object.prototype.hasOwnProperty.call(raw, 'piece_categories');
  if (!hasPieceCategories) {
    return null;
  }

  const parsed = CategoryConfigSchema.parse(raw) as RawCategoryConfig;
  if (!parsed.piece_categories) {
    throw new Error(`piece_categories is required in ${sourceLabel}`);
  }

  const showOthersCategory = parsed.show_others_category === undefined
    ? true
    : parsed.show_others_category;

  const othersCategoryName = parsed.others_category_name === undefined
    ? 'Others'
    : parsed.others_category_name;

  return {
    pieceCategories: parseCategoryTree(parsed.piece_categories, sourceLabel),
    showOthersCategory,
    othersCategoryName,
  };
}

function loadCategoryConfigFromPath(path: string, sourceLabel: string): CategoryConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  const content = readFileSync(path, 'utf-8');
  const raw = parseYaml(content);
  return parseCategoryConfig(raw, sourceLabel);
}

/**
 * Load default categories from builtin resource file.
 * Returns null if file doesn't exist or has no piece_categories.
 */
export function loadDefaultCategories(): CategoryConfig | null {
  const lang = getLanguage();
  const filePath = join(getLanguageResourcesDir(lang), 'piece-categories.yaml');
  return loadCategoryConfigFromPath(filePath, filePath);
}

/** Get the path to the builtin default categories file. */
export function getDefaultCategoriesPath(): string {
  const lang = getLanguage();
  return join(getLanguageResourcesDir(lang), 'piece-categories.yaml');
}

/**
 * Get effective piece categories configuration.
 * Reads from user file (~/.takt/preferences/piece-categories.yaml).
 * Auto-copies from builtin defaults if user file doesn't exist.
 */
export function getPieceCategories(): CategoryConfig | null {
  const defaultPath = getDefaultCategoriesPath();
  const userPath = ensureUserCategoriesFile(defaultPath);
  return loadCategoryConfigFromPath(userPath, userPath);
}

function collectMissingPieces(
  categories: PieceCategoryNode[],
  allPieces: Map<string, PieceWithSource>,
  ignorePieces: Set<string>,
): MissingPiece[] {
  const missing: MissingPiece[] = [];
  const visit = (nodes: PieceCategoryNode[], path: string[]): void => {
    for (const node of nodes) {
      const nextPath = [...path, node.name];
      for (const pieceName of node.pieces) {
        if (ignorePieces.has(pieceName)) continue;
        if (!allPieces.has(pieceName)) {
          missing.push({ categoryPath: nextPath, pieceName });
        }
      }
      if (node.children.length > 0) {
        visit(node.children, nextPath);
      }
    }
  };

  visit(categories, []);
  return missing;
}

function buildCategoryTree(
  categories: PieceCategoryNode[],
  allPieces: Map<string, PieceWithSource>,
  categorized: Set<string>,
): PieceCategoryNode[] {
  const result: PieceCategoryNode[] = [];

  for (const node of categories) {
    const pieces: string[] = [];
    for (const pieceName of node.pieces) {
      if (!allPieces.has(pieceName)) continue;
      pieces.push(pieceName);
      categorized.add(pieceName);
    }

    const children = buildCategoryTree(node.children, allPieces, categorized);
    if (pieces.length > 0 || children.length > 0) {
      result.push({ name: node.name, pieces, children });
    }
  }

  return result;
}

function appendOthersCategory(
  categories: PieceCategoryNode[],
  allPieces: Map<string, PieceWithSource>,
  categorized: Set<string>,
  othersCategoryName: string,
): PieceCategoryNode[] {
  const uncategorized: string[] = [];
  for (const [pieceName] of allPieces.entries()) {
    if (categorized.has(pieceName)) continue;
    uncategorized.push(pieceName);
  }

  if (uncategorized.length === 0) {
    return categories;
  }

  // If a category with the same name already exists, merge uncategorized pieces into it
  const existingIndex = categories.findIndex((node) => node.name === othersCategoryName);
  if (existingIndex >= 0) {
    const existing = categories[existingIndex]!;
    return categories.map((node, i) =>
      i === existingIndex
        ? { ...node, pieces: [...existing.pieces, ...uncategorized] }
        : node,
    );
  }

  return [...categories, { name: othersCategoryName, pieces: uncategorized, children: [] }];
}

/**
 * Build categorized pieces map from configuration.
 * All pieces (user and builtin) are placed in a single category tree.
 */
export function buildCategorizedPieces(
  allPieces: Map<string, PieceWithSource>,
  config: CategoryConfig,
): CategorizedPieces {
  const ignoreMissing = new Set<string>();
  if (!getBuiltinPiecesEnabled()) {
    for (const name of listBuiltinPieceNames({ includeDisabled: true })) {
      ignoreMissing.add(name);
    }
  } else {
    for (const name of getDisabledBuiltins()) {
      ignoreMissing.add(name);
    }
  }

  const missingPieces = collectMissingPieces(
    config.pieceCategories,
    allPieces,
    ignoreMissing,
  );

  const categorized = new Set<string>();
  const categories = buildCategoryTree(
    config.pieceCategories,
    allPieces,
    categorized,
  );

  const finalCategories = config.showOthersCategory
    ? appendOthersCategory(categories, allPieces, categorized, config.othersCategoryName)
    : categories;

  return {
    categories: finalCategories,
    allPieces,
    missingPieces,
  };
}

function findPieceCategoryPaths(
  piece: string,
  categories: PieceCategoryNode[],
  prefix: string[],
  results: string[],
): void {
  for (const node of categories) {
    const path = [...prefix, node.name];
    if (node.pieces.includes(piece)) {
      results.push(path.join(' / '));
    }
    if (node.children.length > 0) {
      findPieceCategoryPaths(piece, node.children, path, results);
    }
  }
}

/**
 * Find which categories contain a given piece (for duplicate indication).
 */
export function findPieceCategories(
  piece: string,
  categories: PieceCategoryNode[],
): string[] {
  const result: string[] = [];
  findPieceCategoryPaths(piece, categories, [], result);
  return result;
}
