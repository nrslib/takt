import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Language } from '../../../core/models/index.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';
import { getLanguageResourcesDir } from '../../resources/index.js';
import { getGlobalConfigPath } from '../paths.js';
import { invalidateGlobalConfigCache } from './globalConfig.js';

export interface ResetGlobalConfigResult {
  configPath: string;
  backupPath?: string;
  language: Language;
}

function detectConfigLanguage(configPath: string): Language {
  if (!existsSync(configPath)) return DEFAULT_LANGUAGE;
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw) as { language?: unknown } | null;
  if (parsed && typeof parsed !== 'object') {
    throw new Error(`Invalid config format: ${configPath} must be a YAML object.`);
  }
  const language = parsed?.language;
  if (language === undefined) return DEFAULT_LANGUAGE;
  if (language === 'ja' || language === 'en') return language;
  throw new Error(`Invalid language in ${configPath}: ${String(language)} (expected: ja | en)`);
}

function formatTimestamp(date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function resolveBackupPath(configPath: string, timestamp: string): string {
  const base = `${configPath}.${timestamp}.old`;
  if (!existsSync(base)) return base;
  let index = 1;
  while (true) {
    const candidate = `${base}.${index}`;
    if (!existsSync(candidate)) return candidate;
    index += 1;
  }
}

export function resetGlobalConfigToTemplate(now = new Date()): ResetGlobalConfigResult {
  const configPath = getGlobalConfigPath();
  const configDir = dirname(configPath);
  mkdirSync(configDir, { recursive: true });

  const language = detectConfigLanguage(configPath);
  const templatePath = join(getLanguageResourcesDir(language), 'config.yaml');
  if (!existsSync(templatePath)) {
    throw new Error(`Builtin config template not found: ${templatePath}`);
  }

  let backupPath: string | undefined;
  if (existsSync(configPath)) {
    backupPath = resolveBackupPath(configPath, formatTimestamp(now));
    renameSync(configPath, backupPath);
  }

  copyFileSync(templatePath, configPath);
  invalidateGlobalConfigCache();

  return { configPath, backupPath, language };
}
