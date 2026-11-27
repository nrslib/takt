import { createRoot } from 'react-dom/client';
import { OrderEditPage } from './routes/order-edit';

const root = document.getElementById('root');
if (!root) throw new Error('root element is missing');
const match = /^\/orders\/(\d+)$/.exec(window.location.pathname);

createRoot(root).render(match
  ? <OrderEditPage orderId={match[1]} />
  : <main><h1>注文管理</h1><a href="/orders/42">注文42を開く</a></main>);
