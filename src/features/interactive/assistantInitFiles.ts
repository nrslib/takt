import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  MAX_ASSISTANT_INIT_CONTEXT_BYTES,
  MAX_ASSISTANT_INIT_FILE_BYTES,
} from '../../core/models/assistant-config.js';
import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import { formatLiteralBlock } from './promptSections.js';

type LoadedAssistantInitFile = {
  path: string;
  content: string;
  sizeBytes: number;
};

const SENSITIVE_ASSISTANT_INIT_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
]);

function formatAssistantInitContextSection(files: LoadedAssistantInitFile[]): string {
  const sections = files.map((file) => `### ${file.path}\n${formatLiteralBlock(file.content)}`);
  return [
    '## Assistant Init Context',
    'These files were explicitly configured in assistant.init_files as project-local initial context.',
    ...sections,
  ].join('\n\n');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInsideProjectRoot(projectRoot: string, targetPath: string): boolean {
  const relativePath = relative(projectRoot, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function toProjectRelativePath(projectRoot: string, targetPath: string): string {
  return relative(projectRoot, targetPath).replaceAll('\\', '/');
}

function isSensitiveAssistantInitPath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const lowerFileName = lowerSegments[lowerSegments.length - 1];

  return lowerSegments.includes('.git')
    || lowerFileName === undefined
    || lowerFileName.startsWith('.env')
    || lowerFileName.endsWith('.pem')
    || lowerFileName.endsWith('.key')
    || SENSITIVE_ASSISTANT_INIT_FILE_NAMES.has(lowerFileName);
}

function assertAssistantInitFileAllowed(relativePath: string): void {
  if (isSensitiveAssistantInitPath(relativePath)) {
    throw new Error(`Assistant init file '${relativePath}' is rejected because it matches a sensitive file pattern.`);
  }
}

function resolveAssistantInitFilePath(projectRoot: string, configuredPath: string): string {
  if (isAbsolute(configuredPath)) {
    throw new Error(`Assistant init file '${configuredPath}' must be relative to the project root; absolute paths are not allowed.`);
  }

  const resolvedPath = resolve(projectRoot, configuredPath);
  if (!isInsideProjectRoot(projectRoot, resolvedPath)) {
    throw new Error(`Assistant init file '${configuredPath}' resolves outside the project root.`);
  }

  return resolvedPath;
}

function loadAssistantInitFile(
  projectRoot: string,
  configuredPath: string,
  currentContextBytes: number,
): LoadedAssistantInitFile {
  const resolvedPath = resolveAssistantInitFilePath(projectRoot, configuredPath);

  let realPath: string;
  try {
    realPath = realpathSync(resolvedPath);
  } catch (error) {
    throw new Error(`Assistant init file '${configuredPath}' does not exist or cannot be accessed: ${getErrorMessage(error)}`);
  }

  if (!isInsideProjectRoot(projectRoot, realPath)) {
    throw new Error(`Assistant init file '${configuredPath}' resolves outside the project root.`);
  }

  const stat = statSync(realPath);
  if (!stat.isFile()) {
    throw new Error(`Assistant init file '${configuredPath}' must be a file, but it is a directory or another non-file entry.`);
  }

  const configuredRelativePath = toProjectRelativePath(projectRoot, resolvedPath);
  assertAssistantInitFileAllowed(configuredRelativePath);
  const realRelativePath = toProjectRelativePath(projectRoot, realPath);
  if (realRelativePath !== configuredRelativePath) {
    assertAssistantInitFileAllowed(realRelativePath);
  }

  if (stat.size > MAX_ASSISTANT_INIT_FILE_BYTES) {
    throw new Error(
      `Assistant init file '${configuredPath}' is too large: ${stat.size} bytes exceeds the ${MAX_ASSISTANT_INIT_FILE_BYTES} byte limit.`,
    );
  }
  if (currentContextBytes + stat.size > MAX_ASSISTANT_INIT_CONTEXT_BYTES) {
    throw new Error(
      `Assistant init files are too large: ${currentContextBytes + stat.size} bytes exceeds the ${MAX_ASSISTANT_INIT_CONTEXT_BYTES} byte total limit.`,
    );
  }

  try {
    return {
      path: configuredPath,
      sizeBytes: stat.size,
      content: readFileSync(realPath, 'utf-8'),
    };
  } catch (error) {
    throw new Error(`Failed to read assistant init file '${configuredPath}': ${getErrorMessage(error)}`);
  }
}

export function loadAssistantInitContext(projectDir: string): string | undefined {
  const initFiles = loadProjectConfig(projectDir).assistant?.initFiles;
  if (!initFiles || initFiles.length === 0) {
    return undefined;
  }

  const projectRoot = realpathSync(projectDir);
  const { loadedFiles } = initFiles.reduce<{
    loadedFiles: LoadedAssistantInitFile[];
    totalBytes: number;
  }>((state, configuredPath) => {
    const loadedFile = loadAssistantInitFile(projectRoot, configuredPath, state.totalBytes);
    return {
      loadedFiles: [...state.loadedFiles, loadedFile],
      totalBytes: state.totalBytes + loadedFile.sizeBytes,
    };
  }, { loadedFiles: [], totalBytes: 0 });

  return formatAssistantInitContextSection(loadedFiles);
}
