import { formatYen } from './shared/money.mjs';

export function invoiceRows(invoices) {
  return invoices.map(invoice =>
    `${invoice.customer} | ${invoice.date} | ${formatYen(invoice.amount)}`);
}
