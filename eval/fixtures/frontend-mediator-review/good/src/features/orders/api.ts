import type { Customer, Order, Product } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`通信に失敗しました (${response.status})`);
  return response.json() as Promise<T>;
}

export function getOrder(id: string): Promise<Order> {
  return request(`/api/orders/${encodeURIComponent(id)}`);
}

export function getCustomers(): Promise<Customer[]> {
  return request('/api/customers');
}

export function getProducts(): Promise<Product[]> {
  return request('/api/products');
}

export function saveOrder(order: Order): Promise<Order> {
  return request(`/api/orders/${encodeURIComponent(order.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
}
