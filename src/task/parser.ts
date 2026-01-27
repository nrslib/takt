/**
 * Task file parser
 *
 * Supports both YAML (.yaml/.yml) and Markdown (.md) task files.
 * YAML files are validated against TaskFileSchema.
 * Markdown files are treated as plain text (backward compatible).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TaskFileSchema, type TaskFileData } from './schema.js';

/** Supported task file extensions */
const YAML_EXTENSIONS = ['.yaml', '.yml'];
const MD_EXTENSIONS = ['.md'];
export const TASK_EXTENSIONS = [...YAML_EXTENSIONS, ...MD_EXTENSIONS];

/** Parsed task with optional structured data */
export interface ParsedTask {
  filePath: string;
  name: string;
  content: string;
  createdAt: string;
  /** Structured data from YAML files (null for .md files) */
  data: TaskFileData | null;
}

/**
 * Check if a file is a supported task file
 */
export function isTaskFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TASK_EXTENSIONS.includes(ext);
}

/**
 * Check if a file is a YAML task file
 */
function isYamlFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return YAML_EXTENSIONS.includes(ext);
}

/**
 * Get the task name from a filename (without extension)
 */
function getTaskName(filename: string): string {
  const ext = path.extname(filename);
  return path.basename(filename, ext);
}

/**
 * Parse a single task file
 *
 * @throws Error if YAML parsing or validation fails
 */
export function parseTaskFile(filePath: string): ParsedTask {
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const name = getTaskName(filename);

  if (isYamlFile(filename)) {
    const parsed = parseYaml(rawContent) as unknown;
    const validated = TaskFileSchema.parse(parsed);
    return {
      filePath,
      name,
      content: validated.task,
      createdAt: stat.birthtime.toISOString(),
      data: validated,
    };
  }

  // Markdown file: plain text, no structured data
  return {
    filePath,
    name,
    content: rawContent,
    createdAt: stat.birthtime.toISOString(),
    data: null,
  };
}

/**
 * List and parse all task files in a directory
 */
export function parseTaskFiles(tasksDir: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  const files = fs.readdirSync(tasksDir)
    .filter(isTaskFile)
    .sort();

  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    try {
      tasks.push(parseTaskFile(filePath));
    } catch {
      // Skip files that fail to parse
    }
  }

  return tasks;
}
