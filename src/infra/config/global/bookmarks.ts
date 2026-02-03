/**
 * Workflow bookmarks management (separate from config.yaml)
 *
 * Bookmarks are stored in a configurable location (default: ~/.takt/preferences/bookmarks.yaml)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getGlobalConfigDir } from '../paths.js';
import { loadGlobalConfig } from './globalConfig.js';

interface BookmarksFile {
  workflows: string[];
}

function getDefaultBookmarksPath(): string {
  return join(getGlobalConfigDir(), 'preferences', 'bookmarks.yaml');
}

function getBookmarksPath(): string {
  try {
    const config = loadGlobalConfig();
    if (config.bookmarksFile) {
      return config.bookmarksFile;
    }
  } catch {
    // Ignore errors, use default
  }
  return getDefaultBookmarksPath();
}

function loadBookmarksFile(): BookmarksFile {
  const bookmarksPath = getBookmarksPath();
  if (!existsSync(bookmarksPath)) {
    return { workflows: [] };
  }

  try {
    const content = readFileSync(bookmarksPath, 'utf-8');
    const parsed = parseYaml(content);
    if (parsed && typeof parsed === 'object' && 'workflows' in parsed && Array.isArray(parsed.workflows)) {
      return { workflows: parsed.workflows };
    }
  } catch {
    // Ignore parse errors
  }

  return { workflows: [] };
}

function saveBookmarksFile(bookmarks: BookmarksFile): void {
  const bookmarksPath = getBookmarksPath();
  const dir = dirname(bookmarksPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = stringifyYaml(bookmarks, { indent: 2 });
  writeFileSync(bookmarksPath, content, 'utf-8');
}

/** Get bookmarked workflow names */
export function getBookmarkedWorkflows(): string[] {
  const bookmarks = loadBookmarksFile();
  return bookmarks.workflows;
}

/**
 * Add a workflow to bookmarks.
 * Persists to ~/.takt/bookmarks.yaml and returns the updated bookmarks list.
 */
export function addBookmark(workflowName: string): string[] {
  const bookmarks = loadBookmarksFile();
  if (!bookmarks.workflows.includes(workflowName)) {
    bookmarks.workflows.push(workflowName);
    saveBookmarksFile(bookmarks);
  }
  return bookmarks.workflows;
}

/**
 * Remove a workflow from bookmarks.
 * Persists to ~/.takt/bookmarks.yaml and returns the updated bookmarks list.
 */
export function removeBookmark(workflowName: string): string[] {
  const bookmarks = loadBookmarksFile();
  const index = bookmarks.workflows.indexOf(workflowName);
  if (index >= 0) {
    bookmarks.workflows.splice(index, 1);
    saveBookmarksFile(bookmarks);
  }
  return bookmarks.workflows;
}

/**
 * Check if a workflow is bookmarked.
 */
export function isBookmarked(workflowName: string): boolean {
  const bookmarks = loadBookmarksFile();
  return bookmarks.workflows.includes(workflowName);
}
