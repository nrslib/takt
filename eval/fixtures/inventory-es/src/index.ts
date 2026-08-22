/**
 * 公開 API。仕様は README.md、型の契約は ./types.ts を参照。
 * このファイルの公開シグネチャは変更禁止。内部のモジュール分割は自由
 * （実装を別モジュールに置き、ここから re-export してよい）。
 */
import type {
  Command,
  DomainEvent,
  EventStore,
  ProductState,
  StockLevel,
} from './types.js';
import { DomainError, ConcurrencyError } from './types.js';

export * from './types.js';

export const initialState: ProductState = {
  exists: false,
  name: '',
  onHand: 0,
  reservations: {},
};

export function evolve(state: ProductState, event: DomainEvent): ProductState {
  const newState = {
    exists: state.exists,
    name: state.name,
    onHand: state.onHand,
    reservations: { ...state.reservations },
  };

  switch (event.type) {
    case 'ProductCreated':
      newState.exists = true;
      newState.name = event.name;
      break;

    case 'StockReceived':
      newState.onHand += event.quantity;
      break;

    case 'StockReserved':
      newState.reservations[event.reservationId] = event.quantity;
      break;

    case 'ReservationReleased':
      delete newState.reservations[event.reservationId];
      break;

    case 'StockShipped':
      newState.onHand -= (newState.reservations[event.reservationId] ?? 0);
      delete newState.reservations[event.reservationId];
      break;
  }

  return newState;
}

export function decide(state: ProductState, command: Command): DomainEvent[] {
  switch (command.type) {
    case 'CreateProduct':
      return decideCreateProduct(state, command);
    case 'ReceiveStock':
      return decideReceiveStock(state, command);
    case 'ReserveStock':
      return decideReserveStock(state, command);
    case 'ReleaseReservation':
      return decideReleaseReservation(state, command);
    case 'ShipStock':
      return decideShipStock(state, command);
  }
}

function decideCreateProduct(state: ProductState, command: CreateProduct): DomainEvent[] {
  if (state.exists) {
    throw new DomainError('Product already exists');
  }
  const trimmedName = command.name.trim();
  if (trimmedName === '') {
    throw new DomainError('Product name cannot be empty');
  }
  return [{ type: 'ProductCreated', productId: command.productId, name: trimmedName }];
}

interface CreateProduct {
  type: 'CreateProduct';
  productId: string;
  name: string;
}

function decideReceiveStock(state: ProductState, command: ReceiveStock): DomainEvent[] {
  if (!state.exists) {
    throw new DomainError('Product does not exist');
  }
  if (!isValidQuantity(command.quantity)) {
    throw new DomainError('Quantity must be a positive integer');
  }
  return [{ type: 'StockReceived', productId: command.productId, quantity: command.quantity }];
}

interface ReceiveStock {
  type: 'ReceiveStock';
  productId: string;
  quantity: number;
}

function decideReserveStock(state: ProductState, command: ReserveStock): DomainEvent[] {
  if (!state.exists) {
    throw new DomainError('Product does not exist');
  }
  if (!isValidQuantity(command.quantity)) {
    throw new DomainError('Quantity must be a positive integer');
  }
  if (command.reservationId in state.reservations) {
    throw new DomainError('Reservation ID already exists');
  }
  const available = state.onHand - Object.values(state.reservations).reduce((sum, q) => sum + q, 0);
  if (command.quantity > available) {
    throw new DomainError('Insufficient available stock');
  }
  return [{ type: 'StockReserved', productId: command.productId, reservationId: command.reservationId, quantity: command.quantity }];
}

interface ReserveStock {
  type: 'ReserveStock';
  productId: string;
  reservationId: string;
  quantity: number;
}

function decideReleaseReservation(state: ProductState, command: ReleaseReservation): DomainEvent[] {
  if (!(command.reservationId in state.reservations)) {
    throw new DomainError('Reservation does not exist');
  }
  return [{ type: 'ReservationReleased', productId: command.productId, reservationId: command.reservationId }];
}

