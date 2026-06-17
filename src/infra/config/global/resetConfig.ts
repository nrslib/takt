import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Language } from '../../../core/models/index.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';
import { getLanguageResourcesDir } from '../../resources/index.js';
import { getGlobalConfigPath, getGlobalConfigSamplePath } from '../paths.js';
import { invalidateGlobalConfigCache } from './globalConfig.js';

export interface ResetGlobalConfigResult {
  configPath: string;
  backupPath?: string;
  sampleConfigPath: string;
  sampleBackupPath?: string;
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

function backupExistingFile(filePath: string, timestamp: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const backupPath = resolveBackupPath(filePath, timestamp);
  renameSync(filePath, backupPath);
  return backupPath;
}

export function resetGlobalConfigToTemplate(now = new Date()): ResetGlobalConfigResult {
  const configPath = getGlobalConfigPath();
  const sampleConfigPath = getGlobalConfigSamplePath();
  const configDir = dirname(configPath);
  mkdirSync(configDir, { recursive: true });

  const language = detectConfigLanguage(configPath);
  const templatePath = join(getLanguageResourcesDir(language), 'config.yaml');
  const sampleTemplatePath = join(getLanguageResourcesDir(language), 'config.sample.yaml');
  if (!existsSync(templatePath)) {
    throw new Error(`Builtin config template not found: ${templatePath}`);
  }
  if (!existsSync(sampleTemplatePath)) {
    throw new Error(`Builtin config sample template not found: ${sampleTemplatePath}`);
  }

  const timestamp = formatTimestamp(now);
  const backupPath = backupExistingFile(configPath, timestamp);
  const sampleBackupPath = backupExistingFile(sampleConfigPath, timestamp);

  copyFileSync(templatePath, configPath);
  copyFileSync(sampleTemplatePath, sampleConfigPath);
  invalidateGlobalConfigCache();

  return { configPath, backupPath, sampleConfigPath, sampleBackupPath, language };
}
