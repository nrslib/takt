export type PriceGroup = 'standard' | 'partner';

export interface Customer {
  id: string;
  name: string;
  priceGroup: PriceGroup;
}

export interface Product {
  id: string;
  name: string;
  prices: Record<PriceGroup, number>;
}

export interface OrderLine {
  productId: string;
  quantity: number;
}

export interface Order {
  id: string;
  customerId: string;
  lines: OrderLine[];
}
