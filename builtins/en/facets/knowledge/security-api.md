# API and Server Security Knowledge

## Applicability

Apply to changes that involve APIs, server endpoints, authentication, authorization, database queries, or tenant boundaries.

## Injection Attacks

**SQL Injection:**

- SQL construction via string concatenation → REJECT
- Not using parameterized queries → REJECT
- Unsanitized input in ORM raw queries → REJECT

```typescript
// NG
db.query(`SELECT * FROM users WHERE id = ${userId}`)

// OK
db.query('SELECT * FROM users WHERE id = ?', [userId])
```

## Authentication & Authorization

**Authentication issues:**

- Hardcoded credentials → Immediate REJECT
- Plaintext password storage → Immediate REJECT
- Weak hash algorithms (MD5, SHA1) → REJECT
- Improper session token management → REJECT

**Authorization issues:**

- Missing permission checks → REJECT
- IDOR (Insecure Direct Object Reference) → REJECT
- Privilege escalation possibility → REJECT

```typescript
// NG - No permission check
app.get('/user/:id', (req, res) => {
  return db.getUser(req.params.id)
})

// OK
app.get('/user/:id', authorize('read:user'), (req, res) => {
  if (req.user.id !== req.params.id && !req.user.isAdmin) {
    return res.status(403).send('Forbidden')
  }
  return db.getUser(req.params.id)
})
```

## Data Protection

**Data validation:**

- Unvalidated input values → REJECT, except when the only missing validation is an input size limit
- Missing type checks → REJECT
- Missing size limits can contribute to resource exhaustion; evaluate the concrete path under the Security policy

## Rate Limiting & DoS Protection

- No rate limiting (auth endpoints) → Warning
- Resource exhaustion attack possibility → Warning
- Infinite loop patterns can cause denial of service; evaluate the verified path and impact under the Security policy

## Multi-Tenant Data Isolation

Prevent data access across tenant boundaries. Authorization (who can operate) and scoping (which tenant's data) are separate concerns.

| Criteria | Verdict |
|----------|---------|
| Reads are tenant-scoped but writes are not | REJECT |
| Write operations use client-provided tenant ID | REJECT |
| Endpoint using tenant resolver has no authorization control | REJECT |
| Some paths in role-based branching don't account for tenant resolution | REJECT |
| Authentication mechanism coverage does not extend to the endpoint's expected caller (role, token type) | REJECT |

### Read-Write Consistency

Apply tenant scoping to both reads and writes. Scoping only one side creates a state where data cannot be viewed but can be modified.

When adding a tenant filter to reads, always add tenant verification to corresponding writes.

### Write-Side Tenant Verification

For write operations, use the tenant ID resolved from the authenticated user, not from the request body.

```kotlin
// NG - Trusting client-provided tenant ID
fun create(request: CreateRequest) {
    service.create(request.tenantId, request.data)
}

// OK - Resolve tenant from authentication
fun create(request: CreateRequest) {
    val tenantId = tenantResolver.resolve()
    service.create(tenantId, request.data)
}
```

### Authorization-Resolver Alignment

When a tenant resolver assumes a specific role (e.g., staff), the endpoint must have corresponding authorization controls. Without authorization, unexpected roles can access the endpoint and cause the resolver to fail.

```kotlin
// NG - Resolver assumes STAFF but no authorization control
fun getSettings(): SettingsResponse {
    val tenantId = tenantResolver.resolve()  // Fails for non-STAFF
    return settingsService.getByTenant(tenantId)
}

// OK - Authorization ensures correct role
@Authorized(roles = ["STAFF"])
fun getSettings(): SettingsResponse {
    val tenantId = tenantResolver.resolve()
    return settingsService.getByTenant(tenantId)
}
```

For endpoints with role-based branching, verify that tenant resolution succeeds on all paths.

Watch for the reverse pattern as well. When adding an endpoint dedicated to a specific role, extend the coverage of the mechanism that authenticates that role (filters, etc.) and add role-required authorization in the same change. Outside the authentication mechanism's coverage the expected caller is never authenticated in the first place, and without authorization, unexpected roles get through.

## OWASP Top 10 Checklist

| Category | Check Items |
|----------|-------------|
| A01 Broken Access Control | Authorization checks |
| A03 Injection | SQL |
| A07 Auth Failures | Authentication mechanisms |
| A10 SSRF | Server-side requests |
