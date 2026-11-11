/**
 * OutputFns — UI 出力ファサード
 *
 * TaskPrefixWriter が有効なとき（並列実行モード）はそちら経由で出力し、
 * 無効なとき（シングル実行モード）は shared/ui のモジュール関数に委譲する。
 */

import { ToolActivityDisplay, resolveToolActivityDisplayMode } from '../../../shared/ui/ToolActivityDisplay.js';
import type { ToolActivityDisplayMode } from '../../../shared/tool-activity/types.js';
import {
  header as rawHeader,
  info as rawInfo,
  warn as rawWarn,
  error as rawError,
  success as rawSuccess,
  status as rawStatus,
  blankLine as rawBlankLine,
  StreamDisplay,
} from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';

export interface OutputFns {
  header: (title: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  status: (label: string, value: string, color?: 'green' | 'yellow' | 'red') => void;
  blankLine: () => void;
  logLine: (text: string) => void;
}

function createSilentOutputFns(): OutputFns {
  const noop = (): void => {};
  return {
    header: noop,
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
    status: noop,
    blankLine: noop,
    logLine: noop,
  };
}

export function createOutputFns(
  prefixWriter: TaskPrefixWriter | undefined,
  outputMode: 'terminal' | 'silent' = 'terminal',
): OutputFns {
  if (outputMode === 'silent') {
    return createSilentOutputFns();
  }
  if (!prefixWriter) {
    return {
      header: rawHeader,
      info: rawInfo,
      warn: rawWarn,
      error: rawError,
      success: rawSuccess,
      status: rawStatus,
      blankLine: rawBlankLine,
      logLine: (text: string) => rawInfo(text),
    };
  }
  return {
    header: (title: string) => prefixWriter.writeLine(`=== ${title} ===`),
    info: (message: string) => prefixWriter.writeLine(`[INFO] ${message}`),
    warn: (message: string) => prefixWriter.writeLine(`[WARN] ${message}`),
    error: (message: string) => prefixWriter.writeLine(`[ERROR] ${message}`),
    success: (message: string) => prefixWriter.writeLine(message),
    status: (label: string, value: string) => prefixWriter.writeLine(`${label}: ${value}`),
    blankLine: () => prefixWriter.writeLine(''),
    logLine: (text: string) => prefixWriter.writeLine(text),
  };
}

/**
 * TaskPrefixWriter 経由でストリームイベントを行バッファリング出力するハンドラを作成する。
 */
export function createPrefixedStreamHandler(
  writer: TaskPrefixWriter,
  mode: ToolActivityDisplayMode = resolveToolActivityDisplayMode('terminal', process.stdout.isTTY !== true),
  quiet = false,
): ((event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]) => void) & { flush(): void } {
  let lastType: 'text' | 'thinking' | 'other' = 'other';
  const activity = new ToolActivityDisplay(mode, quiet, (line) => writer.writeLine(line), true);
  const handler = (event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]): void => {
    if (mode === 'silent') return;
    switch (event.type) {
      case 'text':
        if (quiet) return;
        if (lastType === 'thinking') writer.flush();
        writer.writeChunk(event.data.text);
        lastType = 'text';
        break;
      case 'tool_use':
      case 'tool_result':
      case 'tool_output':
        if (lastType !== 'other') writer.flush();
        activity.handle(event);
        lastType = 'other';
        break;
      case 'thinking':
        if (quiet) return;
        if (lastType !== 'thinking') {
          if (lastType === 'text') writer.flush();
          writer.writeLine('thinking:');
        }
        lastType = 'thinking';
        break;
      default: break;
    }
  };
  return Object.assign(handler, { flush: () => activity.flush() });
}
