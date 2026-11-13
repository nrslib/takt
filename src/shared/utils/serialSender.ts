export type SerialWrite<T> = (message: T, done: (error: Error | null) => void) => void;

interface PendingSend<T> {
  message: T;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * 1 つの接続への送信を直列化する。前の書き込みの完了 callback を待ってから次を書き込み、
 * 呼び出し元は自分の送信が完了するまで待つ。送信が滞っても、送り手の側に未送信のメッセージを積み上げない。
 */
export class SerialSender<T> {
  private readonly waiting: Array<PendingSend<T>> = [];
  private writing: PendingSend<T> | undefined;
  private closed: Error | undefined;

  constructor(private readonly write: SerialWrite<T>) {}

  send(message: T): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed !== undefined) { reject(this.closed); return; }
      this.waiting.push({ message, resolve, reject });
      if (this.writing === undefined) this.next();
    });
  }

  /** 切断・終了時に、書き込み中と待機中の送り手を解放する。 */
  close(error: Error): void {
    this.closed ??= error;
    const released = [...(this.writing === undefined ? [] : [this.writing]), ...this.waiting.splice(0)];
    this.writing = undefined;
    for (const pending of released) pending.reject(error);
  }

  private next(): void {
    const pending = this.waiting.shift();
    this.writing = pending;
    if (pending === undefined) return;
    // 閉じた後や二度目に届いた完了通知では、次の書き込みを始めない。
    const done = (error: unknown): void => {
      if (this.writing !== pending) return;
      if (error === null) pending.resolve();
      else pending.reject(error);
      this.next();
    };
    try { this.write(pending.message, done); }
    catch (error) { done(error); }
  }
}
