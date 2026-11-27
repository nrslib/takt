import { addInvoice, readInvoices } from './store.mjs';
import { invoiceRows } from './list.mjs';
import { invoiceTotal } from './summary.mjs';

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export async function submitInvoiceForm(file, fields) {
  if (typeof fields.amount !== 'string' || !/^[0-9]+$/.test(fields.amount)
    || !Number.isSafeInteger(Number(fields.amount))) {
    throw new Error('金額は円単位の整数で入力してください');
  }
  return addInvoice(file, {
    customer: fields.customer, date: fields.date, amount: Number(fields.amount),
  });
}

export async function handleAdminRequest(file, method, path, fields) {
  if (method === 'POST' && path === '/invoices') {
    await submitInvoiceForm(file, fields);
    return '<a href="/">一覧へ戻る</a>';
  }
  const invoices = await readInvoices(file);
  if (method === 'GET' && path === '/summary') {
    return `<p>${invoiceTotal(invoices)}</p>`;
  }
  if (method !== 'GET' || path !== '/') throw new Error('画面が見つかりません');
  const rows = invoiceRows(invoices).map(row => `<li>${escapeHtml(row)}</li>`).join('');
  return `<form method="post" action="/invoices">
  <input name="customer" required>
  <input name="date" type="date" required>
  <input name="amount" type="number" min="0" max="9007199254740991" step="1" required>
  <button>登録</button>
</form><ul>${rows}</ul><a href="/summary">合計</a>`;
}
