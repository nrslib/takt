/**
 * Piece category configuration loader and helpers.
 *
 * Categories are built from 2 layers:
 * - builtin base categories (read-only)
 * - user overlay categories (optional)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import { getLanguage, getBuiltinPiecesEnabled, getDisabledBuiltins } from '../global/globalConfig.js';
import { getPieceCategoriesPath } from '../global/pieceCategories.js';
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
  builtinPieceCategories: PieceCategoryNode[];
  userPieceCategories: PieceCategoryNode[];
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
  source: 'builtin' | 'user';
}

interface RawCategoryConfig {
  piece_categories?: Record<string, unknown>;
  show_others_category?: boolean;
  others_category_name?: string;
}

interface ParsedCategoryNode {
  name: string;
  pieces: string[];
  hasPieces: boolean;
  children: ParsedCategoryNode[];
}

interface ParsedCategoryConfig {
  pieceCategories?: ParsedCategoryNode[];
  showOthersCategory?: boolean;
  othersCategoryName?: string;
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
): ParsedCategoryNode {
  if (!isRecord(raw)) {
    throw new Error(`category "${name}" must be an object in ${sourceLabel} at ${path.join(' > ')}`);
  }

  const hasPieces = Object.prototype.hasOwnProperty.call(raw, 'pieces');
  const pieces = parsePieces(raw.pieces, sourceLabel, path);
  const children: ParsedCategoryNode[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'pieces') continue;
    if (!isRecord(value)) {
      throw new Error(`category "${key}" must be an object in ${sourceLabel} at ${[...path, key].join(' > ')}`);
    }
    children.push(parseCategoryNode(key, value, sourceLabel, [...path, key]));
  }

  return { name, pieces, hasPieces, children };
}

function parseCategoryTree(raw: unknown, sourceLabel: string): ParsedCategoryNode[] {
  if (!isRecord(raw)) {
    throw new Error(`piece_categories must be an object in ${sourceLabel}`);
  }

  const categories: ParsedCategoryNode[] = [];
  for (const [name, value] of Object.entries(raw)) {
    categories.push(parseCategoryNode(name, value, sourceLabel, [name]));
  }
  return categories;
}

function parseCategoryConfig(raw: unknown, sourceLabel: string): ParsedCategoryConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const parsed = CategoryConfigSchema.parse(raw) as RawCategoryConfig;
  const hasPieceCategories = Object.prototype.hasOwnProperty.call(parsed, 'piece_categories');

  const result: ParsedCategoryConfig = {};
  if (hasPieceCategories) {
    if (!parsed.piece_categories) {
      throw new Error(`piece_categories must be an object in ${sourceLabel}`);
    }
    result.pieceCategories = parseCategoryTree(parsed.piece_categories, sourceLabel);
  }

  if (parsed.show_others_category !== undefined) {
    result.showOthersCategory = parsed.show_others_category;
  }
  if (parsed.others_category_name !== undefined) {
    result.othersCategoryName = parsed.others_category_name;
  }

  if (
    result.pieceCategories === undefined
    && result.showOthersCategory === undefined
    && result.othersCategoryName === undefined
  ) {
    return null;
  }

  return result;
}

function loadCategoryConfigFromPath(path: string, sourceLabel: string): ParsedCategoryConfig | null {
  if (!existsSync(path)) {
    return null;
  }

  const content = readFileSync(path, 'utf-8');
  const raw = parseYaml(content);
  return parseCategoryConfig(raw, sourceLabel);
}

function convertParsedNodes(nodes: ParsedCategoryNode[]): PieceCategoryNode[] {
  return nodes.map((node) => ({
    name: node.name,
    pieces: node.pieces,
    children: convertParsedNodes(node.children),
  }));
}

function mergeCategoryNodes(baseNodes: ParsedCategoryNode[], overlayNodes: ParsedCategoryNode[]): ParsedCategoryNode[] {
  const overlayByName = new Map<string, ParsedCategoryNode>();
  for (const overlayNode of overlayNodes) {
    overlayByName.set(overlayNode.name, overlayNode);
  }

  const merged: ParsedCategoryNode[] = [];
  for (const baseNode of baseNodes) {
    const overlayNode = overlayByName.get(baseNode.name);
    if (!overlayNode) {
      merged.push(baseNode);
      continue;
    }

    overlayByName.delete(baseNode.name);

    const mergedNode: ParsedCategoryNode = {
      name: baseNode.name,
      pieces: overlayNode.hasPieces ? overlayNode.pieces : baseNode.pieces,
      hasPieces: baseNode.hasPieces || overlayNode.hasPieces,
      children: mergeCategoryNodes(baseNode.children, overlayNode.children),
    };
    merged.push(mergedNode);
  }

  for (const overlayNode of overlayByName.values()) {
    merged.push(overlayNode);
  }

  return merged;
}

function resolveShowOthersCategory(defaultConfig: ParsedCategoryConfig, userConfig: ParsedCategoryConfig | null): boolean {
  if (userConfig?.showOthersCategory !== undefined) {
    return userConfig.showOthersCategory;
  }
  if (defaultConfig.showOthersCategory !== undefined) {
    return defaultConfig.showOthersCategory;
  }
  return true;
}

function resolveOthersCategoryName(defaultConfig: ParsedCategoryConfig, userConfig: ParsedCategoryConfig | null): string {
  if (userConfig?.othersCategoryName !== undefined) {
    return userConfig.othersCategoryName;
  }
  if (defaultConfig.othersCategoryName !== undefined) {
    return defaultConfig.othersCategoryName;
  }
  return 'Others';
}

/**
 * Load default categories from builtin resource file.
 * Returns null if file doesn't exist or has no piece_categories.
 */
