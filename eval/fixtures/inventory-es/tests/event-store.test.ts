import { describe, it, expect } from 'vitest';
import { InMemoryEventStore, ConcurrencyError, type DomainEvent } from '../src/index';

const e = (name: string): DomainEvent => ({ type: 'ProductCreated', productId: 'p', name });

describe('InMemoryEventStore', () => {
  it('returns an empty stream with version 0 for an unknown streamId', () => {
    const store = new InMemoryEventStore();
    expect(store.load('none')).toEqual({ events: [], version: 0 });
  });

  it('appends events and reports version as the stored event count', () => {
    const store = new InMemoryEventStore();
    store.append('s1', [e('a'), e('b')], 0);
    const { events, version } = store.load('s1');
    expect(events).toHaveLength(2);
    expect(version).toBe(2);
  });

  it('accumulates version across sequential appends', () => {
    const store = new InMemoryEventStore();
    store.append('s1', [e('a'), e('b')], 0);
    store.append('s1', [e('c')], 2);
    expect(store.load('s1').version).toBe(3);
  });

  it('throws ConcurrencyError when expectedVersion does not match', () => {
    const store = new InMemoryEventStore();
    store.append('s1', [e('a')], 0);
    expect(() => store.append('s1', [e('b')], 0)).toThrow(ConcurrencyError);
    expect(() => store.append('s1', [e('b')], 2)).toThrow(ConcurrencyError);
  });

  it('does not store anything when the append conflicts', () => {
    const store = new InMemoryEventStore();
    store.append('s1', [e('a')], 0);
    expect(() => store.append('s1', [e('b')], 0)).toThrow(ConcurrencyError);
    expect(store.load('s1').events).toHaveLength(1);
  });

  it('isolates streams from each other', () => {
    const store = new InMemoryEventStore();
    store.append('s1', [e('a')], 0);
    store.append('s2', [e('b'), e('c')], 0);
    expect(store.load('s1').version).toBe(1);
    expect(store.load('s2').version).toBe(2);
  });

  it('returns a copy so callers cannot mutate the stored stream', () => {
    const store = new InMemoryEventStore();
    store.append('s1', [e('a')], 0);
    const loaded = store.load('s1');
    loaded.events.push(e('evil'));
    expect(store.load('s1').events).toHaveLength(1);
  });
});
