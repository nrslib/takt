import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installImmediateSigintExit } from '../app/cli/immediateSigintExit.js';

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = false;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }

  resume(): void {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }
}

class FakeProcess extends EventEmitter {
  pid = 1234;
  stdin = new FakeStdin();
}

function install(commandName: string, runtime: FakeProcess): void {
  installImmediateSigintExit(
    commandName,
    runtime as unknown as Parameters<typeof installImmediateSigintExit>[1],
  );
}

describe('installImmediateSigintExit', () => {
  it('run では raw mode の Ctrl+C を SIGINT に流す', () => {
    const runtime = new FakeProcess();
    const sigintListener = vi.fn();
    runtime.on('SIGINT', sigintListener);

    install('run', runtime);

    expect(runtime.stdin.isRaw).toBe(true);
    runtime.stdin.emit('data', Buffer.from('\u0003', 'utf-8'));

    expect(sigintListener).toHaveBeenCalledTimes(1);
  });

  it('watch では複数回の Ctrl+C をそのまま SIGINT に流す', () => {
    const runtime = new FakeProcess();
    const sigintListener = vi.fn();
    runtime.on('SIGINT', sigintListener);

    install('watch', runtime);

    runtime.stdin.emit('data', Buffer.from('\u0003', 'utf-8'));
    runtime.stdin.emit('data', Buffer.from('\u0003', 'utf-8'));

    expect(sigintListener).toHaveBeenCalledTimes(2);
  });

  it('run/watch 以外では何もしない', () => {
    const runtime = new FakeProcess();
    const sigintListener = vi.fn();
    runtime.on('SIGINT', sigintListener);

    install('list', runtime);

    expect(runtime.stdin.isRaw).toBe(false);
    runtime.stdin.emit('data', Buffer.from('\u0003', 'utf-8'));

    expect(sigintListener).not.toHaveBeenCalled();
  });

  it('終了時に自前で有効化した raw mode を戻す', () => {
    const runtime = new FakeProcess();

    install('run', runtime);
    expect(runtime.stdin.isRaw).toBe(true);

    runtime.emit('exit');

    expect(runtime.stdin.isRaw).toBe(false);
    expect(runtime.stdin.paused).toBe(true);
  });

  it('既に raw mode の場合は終了時に戻さない', () => {
    const runtime = new FakeProcess();
    runtime.stdin.isRaw = true;

    install('run', runtime);
    expect(runtime.stdin.isRaw).toBe(true);

    runtime.emit('exit');

    expect(runtime.stdin.isRaw).toBe(true);
  });

  it('TTY でない場合はリスナーを仕込まない', () => {
    const runtime = new FakeProcess();
    runtime.stdin.isTTY = false;
    const sigintListener = vi.fn();
    runtime.on('SIGINT', sigintListener);

    install('run', runtime);
    runtime.stdin.emit('data', Buffer.from('\u0003', 'utf-8'));

    expect(runtime.stdin.isRaw).toBe(false);
    expect(sigintListener).not.toHaveBeenCalled();
  });

  it('返された cleanup で data listener と raw mode を片付ける', () => {
    const runtime = new FakeProcess();
    const sigintListener = vi.fn();
    runtime.on('SIGINT', sigintListener);

    const cleanup = installImmediateSigintExit(
      'watch',
      runtime as unknown as Parameters<typeof installImmediateSigintExit>[1],
    );
    expect(runtime.stdin.isRaw).toBe(true);

    cleanup();
    runtime.stdin.emit('data', Buffer.from('\u0003', 'utf-8'));

    expect(sigintListener).not.toHaveBeenCalled();
    expect(runtime.stdin.isRaw).toBe(false);
    expect(runtime.stdin.paused).toBe(true);
  });

  it('cleanup は複数回呼んでも安全', () => {
    const runtime = new FakeProcess();
    const cleanup = installImmediateSigintExit(
      'watch',
      runtime as unknown as Parameters<typeof installImmediateSigintExit>[1],
    );

    cleanup();
    cleanup();

    expect(runtime.stdin.isRaw).toBe(false);
    expect(runtime.stdin.paused).toBe(true);
  });
});
