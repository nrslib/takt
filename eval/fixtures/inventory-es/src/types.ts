/**
 * 公開契約（変更禁止）。
 * イベント・コマンド・状態・エラー・ポートの型定義。
 * テストはこの契約と src/index.ts の公開 API のみに依存する。
 */

// ---- イベント（過去に起きた事実） ----

export interface ProductCreated {
  type: 'ProductCreated';
  productId: string;
  name: string;
}

export interface StockReceived {
  type: 'StockReceived';
  productId: string;
  quantity: number;
}

export interface StockReserved {
  type: 'StockReserved';
  productId: string;
  reservationId: string;
  quantity: number;
}

export interface ReservationReleased {
  type: 'ReservationReleased';
  productId: string;
  reservationId: string;
}

export interface StockShipped {
  type: 'StockShipped';
  productId: string;
  reservationId: string;
}

export type DomainEvent =
  | ProductCreated
  | StockReceived
  | StockReserved
  | ReservationReleased
  | StockShipped;

// ---- コマンド（実行したい意図） ----

export interface CreateProduct {
  type: 'CreateProduct';
  productId: string;
  name: string;
}

export interface ReceiveStock {
  type: 'ReceiveStock';
  productId: string;
  quantity: number;
}

export interface ReserveStock {
  type: 'ReserveStock';
  productId: string;
  reservationId: string;
  quantity: number;
}

export interface ReleaseReservation {
  type: 'ReleaseReservation';
  productId: string;
  reservationId: string;
}

export interface ShipStock {
  type: 'ShipStock';
  productId: string;
  reservationId: string;
}

export type Command =
  | CreateProduct
  | ReceiveStock
  | ReserveStock
  | ReleaseReservation
  | ShipStock;

// ---- 集約の状態 ----

export interface ProductState {
  exists: boolean;
  name: string;
  onHand: number;
  /** reservationId → 予約数量 */
  reservations: Record<string, number>;
}

// ---- 読み取りモデル ----

export interface StockLevel {
  onHand: number;
  reserved: number;
  available: number;
}

// ---- エラー ----

/** ドメイン不変条件の違反 */
export class DomainError extends Error {}

/** 楽観的並行性制御の競合 */
export class ConcurrencyError extends Error {}

// ---- ポート ----

export interface EventStore {
  /** 空ストリームは { events: [], version: 0 } を返す。version は保存済みイベント数 */
  load(streamId: string): { events: DomainEvent[]; version: number };
  /** expectedVersion が現在の version と一致しない場合は ConcurrencyError を投げる */
  append(streamId: string, events: DomainEvent[], expectedVersion: number): void;
}
