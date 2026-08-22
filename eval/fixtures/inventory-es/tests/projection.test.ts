import { describe, it, expect } from 'vitest';
import { StockProjection, type DomainEvent } from '../src/index';

function feed(events: DomainEvent[]): StockProjection {
  const projection = new StockProjection();
  for (const event of events) projection.apply(event);
  return projection;
}

const createdP = (id: string, name = 'Widget'): DomainEvent => ({ type: 'ProductCreated', productId: id, name });
const receivedP = (id: string, q: number): DomainEvent => ({ type: 'StockReceived', productId: id, quantity: q });
const reservedP = (id: string, rid: string, q: number): DomainEvent => ({ type: 'StockReserved', productId: id, reservationId: rid, quantity: q });
const releasedP = (id: string, rid: string): DomainEvent => ({ type: 'ReservationReleased', productId: id, reservationId: rid });
const shippedP = (id: string, rid: string): DomainEvent => ({ type: 'StockShipped', productId: id, reservationId: rid });

describe('StockProjection', () => {
  it('returns undefined for an unknown product', () => {
    expect(new StockProjection().getStock('none')).toBeUndefined();
  });

  it('starts a product at zero on ProductCreated', () => {
    const projection = feed([createdP('a')]);
    expect(projection.getStock('a')).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  it('tracks received stock', () => {
    const projection = feed([createdP('a'), receivedP('a', 10), receivedP('a', 5)]);
    expect(projection.getStock('a')).toEqual({ onHand: 15, reserved: 0, available: 15 });
  });

  it('moves quantity to reserved on StockReserved', () => {
    const projection = feed([createdP('a'), receivedP('a', 10), reservedP('a', 'r1', 3)]);
    expect(projection.getStock('a')).toEqual({ onHand: 10, reserved: 3, available: 7 });
  });

  it('returns quantity to available on ReservationReleased', () => {
    const projection = feed([
      createdP('a'), receivedP('a', 10), reservedP('a', 'r1', 3), releasedP('a', 'r1'),
    ]);
    expect(projection.getStock('a')).toEqual({ onHand: 10, reserved: 0, available: 10 });
  });

  it('reduces onHand and reserved by the reservation quantity on StockShipped', () => {
    const projection = feed([
      createdP('a'), receivedP('a', 10), reservedP('a', 'r1', 4), shippedP('a', 'r1'),
    ]);
    expect(projection.getStock('a')).toEqual({ onHand: 6, reserved: 0, available: 6 });
  });

  it('keeps products independent', () => {
    const projection = feed([
      createdP('a'), receivedP('a', 10),
      createdP('b'), receivedP('b', 2), reservedP('b', 'r1', 1),
    ]);
    expect(projection.getStock('a')).toEqual({ onHand: 10, reserved: 0, available: 10 });
    expect(projection.getStock('b')).toEqual({ onHand: 2, reserved: 1, available: 1 });
  });

  it('lists products whose available is below the threshold, sorted by productId', () => {
    const projection = feed([
      createdP('c'), receivedP('c', 1),
      createdP('a'), receivedP('a', 10),
      createdP('b'),
    ]);
    expect(projection.lowStock(5)).toEqual(['b', 'c']);
    expect(projection.lowStock(1)).toEqual(['b']);
    expect(projection.lowStock(100)).toEqual(['a', 'b', 'c']);
  });
});
