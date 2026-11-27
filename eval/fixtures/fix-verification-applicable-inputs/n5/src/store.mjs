import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function validateInvoice(invoice) {
  if (typeof invoice.id !== 'string' || typeof invoice.customer !== 'string'
    || invoice.customer.length === 0 || typeof invoice.date !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(invoice.date)
    || typeof invoice.amount !== 'number' || !Number.isFinite(invoice.amount)
    || invoice.amount < 0) {
    throw new Error('明細の保存形式が不正です');
  }
  return invoice;
}

export async function readInvoices(file) {
  let body;
  try {
    body = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const invoices = JSON.parse(body);
  if (!Array.isArray(invoices)) throw new Error('明細の保存形式が不正です');
  return invoices.map(validateInvoice);
}

export async function addInvoice(file, fields) {
  const invoice = validateInvoice({ id: randomUUID(), ...fields });
  const invoices = await readInvoices(file);
  if (invoices.some(item => item.customer === invoice.customer
    && item.date === invoice.date && item.amount === invoice.amount)) {
    throw new Error('同じ明細は登録できません');
  }
  await writeFile(file, JSON.stringify([...invoices, invoice]), 'utf8');
  return invoice;
}
