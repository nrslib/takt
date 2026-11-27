import { readFile, writeFile } from 'node:fs/promises';
import { withWorkdir } from './workdir.mjs';

export async function fetchSales(config) {
  const response = await fetch(`${config.apiBase}/sales?from=${config.from}&to=${config.to}`, {
    headers: { authorization: `Bearer ${config.api_token}` },
  });
  if (!response.ok) throw new Error(`sales API failed: ${response.status}`);
  return response.json();
}

export function summarize(rows, department) {
  const totals = new Map();
  for (const row of rows) {
    if (department && row.department !== department) continue;
    totals.set(row.product, (totals.get(row.product) ?? 0) + row.amount);
  }
  return [...totals.entries()].map(([product, amount]) => ({ product, amount }));
}

export async function runReport({ configPath, outPath, fetchRows = fetchSales }) {
  return withWorkdir(configPath, async ({ configPath: snapshotPath }) => {
    const config = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const rows = await fetchRows(config);
    const summary = summarize(rows, config.department);
    const csv = ['product,amount', ...summary.map((item) => `${item.product},${item.amount}`)].join('\n');
    await writeFile(outPath, `${csv}\n`);
    return summary;
  });
}
