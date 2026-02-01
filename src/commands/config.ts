/**
 * Config switching command (like workflow switching)
 *
 * Permission mode selection that works from CLI.
 * Uses selectOption for prompt selection, same pattern as switchWorkflow.
 */

import chalk from 'chalk';
import { info, success } from '../utils/ui.js';
import { selectOption } from '../prompt/index.js';
import {
  loadProjectConfig,
  updateProjectConfig,
  type PermissionMode,
} from '../config/projectConfig.js';

// Re-export for convenience
export type { PermissionMode } from '../config/projectConfig.js';

/**
 * Get permission mode options for selection
 */
/** Common permission mode option definitions */
export const PERMISSION_MODE_OPTIONS: {
  key: PermissionMode;
  label: string;
  description: string;
  details: string[];
  icon: string;
}[] = [
  {
    key: 'default',
    label: 'デフォルト (default)',
    description: 'Agent SDK標準モード（ファイル編集自動承認、最小限の確認）',
    details: [
      'Claude Agent SDKの標準設定（acceptEdits）を使用',
      'ファイル編集は自動承認され、確認プロンプトなしで実行',
      'Bash等の危険な操作は権限確認が表示される',
      '通常の開発作業に推奨',
    ],
    icon: '📋',
  },
  {
    key: 'sacrifice-my-pc',
    label: 'SACRIFICE-MY-PC',
    description: '全ての権限リクエストが自動承認されます',
    details: [
      '⚠️ 警告: 全ての操作が確認なしで実行されます',
      'Bash, ファイル削除, システム操作も自動承認',
      'ブロック状態（判断待ち）も自動スキップ',
      '完全自動化が必要な場合のみ使用してください',
    ],
    icon: '💀',
  },
];

function getPermissionModeOptions(currentMode: PermissionMode): {
  label: string;
  value: PermissionMode;
  description: string;
  details: string[];
}[] {
  return PERMISSION_MODE_OPTIONS.map((opt) => ({
    label: currentMode === opt.key
      ? (opt.key === 'sacrifice-my-pc' ? chalk.red : chalk.blue)(`${opt.icon} ${opt.label}`) + ' (current)'
      : (opt.key === 'sacrifice-my-pc' ? chalk.red : chalk.blue)(`${opt.icon} ${opt.label}`),
    value: opt.key,
    description: opt.description,
    details: opt.details,
  }));
}

/**
 * Get current permission mode from project config
 */
export function getCurrentPermissionMode(cwd: string): PermissionMode {
  const config = loadProjectConfig(cwd);
  if (config.permissionMode) {
    return config.permissionMode as PermissionMode;
  }
  return 'default';
}

/**
 * Set permission mode in project config
 */
export function setPermissionMode(cwd: string, mode: PermissionMode): void {
  updateProjectConfig(cwd, 'permissionMode', mode);
}

/**
 * Switch permission mode (like switchWorkflow)
 * @returns true if switch was successful
 */
export async function switchConfig(cwd: string, modeName?: string): Promise<boolean> {
  const currentMode = getCurrentPermissionMode(cwd);

  // No mode specified - show selection prompt
  if (!modeName) {
    info(`Current mode: ${currentMode}`);

    const options = getPermissionModeOptions(currentMode);
    const selected = await selectOption('Select permission mode:', options);

    if (!selected) {
      info('Cancelled');
      return false;
    }

    modeName = selected;
  }

  // Validate mode name
  if (modeName !== 'default' && modeName !== 'sacrifice-my-pc') {
    info(`Invalid mode: ${modeName}`);
    info('Available modes: default, sacrifice-my-pc');
    return false;
  }

  const finalMode: PermissionMode = modeName as PermissionMode;

  // Save to project config
  setPermissionMode(cwd, finalMode);

  if (finalMode === 'sacrifice-my-pc') {
    success('Switched to: sacrifice-my-pc 💀');
    info('All permission requests will be auto-approved.');
  } else {
    success('Switched to: default 📋');
    info('Using Agent SDK default mode (acceptEdits - minimal permission prompts).');
  }

  return true;
}
