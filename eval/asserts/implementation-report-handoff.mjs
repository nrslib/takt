export default function assertReportHandoff(output, context) {
  try {
    const result = JSON.parse(output);
    const expected = context.vars.expected_route;
    if (!['COMPLETE', 'need_replan', 'ABORT'].includes(expected)) throw new Error('Missing expected route');
    if (typeof result.report !== 'string' || result.report.trim() === '') throw new Error('Missing report');
    const expectedIds = context.vars.expected_ids;
    if (!Array.isArray(expectedIds)) throw new Error('Missing expected contract IDs');
    const lines = result.report.split('\n');
    const cells = line => line.trim().split('|').slice(1, -1).map(cell => cell.replaceAll('`', '').replaceAll('**', '').trim());
    const headerIndex = lines.findIndex(line => /^\s*\|/.test(line) && ['契約ID', 'Contract ID'].includes(cells(line)[0]) && cells(line).some(cell => ['状態', 'Status'].includes(cell)));
    if (headerIndex < 0) throw new Error('Missing completion contract table');
    const header = cells(lines[headerIndex]);
    const statusIndex = header.findIndex(cell => ['状態', 'Status'].includes(cell));
    const rows = [];
    for (const line of lines.slice(headerIndex + 1)) {
      if (!/^\s*\|/.test(line)) break;
      const row = cells(line);
      if (row.every(cell => /^:?-+:?$/.test(cell))) continue;
      if (row.length !== header.length || !['確認済み', '未完了', '環境要因で未実証', '情報不足', 'Verified', 'Incomplete', 'Environment-limited', 'Insufficient information'].includes(row[statusIndex])) {
        throw new Error('Incomplete contract row or missing individual status');
      }
      rows.push(row);
    }
    if (rows.length === 0) throw new Error('Missing individual contract rows');
    const ids = rows.map(row => row[0]);
    const missing = expectedIds.filter(id => ids.filter(candidate => candidate === id).length === 0);
    const referencedIds = [...result.report.matchAll(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/g)].map(match => match[0]);
    const unexpected = [...new Set(referencedIds.filter(id => !expectedIds.includes(id)))];
    const pass = result.route === expected && missing.length === 0 && unexpected.length === 0;
    return { pass, score: Number(pass), reason: `Expected ${expected}; observed ${result.route}; missing IDs: ${missing.join(', ')}; unexpected ID references: ${unexpected.join(', ')}` };
  } catch (error) {
    return { pass: false, score: 0, reason: String(error) };
  }
}
