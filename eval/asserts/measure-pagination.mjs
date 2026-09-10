import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function measurePagination(projectDirectory) {
  const { readHistoryPage } = await import(pathToFileURL(join(projectDirectory, 'src/history.mjs')).href);
  const { createRecordRepository } = await import(pathToFileURL(join(projectDirectory, 'src/repository.mjs')).href);
  return measurePaginationAdapters(readHistoryPage, createRecordRepository);
}

export async function measurePaginationAdapters(readHistoryPage, createRecordRepository) {
  const measurements = [];
  for (const recordCount of [45, 2000]) {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, tenant_id TEXT, title TEXT)');
      const insert = database.prepare('INSERT INTO records VALUES (?, ?, ?)');
      for (let id = 1; id <= recordCount; id++) insert.run(id, 'tenant-a', `Record ${id}`);
      insert.run(recordCount + 1, 'tenant-b', 'Other tenant');
      let fetchedRows = 0;
      const measuredDatabase = new Proxy(database, {
        get(target, key) {
          if (key !== 'prepare') {
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, method) {
                if (method === 'all') return (...args) => {
                  const rows = prepared.all(...args);
                  fetchedRows += rows.length;
                  return rows;
                };
                if (method === 'get') return (...args) => {
                  const row = prepared.get(...args);
                  if (row !== undefined) fetchedRows++;
                  return row;
                };
                if (method === 'iterate') return function* (...args) {
                  for (const row of prepared.iterate(...args)) {
                    fetchedRows++;
                    yield row;
                  }
                };
                const value = Reflect.get(prepared, method);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
          };
        },
      });
      for (const [tenantId, offset] of [['tenant-a', 0], ['tenant-a', 20], ['tenant-a', recordCount - 5], ['tenant-a', recordCount + 20], ['empty', 0]]) {
        fetchedRows = 0;
        const repository = createRecordRepository(measuredDatabase);
        const page = await readHistoryPage(repository, tenantId, offset);
        const count = tenantId === 'empty' ? 0 : Math.max(0, Math.min(20, recordCount - offset));
        measurements.push({
          recordCount, tenantId, offset, page, fetchedRows,
          expectedIds: Array.from({ length: count }, (_, index) => offset + index + 1),
          expectedHasMore: tenantId !== 'empty' && offset + 20 < recordCount,
        });
      }
      const exported = await createRecordRepository(measuredDatabase).readRecords('tenant-a');
      measurements.push({ recordCount, exportIds: exported.map(({ id }) => id) });
    } finally {
      database.close();
    }
  }
  return measurements;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(await measurePagination(resolve(process.argv[2]))));
}
