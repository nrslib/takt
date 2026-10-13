export function parseCustomerFile(file) {
  if (file.format === 'jsonl') {
    return file.body.trim().split('\n').map((line) => JSON.parse(line));
  }
  if (file.format === 'csv') {
    const [header, ...rows] = file.body.trim().split('\n');
    const columns = header.split(',');
    return rows.map((row) => Object.fromEntries(
      row.split(',').map((value, index) => [columns[index], value]),
    ));
  }
  throw new Error(`Unsupported customer file format: ${file.format}`);
}

export function importCustomers(file) {
  const customers = parseCustomerFile(file);
  if (customers.some((customer) => typeof customer.id !== 'string' || typeof customer.email !== 'string')) {
    throw new Error('Customer records require an id and email address.');
  }
  return { imported: customers.length, customers };
}

export function convertCustomerXmlToJsonl(body) {
  const customers = [...body.matchAll(/<customer\s+id="([^"]+)"\s+email="([^"]+)"\s*\/>/g)];
  if (customers.length === 0) throw new Error('No customer records found.');
  return customers.map(([, id, email]) => JSON.stringify({ id, email })).join('\n');
}
