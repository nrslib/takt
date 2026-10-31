interface DirectorTurnSource {
  peek(): string | undefined;
  start(): void;
}

export class ManagerTurnScheduler {
  private readonly active = new Map<string, string>();
  private readonly directors = new Map<string, DirectorTurnSource>();
  private readonly waiters = new Map<string, Set<() => void>>();

  registerDirector(id: string, source: DirectorTurnSource): void {
    this.directors.set(id, source);
  }

  busyOperationId(id: string): string | undefined {
    return this.active.get(id) ?? this.directors.get(id)?.peek();
  }

  tryAcquire(id: string, operationId: string): boolean {
    if (this.active.has(id)) return false;
    const director = this.directors.get(id)?.peek();
    if (director !== undefined && director !== operationId) return false;
    this.active.set(id, operationId);
    return true;
  }

  release(id: string, operationId: string): void {
    if (this.active.get(id) !== operationId) throw new Error('Manager turn owner mismatch');
    this.active.delete(id);
    this.notify(id);
  }

  notify(id: string): void {
    if (!this.active.has(id)) this.directors.get(id)?.start();
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
  }

  async acquire(id: string, operationId: string, signal: AbortSignal): Promise<() => void> {
    for (;;) {
      signal.throwIfAborted();
      if (this.tryAcquire(id, operationId)) return () => this.release(id, operationId);
      await new Promise<void>((resolve, reject) => {
        const waiting = this.waiters.get(id) ?? new Set<() => void>();
        const finish = (): void => {
          waiting.delete(wake);
          if (waiting.size === 0) this.waiters.delete(id);
          signal.removeEventListener('abort', abort);
        };
        const wake = (): void => { finish(); resolve(); };
        const abort = (): void => { finish(); reject(signal.reason); };
        waiting.add(wake);
        this.waiters.set(id, waiting);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
