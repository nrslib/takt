import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { addInvoice } from './store.mjs';

export async function importInvoices(file, csvFile) {
  const csv = await readFile(csvFile, 'utf8');
  const [header, ...lines] = csv.trimEnd().split(/\r?\n/);
  if (header !== 'customer,date,amount') throw new Error('CSV の列が不正です');
  const fields = lines.map(line => {
    const columns = line.split(',');
    if (columns.length !== 3 || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(columns[2])) {
      throw new Error('CSV の金額形式が不正です');
    }
    return { customer: columns[0], date: columns[1], amount: Number(columns[2]) };
  });
  const invoices = [];
  for (const entry of fields) invoices.push(await addInvoice(file, entry));
  return invoices;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await importInvoices('invoices.json', process.argv[2]);
}
