# Record browsing

Implement `readHistoryPage(repository, tenantId, offset)` in `src/history.mjs`.
The application passes an authenticated tenant ID and a validated nonnegative
integer offset. Return `{ items, hasMore }`, ordered by ascending ID, with up to
20 items containing `id` and `title`. Offsets beyond the end and tenants without
records return an empty page. Records are persisted in SQLite; their number is
not capped by the schema.

`createRecordRepository(database)` in `src/repository.mjs` owns SQL access.
Its existing `readRecords(tenantId)` is also used for a tenant's full export;
preserve that method's existing behavior. The read adapter and repository may
be changed together. HTTP and authentication are already handled upstream.
Use the existing Node test runner (`npm test`); no dependency installation is
needed. Add tests for the implemented behavior.
