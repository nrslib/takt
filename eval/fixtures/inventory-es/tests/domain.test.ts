import { describe, it, expect } from 'vitest';
import {
  initialState, evolve, decide, DomainError,
  type DomainEvent, type ProductState,
} from '../src/index';

const P = 'p-1';

function replay(events: DomainEvent[]): ProductState {
  return events.reduce(evolve, initialState);
}

function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj as object)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

const created: DomainEvent = { type: 'ProductCreated', productId: P, name: 'Widget' };
const received = (q: number): DomainEvent => ({ type: 'StockReceived', productId: P, quantity: q });
const reserved = (id: string, q: number): DomainEvent => ({ type: 'StockReserved', productId: P, reservationId: id, quantity: q });
const released = (id: string): DomainEvent => ({ type: 'ReservationReleased', productId: P, reservationId: id });
const shipped = (id: string): DomainEvent => ({ type: 'StockShipped', productId: P, reservationId: id });

describe('initialState', () => {
  it('is a non-existent product with no stock', () => {
    expect(initialState.exists).toBe(false);
    expect(initialState.onHand).toBe(0);
    expect(initialState.reservations).toEqual({});
  });
});

describe('evolve', () => {
  it('applies ProductCreated', () => {
    const s = evolve(initialState, created);
    expect(s.exists).toBe(true);
    expect(s.name).toBe('Widget');
    expect(s.onHand).toBe(0);
  });

  it('accumulates StockReceived', () => {
    const s = replay([created, received(10), received(5)]);
    expect(s.onHand).toBe(15);
  });

  it('applies StockReserved without changing onHand', () => {
    const s = replay([created, received(10), reserved('r1', 3)]);
    expect(s.onHand).toBe(10);
    expect(s.reservations).toEqual({ r1: 3 });
  });

  it('removes the reservation on ReservationReleased and keeps onHand', () => {
    const s = replay([created, received(10), reserved('r1', 3), released('r1')]);
    expect(s.onHand).toBe(10);
    expect(s.reservations).toEqual({});
  });

  it('reduces onHand by the reserved quantity on StockShipped', () => {
    const s = replay([created, received(10), reserved('r1', 4), shipped('r1')]);
    expect(s.onHand).toBe(6);
    expect(s.reservations).toEqual({});
  });

  it('replays a full event history to the expected state', () => {
    const s = replay([
      created,
      received(10),
      reserved('r1', 4),
      reserved('r2', 2),
      shipped('r1'),
      released('r2'),
      received(3),
    ]);
    expect(s).toEqual({ exists: true, name: 'Widget', onHand: 9, reservations: {} });
  });

  it('does not mutate the input state', () => {
    const base = deepFreeze(replay([created, received(10)]));
    expect(() => evolve(base, reserved('r1', 2))).not.toThrow();
    expect(() => evolve(base, received(5))).not.toThrow();
  });
});

describe('decide: CreateProduct', () => {
  it('emits ProductCreated for a new product', () => {
    const events = decide(initialState, { type: 'CreateProduct', productId: P, name: 'Widget' });
    expect(events).toEqual([created]);
  });

  it('rejects creating an existing product', () => {
    const s = replay([created]);
    expect(() => decide(s, { type: 'CreateProduct', productId: P, name: 'Widget' }))
      .toThrow(DomainError);
  });

  it.each(['', '   '])('rejects empty name %j', (name) => {
    expect(() => decide(initialState, { type: 'CreateProduct', productId: P, name }))
      .toThrow(DomainError);
  });
});

describe('decide: ReceiveStock', () => {
  it('emits StockReceived for an existing product', () => {
    const s = replay([created]);
    expect(decide(s, { type: 'ReceiveStock', productId: P, quantity: 10 }))
      .toEqual([received(10)]);
  });

  it('rejects a non-existent product', () => {
    expect(() => decide(initialState, { type: 'ReceiveStock', productId: P, quantity: 10 }))
      .toThrow(DomainError);
  });

  it.each([0, -5, 1.5])('rejects invalid quantity %d', (quantity) => {
    const s = replay([created]);
    expect(() => decide(s, { type: 'ReceiveStock', productId: P, quantity }))
      .toThrow(DomainError);
  });
});

describe('decide: ReserveStock', () => {
  const stocked = replay([created, received(10), reserved('r1', 4)]);

  it('emits StockReserved when available stock covers the quantity', () => {
    expect(decide(stocked, { type: 'ReserveStock', productId: P, reservationId: 'r2', quantity: 3 }))
      .toEqual([reserved('r2', 3)]);
  });

  it('allows reserving exactly the available quantity', () => {
    expect(decide(stocked, { type: 'ReserveStock', productId: P, reservationId: 'r2', quantity: 6 }))
      .toEqual([reserved('r2', 6)]);
  });

  it('rejects reserving more than available (onHand minus reserved)', () => {
    expect(() => decide(stocked, { type: 'ReserveStock', productId: P, reservationId: 'r2', quantity: 7 }))
      .toThrow(DomainError);
  });

  it('rejects a duplicate reservationId', () => {
    expect(() => decide(stocked, { type: 'ReserveStock', productId: P, reservationId: 'r1', quantity: 1 }))
      .toThrow(DomainError);
  });

  it('rejects a non-existent product', () => {
    expect(() => decide(initialState, { type: 'ReserveStock', productId: P, reservationId: 'r1', quantity: 1 }))
      .toThrow(DomainError);
  });

  it.each([0, -1, 2.5])('rejects invalid quantity %d', (quantity) => {
    expect(() => decide(stocked, { type: 'ReserveStock', productId: P, reservationId: 'r9', quantity }))
      .toThrow(DomainError);
  });
});

describe('decide: ReleaseReservation / ShipStock', () => {
  const stocked = replay([created, received(10), reserved('r1', 4)]);

  it('emits ReservationReleased for an existing reservation', () => {
    expect(decide(stocked, { type: 'ReleaseReservation', productId: P, reservationId: 'r1' }))
      .toEqual([released('r1')]);
  });

  it('rejects releasing an unknown reservation', () => {
    expect(() => decide(stocked, { type: 'ReleaseReservation', productId: P, reservationId: 'r9' }))
      .toThrow(DomainError);
  });

  it('emits StockShipped for an existing reservation', () => {
    expect(decide(stocked, { type: 'ShipStock', productId: P, reservationId: 'r1' }))
      .toEqual([shipped('r1')]);
  });

  it('rejects shipping an unknown reservation', () => {
    expect(() => decide(stocked, { type: 'ShipStock', productId: P, reservationId: 'r9' }))
      .toThrow(DomainError);
  });

  it('does not mutate the input state', () => {
    const frozen = deepFreeze(replay([created, received(10), reserved('r1', 4)]));
    expect(() => decide(frozen, { type: 'ShipStock', productId: P, reservationId: 'r1' }))
      .not.toThrow();
  });
});
