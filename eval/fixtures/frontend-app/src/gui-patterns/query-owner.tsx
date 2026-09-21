interface OrderSummary {
  id: string;
  total: number;
}

interface QueryResult<TData> {
  isPending: boolean;
  isError: boolean;
  data: TData;
}

declare function useQuery<TData>(options: {
  queryKey: readonly unknown[];
  queryFn(): Promise<TData>;
}): QueryResult<TData>;

declare function fetchOrders(accountId: string): Promise<readonly OrderSummary[]>;

export function OrdersWidget({ accountId, onSelect }: {
  accountId: string;
  onSelect(orderId: string): void;
}) {
  const orders = useQuery({
    queryKey: ['orders', accountId],
    queryFn: () => fetchOrders(accountId),
  });

  if (orders.isPending) return <p>Loading</p>;
  if (orders.isError) return <p role="alert">Unable to load orders</p>;

  return (
    <ul>
      {orders.data.map((order) => (
        <li key={order.id}>
          <button type="button" onClick={() => onSelect(order.id)}>
            {order.total}
          </button>
        </li>
      ))}
    </ul>
  );
}
