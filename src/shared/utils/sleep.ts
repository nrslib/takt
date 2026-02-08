import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { createLogger } from './debug.js';

const log = createLogger('sleep');

let caffeinateStarted = false;

/**
 * takt実行中のmacOSアイドルスリープおよびディスプレイスリープを防止する。
 * -d: ディスプレイスリープ防止（App Nap によるプロセス凍結を回避）
 * -i: アイドルスリープ防止
 * 蓋を閉じた場合のスリープは防げない（-s はAC電源が必要なため）。
 */
export function preventSleep(): void {
  if (caffeinateStarted) {
    return;
  }

  if (platform() !== 'darwin') {
    return;
  }

  const caffeinatePath = '/usr/bin/caffeinate';
  if (!existsSync(caffeinatePath)) {
    log.info('caffeinate not found, sleep prevention disabled');
    return;
  }

  const child = spawn(caffeinatePath, ['-di', '-w', String(process.pid)], {
    stdio: 'ignore',
    detached: true,
  });

  child.unref();

  caffeinateStarted = true;

  log.debug('Started caffeinate for sleep prevention', { pid: child.pid });
}

/**
 * テスト用: caffeinateStarted フラグをリセットする
 */
export function resetPreventSleepState(): void {
  caffeinateStarted = false;
}
