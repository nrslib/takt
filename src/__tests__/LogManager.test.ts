import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chalk', () => {
  const passthrough = (value: string) => value;
  const bold = Object.assign((value: string) => value, {
    cyan: (value: string) => value,
  });

  return {
    default: {
      gray: passthrough,
      blue: passthrough,
      yellow: passthrough,
      red: passthrough,
      green: passthrough,
      white: passthrough,
      bold,
    },
  };
});

import { LogManager } from '../shared/ui/LogManager.js';

describe('LogManager', () => {
  beforeEach(() => {
    // Given: テスト間でシングルトン状態が共有されないようにする
    LogManager.resetInstance();
    vi.clearAllMocks();
  });

  it('should filter by info level as debug=false, info=true, error=true', () => {
    // Given: ログレベルが info
    const manager = LogManager.getInstance();
    manager.setLogLevel('info');

    // When: 各レベルの出力可否を判定する
    const debugResult = manager.shouldLog('debug');
    const infoResult = manager.shouldLog('info');
    const errorResult = manager.shouldLog('error');

    // Then: info基準のフィルタリングが適用される
    expect(debugResult).toBe(false);
    expect(infoResult).toBe(true);
    expect(errorResult).toBe(true);
  });

  it('should reflect level change after setLogLevel', () => {
    // Given: 初期レベル（info）
    const manager = LogManager.getInstance();

    // When: warn レベルに変更する
    manager.setLogLevel('warn');

    // Then: info は抑制され warn は出力対象になる
    expect(manager.shouldLog('info')).toBe(false);
    expect(manager.shouldLog('warn')).toBe(true);
  });

  it('should clear singleton state when resetInstance is called', () => {
    // Given: エラーレベルに変更済みのインスタンス
    const first = LogManager.getInstance();
    first.setLogLevel('error');
    expect(first.shouldLog('info')).toBe(false);

    // When: シングルトンをリセットして再取得する
    LogManager.resetInstance();
    const second = LogManager.getInstance();

    // Then: 新しいインスタンスは初期レベルに戻る
    expect(second.shouldLog('info')).toBe(true);
  });
});
