interface OrderSummary {
  id: string;
  label: string;
}

export function OrderList({ orders, onSelect }: {
  orders: readonly OrderSummary[];
  onSelect(orderId: string): void;
}) {
  return (
    <ul>
      {orders.map((order) => (
        <OrderRow key={order.id} order={order} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function OrderRow({ order, onSelect }: {
  order: OrderSummary;
  onSelect(orderId: string): void;
}) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(order.id)}>
        {order.label}
      </button>
    </li>
  );
}
