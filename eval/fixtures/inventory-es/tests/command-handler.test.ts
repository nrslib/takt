import { describe, it, expect } from 'vitest';
import {
  CommandHandler, InMemoryEventStore, DomainError,
} from '../src/index';

const P = 'p-1';

function setup(): { store: InMemoryEventStore; handler: CommandHandler } {
  const store = new InMemoryEventStore();
  return { store, handler: new CommandHandler(store) };
}

describe('CommandHandler', () => {
  it('persists and returns the events produced by a command', () => {
    const { store, handler } = setup();
    const events = handler.handle({ type: 'CreateProduct', productId: P, name: 'Widget' });
    expect(events).toEqual([{ type: 'ProductCreated', productId: P, name: 'Widget' }]);
    expect(store.load(P).events).toEqual(events);
  });

  it('rebuilds state from past events before deciding', () => {
    const { handler } = setup();
    handler.handle({ type: 'CreateProduct', productId: P, name: 'Widget' });
    handler.handle({ type: 'ReceiveStock', productId: P, quantity: 10 });
    handler.handle({ type: 'ReserveStock', productId: P, reservationId: 'r1', quantity: 3 });

    // available = 10 - 3 = 7 なので 8 は拒否される
    expect(() => handler.handle({ type: 'ReserveStock', productId: P, reservationId: 'r2', quantity: 8 }))
      .toThrow(DomainError);
    expect(handler.handle({ type: 'ReserveStock', productId: P, reservationId: 'r2', quantity: 7 }))
      .toEqual([{ type: 'StockReserved', productId: P, reservationId: 'r2', quantity: 7 }]);
  });

  it('appends nothing when the command is rejected', () => {
    const { store, handler } = setup();
    handler.handle({ type: 'CreateProduct', productId: P, name: 'Widget' });
    const before = store.load(P).version;
    expect(() => handler.handle({ type: 'ReceiveStock', productId: P, quantity: -1 }))
      .toThrow(DomainError);
    expect(store.load(P).version).toBe(before);
  });

  it('uses optimistic concurrency based on the loaded version', () => {
    const { store, handler } = setup();
    handler.handle({ type: 'CreateProduct', productId: P, name: 'Widget' });

    // ハンドラ外から同じストリームに直接追記しても、次の handle は最新 version から積む
    store.append(P, [{ type: 'StockReceived', productId: P, quantity: 5 }], 1);
    const events = handler.handle({ type: 'ReceiveStock', productId: P, quantity: 2 });
    expect(events).toEqual([{ type: 'StockReceived', productId: P, quantity: 2 }]);
    expect(store.load(P).version).toBe(3);
  });

  it('handles the full lifecycle: create → receive → reserve → ship', () => {
    const { store, handler } = setup();
    handler.handle({ type: 'CreateProduct', productId: P, name: 'Widget' });
    handler.handle({ type: 'ReceiveStock', productId: P, quantity: 10 });
    handler.handle({ type: 'ReserveStock', productId: P, reservationId: 'r1', quantity: 4 });
    handler.handle({ type: 'ShipStock', productId: P, reservationId: 'r1' });

    // 出荷後: onHand 6, 予約なし → 6 までは予約可能、7 は不可
    expect(() => handler.handle({ type: 'ReserveStock', productId: P, reservationId: 'r2', quantity: 7 }))
      .toThrow(DomainError);
    expect(handler.handle({ type: 'ReserveStock', productId: P, reservationId: 'r2', quantity: 6 }))
      .toHaveLength(1);
    expect(store.load(P).events).toHaveLength(5);
  });

  it('keeps aggregates isolated per productId', () => {
    const { handler } = setup();
    handler.handle({ type: 'CreateProduct', productId: 'a', name: 'A' });
    handler.handle({ type: 'CreateProduct', productId: 'b', name: 'B' });
    handler.handle({ type: 'ReceiveStock', productId: 'a', quantity: 5 });

    // b には在庫がない
    expect(() => handler.handle({ type: 'ReserveStock', productId: 'b', reservationId: 'r1', quantity: 1 }))
      .toThrow(DomainError);
  });
});
