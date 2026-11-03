export class TurnToolScope {
  private active?: { signal: AbortSignal; accepting: boolean; pending: Set<Promise<unknown>> };

  begin(signal: AbortSignal): void {
    if (this.active !== undefined) throw new Error('Previous turn tools are still active');
    this.active = { signal, accepting: true, pending: new Set() };
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    const active = this.active;
    if (active === undefined || !active.accepting) return Promise.reject(new Error('No active tool turn'));
    const operation = Promise.resolve().then(() => { active.signal.throwIfAborted(); return action(); });
    active.pending.add(operation);
    void operation.then(() => { active.pending.delete(operation); }, () => { active.pending.delete(operation); });
    return operation;
  }

  signal(requestSignal: AbortSignal): AbortSignal {
    if (this.active === undefined) throw new Error('No active tool turn');
    return AbortSignal.any([this.active.signal, requestSignal]);
  }

  async end(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    active.accepting = false;
    await Promise.allSettled([...active.pending]);
    if (this.active === active) this.active = undefined;
  }
}
