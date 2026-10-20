import { useEffect, useState } from 'react';
import { getCustomers, getOrder, getProducts } from '../features/orders/api';
import { CustomerCard } from '../features/orders/components/customer-card';
import { OrderLines } from '../features/orders/components/order-lines';
import { OrderSummary } from '../features/orders/components/order-summary';
import type { Customer, Order, Product } from '../features/orders/types';

interface OrderData {
  order: Order;
  customers: Customer[];
  products: Product[];
}

export function OrderEditPage({ orderId }: { orderId: string }) {
  const [data, setData] = useState<OrderData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    Promise.all([getOrder(orderId), getCustomers(), getProducts()]).then(
      ([order, customers, products]) => {
        if (active) setData({ order, customers, products });
      },
      (error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : '読み込みに失敗しました');
      },
    );
    return () => { active = false; };
  }, [orderId]);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!data) return <main><p role="status">読み込み中</p></main>;
  const customer = data.customers.find(item => item.id === data.order.customerId);
  if (!customer) return <main><p role="alert">顧客が見つかりません</p></main>;
  const rows = data.order.lines.map(line => {
    const product = data.products.find(item => item.id === line.productId);
    if (!product) throw new Error(`商品が見つかりません: ${line.productId}`);
    return { ...line, name: product.name, unitPrice: product.prices[customer.priceGroup] };
  });
  const total = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);

  return <main>
    <h1>注文 {data.order.id}</h1>
    <CustomerCard customer={customer} />
    <OrderLines rows={rows} />
    <OrderSummary total={total} />
  </main>;
}