export function loadDefaultCategories(): CategoryConfig | null {
  const lang = getLanguage();
  const filePath = join(getLanguageResourcesDir(lang), 'piece-categories.yaml');
  const parsed = loadCategoryConfigFromPath(filePath, filePath);

  if (!parsed?.pieceCategories) {
    return null;
  }

  const builtinPieceCategories = convertParsedNodes(parsed.pieceCategories);
  const showOthersCategory = parsed.showOthersCategory ?? true;
  const othersCategoryName = parsed.othersCategoryName ?? 'Others';

  return {
    pieceCategories: builtinPieceCategories,
    builtinPieceCategories,
    userPieceCategories: [],
    showOthersCategory,
    othersCategoryName,
  };
}

/** Get the path to the builtin default categories file. */
export function getDefaultCategoriesPath(): string {
  const lang = getLanguage();
  return join(getLanguageResourcesDir(lang), 'piece-categories.yaml');
}

/**
 * Get effective piece categories configuration.
 * Built from builtin categories and optional user overlay.
 */
export function getPieceCategories(): CategoryConfig | null {
  const defaultPath = getDefaultCategoriesPath();
  const defaultConfig = loadCategoryConfigFromPath(defaultPath, defaultPath);
  if (!defaultConfig?.pieceCategories) {
    return null;
  }

  const userPath = getPieceCategoriesPath();
  const userConfig = loadCategoryConfigFromPath(userPath, userPath);

  const merged = userConfig?.pieceCategories
    ? mergeCategoryNodes(defaultConfig.pieceCategories, userConfig.pieceCategories)
    : defaultConfig.pieceCategories;

  const builtinPieceCategories = convertParsedNodes(defaultConfig.pieceCategories);
  const userPieceCategories = convertParsedNodes(userConfig?.pieceCategories ?? []);

  return {
    pieceCategories: convertParsedNodes(merged),
    builtinPieceCategories,
    userPieceCategories,
    showOthersCategory: resolveShowOthersCategory(defaultConfig, userConfig),
    othersCategoryName: resolveOthersCategoryName(defaultConfig, userConfig),
  };
}

function collectMissingPieces(
  categories: PieceCategoryNode[],
  allPieces: Map<string, PieceWithSource>,
  ignorePieces: Set<string>,
  source: 'builtin' | 'user',
): MissingPiece[] {
  const missing: MissingPiece[] = [];

  const visit = (nodes: PieceCategoryNode[], path: string[]): void => {
    for (const node of nodes) {
      const nextPath = [...path, node.name];
      for (const pieceName of node.pieces) {
        if (ignorePieces.has(pieceName)) continue;
        if (!allPieces.has(pieceName)) {
          missing.push({ categoryPath: nextPath, pieceName, source });
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
 * Build categorized pieces map from effective configuration.
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

  const missingPieces = [
    ...collectMissingPieces(config.builtinPieceCategories, allPieces, ignoreMissing, 'builtin'),
    ...collectMissingPieces(config.userPieceCategories, allPieces, ignoreMissing, 'user'),
  ];

  const categorized = new Set<string>();
  const categories = buildCategoryTree(config.pieceCategories, allPieces, categorized);

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
