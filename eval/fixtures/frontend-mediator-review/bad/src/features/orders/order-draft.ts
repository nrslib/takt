import type { Order, OrderLine } from './types';

export function parseQuantity(input: string): number | null {
  const normalized = input.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const quantity = Number(normalized);
  return Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : null;
}

export function addLine(lines: OrderLine[], productId: string, quantity: number): OrderLine[] {
  if (!lines.some(line => line.productId === productId)) {
    return [...lines, { productId, quantity }];
  }
  return lines.map(line =>
    line.productId === productId ? { ...line, quantity: line.quantity + quantity } : line,
  );
}

export function changeLineQuantity(lines: OrderLine[], productId: string, quantity: number): OrderLine[] {
  return lines.map(line => (line.productId === productId ? { ...line, quantity } : line));
}

export function removeLine(lines: OrderLine[], productId: string): OrderLine[] {
  return lines.filter(line => line.productId !== productId);
}

export function hasOrderChanges(saved: Order, draft: Order): boolean {
  if (saved.customerId !== draft.customerId) return true;
  if (saved.lines.length !== draft.lines.length) return true;
  return saved.lines.some(
    (line, index) =>
      line.productId !== draft.lines[index].productId || line.quantity !== draft.lines[index].quantity,
  );
}
