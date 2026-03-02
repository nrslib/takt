/**
 * AbortHandler — abortSignal 監視と割り込み処理専用モジュール
 *
 * 外部 abortSignal（並列実行モード）または ShutdownManager（シングル実行モード）の
 * どちらかを使い、エンジンの中断処理を担う。
 * EPIPE エラーの抑制も担当する。
 */

import { interruptAllQueries } from '../../../infra/claude/query-manager.js';
import { ShutdownManager } from './shutdownManager.js';
import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import type { PieceEngine } from '../../../core/piece/engine/PieceEngine.js';

export interface AbortHandlerOptions {
  /** 外部から渡された AbortSignal（並列実行モード） */
  externalSignal?: AbortSignal;
  /** 外部シグナルがない場合に使う内部 AbortController */
  internalController: AbortController;
  /** 中断時に呼び出す PieceEngine インスタンス（遅延参照） */
  getEngine: () => PieceEngine | null;
}

export class AbortHandler {
  private readonly options: AbortHandlerOptions;
  private shutdownManager: ShutdownManager | undefined;
  private onAbortSignal: (() => void) | undefined;
  private onEpipe: ((err: NodeJS.ErrnoException) => void) | undefined;

  constructor(options: AbortHandlerOptions) {
    this.options = options;
  }

  /**
   * 中断ハンドラをインストールする。
   * エンジン生成後に呼ぶこと。
   */
  install(): void {
    const { externalSignal, internalController, getEngine } = this.options;

    this.onEpipe = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      throw err;
    };

    const abortEngine = () => {
      const engine = getEngine();
      if (!engine || !this.onEpipe) {
        throw new Error('Abort handler invoked before PieceEngine initialization');
      }
      if (!internalController.signal.aborted) {
        internalController.abort();
      }
      process.on('uncaughtException', this.onEpipe);
      interruptAllQueries();
      engine.abort();
    };

    if (externalSignal) {
      // 並列実行モード: 外部シグナルへ委譲
      this.onAbortSignal = abortEngine;
      if (externalSignal.aborted) {
        abortEngine();
      } else {
        externalSignal.addEventListener('abort', this.onAbortSignal, { once: true });
      }
    } else {
      // シングル実行モード: SIGINT を自前でハンドリング
      this.shutdownManager = new ShutdownManager({
        callbacks: {
          onGraceful: abortEngine,
          onForceKill: () => process.exit(EXIT_SIGINT),
        },
      });
      this.shutdownManager.install();
    }
  }

  /**
   * ハンドラをクリーンアップする。
   * finally ブロックで必ず呼ぶこと。
   */
  cleanup(): void {
    this.shutdownManager?.cleanup();
    if (this.onAbortSignal && this.options.externalSignal) {
      this.options.externalSignal.removeEventListener('abort', this.onAbortSignal);
    }
    if (this.onEpipe) {
      process.removeListener('uncaughtException', this.onEpipe);
    }
  }
}
