import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Orders } from './query-a.js';
export function Dashboard({ accountId, load }: {
  accountId: string; load(accountId: string): Promise<readonly string[]>;
}) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>
    <section aria-label="Main orders"><Orders accountId={accountId} load={load} /></section>
    <aside aria-label="Order summary"><Orders accountId={accountId} load={load} /></aside>
  </QueryClientProvider>;
}
