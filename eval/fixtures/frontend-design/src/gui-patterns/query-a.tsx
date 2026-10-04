import { useQuery } from '@tanstack/react-query';
export function Orders({ accountId, load }: {
  accountId: string; load(accountId: string): Promise<readonly string[]>;
}) {
  const result = useQuery({ queryKey: ['orders', accountId], queryFn: () => load(accountId) });
  if (result.isPending) return <p>Loading</p>;
  if (result.isError) return <p role="alert">Unable to load orders</p>;
  if (result.data.length === 0) return <p>No orders</p>;
  return <ul>{result.data.map((id) => <li key={id}>{id}</li>)}</ul>;
}