interface ReleaseReservation {
  type: 'ReleaseReservation';
  productId: string;
  reservationId: string;
}

function decideShipStock(state: ProductState, command: ShipStock): DomainEvent[] {
  if (!(command.reservationId in state.reservations)) {
    throw new DomainError('Reservation does not exist');
  }
  return [{ type: 'StockShipped', productId: command.productId, reservationId: command.reservationId }];
}

interface ShipStock {
  type: 'ShipStock';
  productId: string;
  reservationId: string;
}

function isValidQuantity(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity > 0;
}

export class InMemoryEventStore implements EventStore {
  private stores: Record<string, { events: DomainEvent[]; version: number }> = {};

  load(streamId: string): { events: DomainEvent[]; version: number } {
    if (this.stores[streamId]) {
      return {
        events: [...this.stores[streamId].events],
        version: this.stores[streamId].version,
      };
    }
    return { events: [], version: 0 };
  }

  append(streamId: string, events: DomainEvent[], expectedVersion: number): void {
    const current = this.stores[streamId];
    const currentVersion = current ? current.version : 0;

    if (currentVersion !== expectedVersion) {
      throw new ConcurrencyError(`Expected version ${expectedVersion}, but current version is ${currentVersion}`);
    }

    if (!this.stores[streamId]) {
      this.stores[streamId] = { events: [], version: 0 };
    }

    this.stores[streamId].events.push(...events);
    this.stores[streamId].version += events.length;
  }
}

export class CommandHandler {
  private store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  handle(command: Command): DomainEvent[] {
    const streamId = command.productId;
    const { events: pastEvents } = this.store.load(streamId);
    const state = pastEvents.reduce(evolve, initialState);

    const newEvents = decide(state, command);

    this.store.append(streamId, newEvents, pastEvents.length);

    return newEvents;
  }
}

export class StockProjection {
  private products: Record<string, { onHand: number; reserved: number; reservations: Record<string, number> }> = {};

  apply(event: DomainEvent): void {
    switch (event.type) {
      case 'ProductCreated':
        this.products[event.productId] = {
          onHand: 0,
          reserved: 0,
          reservations: {},
        };
        break;

      case 'StockReceived':
        if (!this.products[event.productId]) {
          this.products[event.productId] = {
            onHand: 0,
            reserved: 0,
            reservations: {},
          };
        }
        this.products[event.productId]!.onHand += event.quantity;
        break;

      case 'StockReserved':
        if (!this.products[event.productId]) {
          this.products[event.productId] = {
            onHand: 0,
            reserved: 0,
            reservations: {},
          };
        }
        this.products[event.productId]!.reserved += event.quantity;
        this.products[event.productId]!.reservations[event.reservationId] = event.quantity;
        break;

      case 'ReservationReleased':
        if (this.products[event.productId]) {
          const quantity = this.products[event.productId]!.reservations[event.reservationId];
          if (quantity !== undefined) {
            this.products[event.productId]!.reserved -= quantity;
            delete this.products[event.productId]!.reservations[event.reservationId];
          }
        }
        break;

      case 'StockShipped':
        if (this.products[event.productId]) {
          const totalReserved = this.products[event.productId]!.reserved;
          this.products[event.productId]!.onHand -= totalReserved;
          this.products[event.productId]!.reserved = 0;
          this.products[event.productId]!.reservations = {};
        }
        break;
    }
  }

  getStock(productId: string): StockLevel | undefined {
    const product = this.products[productId];
    if (!product) {
      return undefined;
    }
    return {
      onHand: product.onHand,
      reserved: product.reserved,
      available: product.onHand - product.reserved,
    };
  }

  lowStock(threshold: number): string[] {
    const result: string[] = [];
    for (const [productId, product] of Object.entries(this.products)) {
      const available = product.onHand - product.reserved;
      if (available < threshold) {
        result.push(productId);
      }
    }
    return result.sort();
  }
}
