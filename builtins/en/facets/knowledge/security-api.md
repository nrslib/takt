# API and Server Security Knowledge

## Applicability

Apply this Knowledge when a change affects an API or server endpoint called by an external or low-trust client, authentication, authorization, database queries, or tenant boundaries. Do not apply it to a local CLI, build script, or browser-only UI change.

## SQL Injection

- A reachable path concatenates a low-trust value into SQL → REJECT
- An unvalidated value reaches an ORM raw query → REJECT
- Parameter binding or an equivalent mechanism covers every reachable path → OK

```typescript
// NG
db.query(`SELECT * FROM users WHERE id = ${userId}`)

// OK
db.query('SELECT * FROM users WHERE id = ?', [userId])
```

## Authentication and Authorization

### Authentication

- Plaintext password storage → Immediate REJECT
- New use of a weak password hash → REJECT
- Session-token handling gives a third party a concrete theft, fixation, or replay path → REJECT

### Authorization

- A protected operation is reachable without its required permission check → REJECT
- IDOR exposes another user or tenant's asset → REJECT
- A low-privilege principal can execute a high-privilege operation → REJECT

## API Input Validation

- A low-trust value crosses a trust boundary without the required semantic validation → REJECT
- Runtime-untyped input is used without runtime type validation → REJECT
- Do not reject solely because an input-size limit is absent; evaluate the concrete path and impact under the Security-specific policy

## Server-Side Requests

- Low-trust input controls a destination host, scheme, port, or path and can reach an internal service or metadata endpoint → REJECT
- A server making an outbound request is not itself a problem; identify what the attacker controls and which assets are reachable

## Rate Limiting and DoS

- Missing rate limiting on an authentication endpoint → Warning
- A hypothetical resource-exhaustion possibility alone is not grounds for REJECT
- Treat an infinite loop or unbounded operation as a blocking candidate only when controllable input, a reachable non-terminating path, and concrete impact are established

## Multi-Tenant Data Isolation

Prevent access across tenant boundaries. Authorization and tenant scoping are separate concerns; inspect both reads and writes.

| Criterion | Decision |
|-----------|----------|
| Reads are tenant-scoped but writes are not | REJECT |
| A write trusts a client-provided tenant ID | REJECT |
| An endpoint uses a tenant resolver without the required authorization | REJECT |
| One role branch bypasses tenant resolution | REJECT |
| An endpoint is outside the authentication mechanism for its intended caller role | REJECT |

### Read-Write Consistency

When reads gain a tenant filter, corresponding writes must validate a tenant ID resolved from the authenticated principal.

### Authorization-Resolver Alignment

When a resolver assumes a specific role, endpoint authorization must guarantee that role. For role branches, inspect authentication, authorization, and tenant resolution on every path.
