import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseAllDocuments } from 'yaml';
import { DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE } from './constants.js';

const CREDENTIAL_NAMESPACE = 'llm-deepseek';
const REFERENCE_KEY = 'apiKeyEnv';
const BASE_URL_KEY = 'baseURL';
const REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
const INVALID_DOCUMENT_MESSAGE = 'DeepSeek Harness credentials settings document is invalid';
const INVALID_REFERENCE_MESSAGE = 'DeepSeek Harness credentials settings llm-deepseek.apiKeyEnv '
  + 'must be a valid environment reference';
const INVALID_BASE_URL_MESSAGE = 'DeepSeek Harness credentials settings llm-deepseek.baseURL '
  + 'must be a non-empty URL string';
const UNREADABLE_SETTINGS_MESSAGE = 'DeepSeek Harness credentials settings file could not be read';
const OVERSIZED_SETTINGS_MESSAGE = 'DeepSeek Harness credentials settings file exceeds the supported size';

export interface DeepSeekCredentialSelector {
  ref: string;
  storedBaseUrl?: string;
}

export class DeepSeekCredentialSettingsError extends Error {
  constructor(
    readonly classification: 'invalid-selector' | 'settings-unreadable' | 'settings-too-large'
      | 'invalid-settings' | 'invalid-stored-endpoint',
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekCredentialSettingsError';
  }
}

/** Accept only environment-style reference names; the value is never interpolated. */
export function isValidDeepSeekCredentialReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

function invalidDocument(): Error {
  return new DeepSeekCredentialSettingsError('invalid-settings', INVALID_DOCUMENT_MESSAGE);
}

function extractFromNamespace(namespace: Record<string, unknown>): DeepSeekCredentialSelector {
  let ref = DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE;
  if (Object.hasOwn(namespace, REFERENCE_KEY)) {
    const reference = namespace[REFERENCE_KEY];
    if (!isValidDeepSeekCredentialReference(reference)) {
      throw new DeepSeekCredentialSettingsError('invalid-selector', INVALID_REFERENCE_MESSAGE);
    }
    ref = reference;
  }
  let storedBaseUrl: string | undefined;
  if (Object.hasOwn(namespace, BASE_URL_KEY)) {
    const baseUrl = namespace[BASE_URL_KEY];
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new DeepSeekCredentialSettingsError('invalid-stored-endpoint', INVALID_BASE_URL_MESSAGE);
    }
    storedBaseUrl = baseUrl;
  }
  return storedBaseUrl === undefined ? { ref } : { ref, storedBaseUrl };
}

/**
 * Read only the non-secret credential selector from a parsed settings document.
 * The credential value itself is never stored here; this selector only names the
 * reference the official runtime resolves.
 */
export function extractDeepSeekCredentialSelector(document: unknown): DeepSeekCredentialSelector {
  if (document === null || document === undefined) {
    return { ref: DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE };
  }
  if (typeof document !== 'object' || Array.isArray(document)) {
    throw invalidDocument();
  }
  const root = document as Record<string, unknown>;
  if (!Object.hasOwn(root, CREDENTIAL_NAMESPACE)) {
    return { ref: DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE };
  }
  const namespace = root[CREDENTIAL_NAMESPACE];
  if (namespace === null || namespace === undefined) {
    return { ref: DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE };
  }
  if (typeof namespace !== 'object' || Array.isArray(namespace)) {
    throw invalidDocument();
  }
  return extractFromNamespace(namespace as Record<string, unknown>);
}

/** Parse a settings document without evaluating custom tags or echoing its content on failure. */
function parseSettingsDocument(content: string): unknown {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(content, { logLevel: 'silent' });
  } catch {
    throw invalidDocument();
  }
  if (documents.length > 1) {
    throw invalidDocument();
  }
  const document = documents[0];
  if (document === undefined) {
    return null;
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw invalidDocument();
  }
  try {
    return document.toJS();
  } catch {
    throw invalidDocument();
  }
}

/**
 * Read the permitted settings selector with a bounded read. The file is optional:
 * a missing settings file keeps the default reference instead of failing.
 */
export async function readDeepSeekCredentialSelector(
  settingsPath: string,
): Promise<DeepSeekCredentialSelector> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // A FIFO must not block before fstat can reject non-regular files.
    handle = await open(settingsPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ref: DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE };
    }
    throw new DeepSeekCredentialSettingsError('settings-unreadable', UNREADABLE_SETTINGS_MESSAGE);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new DeepSeekCredentialSettingsError('settings-unreadable', UNREADABLE_SETTINGS_MESSAGE);
    }
    if (stats.size > MAX_SETTINGS_FILE_BYTES) {
      throw new DeepSeekCredentialSettingsError('settings-too-large', OVERSIZED_SETTINGS_MESSAGE);
    }
    const buffer = Buffer.alloc(MAX_SETTINGS_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_SETTINGS_FILE_BYTES + 1, 0);
    if (bytesRead > MAX_SETTINGS_FILE_BYTES) {
      throw new DeepSeekCredentialSettingsError('settings-too-large', OVERSIZED_SETTINGS_MESSAGE);
    }
    return extractDeepSeekCredentialSelector(parseSettingsDocument(buffer.subarray(0, bytesRead).toString('utf8')));
  } catch (error) {
    if (error instanceof DeepSeekCredentialSettingsError) throw error;
    throw new DeepSeekCredentialSettingsError('settings-unreadable', UNREADABLE_SETTINGS_MESSAGE);
  } finally {
    await handle.close();
  }
}
