/**
 * OutputFns — UI 出力ファサード
 *
 * TaskPrefixWriter が有効なとき（並列実行モード）はそちら経由で出力し、
 * 無効なとき（シングル実行モード）は shared/ui のモジュール関数に委譲する。
 */

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

export function createOutputFns(prefixWriter: TaskPrefixWriter | undefined): OutputFns {
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
): (event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]) => void {
  return (event) => {
    switch (event.type) {
      case 'text': writer.writeChunk(event.data.text); break;
      case 'tool_use': writer.writeLine(`[tool] ${event.data.tool}`); break;
      case 'tool_result': {
        const label = event.data.isError ? '✗' : '✓';
        writer.writeLine(`  ${label} ${event.data.content}`);
        break;
      }
      case 'tool_output': writer.writeChunk(event.data.output); break;
      case 'thinking': writer.writeChunk(event.data.thinking); break;
      default: break;
    }
  };
}
