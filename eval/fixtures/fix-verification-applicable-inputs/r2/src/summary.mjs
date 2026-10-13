import { formatYen } from './shared/money.mjs';

export function invoiceTotal(invoices) {
  return formatYen(invoices.reduce((total, invoice) => total + invoice.amount, 0));
}
