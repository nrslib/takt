# Tenant records

Authenticated callers browse tenant records in ascending ID order. The application
validates tenant IDs and nonnegative integer offsets before calling these read
adapters. Page size is fixed at 20. Each response contains `items` and `hasMore`.
Tenant records are persisted in SQLite; the schema does not cap their number.
Categories are a fixed six-item product vocabulary, with no persistence lookup.

The current change adds `readHistoryPage`, `readDirectoryPage`, and
`readCategoryPage`. All three functions are used by the application's read layer;
HTTP transport and authentication are outside this change. Run `npm test` to
exercise the read adapters against an in-memory SQLite database.
