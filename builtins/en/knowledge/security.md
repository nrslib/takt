# Security Knowledge

## AI-Generated Code Security Issues

AI-generated code has unique vulnerability patterns.

| Pattern | Risk | Example |
|---------|------|---------|
| Plausible but dangerous defaults | High | `cors: { origin: '*' }` looks fine but is dangerous |
| Outdated security practices | Medium | Using deprecated encryption, old auth patterns |
| Incomplete validation | High | Validates format but not business rules |
| Over-trusting inputs | Critical | Assumes internal APIs are always safe |
| Copy-paste vulnerabilities | High | Same dangerous pattern repeated in multiple files |

Require extra scrutiny:
- Auth/authorization logic (AI tends to miss edge cases)
- Input validation (AI may check syntax but miss semantics)
- Error messages (AI may expose internal details)
- Config files (AI may use dangerous defaults from training data)

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

**Command Injection:**

- Unvalidated input in `exec()`, `spawn()` → REJECT
- Insufficient escaping in shell command construction → REJECT

```typescript
// NG
exec(`ls ${userInput}`)

// OK
execFile('ls', [sanitizedInput])
```

**XSS (Cross-Site Scripting):**

- Unescaped output to HTML/JS → REJECT
- Improper use of `innerHTML`, `dangerouslySetInnerHTML` → REJECT
- Direct embedding of URL parameters → REJECT

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

**Sensitive information exposure:**

- Hardcoded API keys, secrets → Immediate REJECT
- Sensitive info in logs → REJECT
- Internal info exposure in error messages → REJECT
- Committed `.env` files → REJECT

**Data validation:**

- Unvalidated input values → REJECT
- Missing type checks → REJECT
- No size limits set → REJECT

## Cryptography

- Use of weak crypto algorithms → REJECT
- Fixed IV/Nonce usage → REJECT
- Hardcoded encryption keys → Immediate REJECT
- No HTTPS (production) → REJECT

## File Operations

**Path Traversal:**

- File paths containing user input → REJECT
- Insufficient `../` sanitization → REJECT

```typescript
// NG
const filePath = path.join(baseDir, userInput)
fs.readFile(filePath)

// OK
const safePath = path.resolve(baseDir, userInput)
if (!safePath.startsWith(path.resolve(baseDir))) {
  throw new Error('Invalid path')
}
```

**File Upload:**

- No file type validation → REJECT
- No file size limits → REJECT
- Allowing executable file uploads → REJECT

## Dependencies

- Packages with known vulnerabilities → REJECT
- Unmaintained packages → Warning
- Unnecessary dependencies → Warning

## Error Handling

- Stack trace exposure in production → REJECT
- Detailed error message exposure → REJECT
- Swallowing security events → REJECT

## Rate Limiting & DoS Protection

- No rate limiting (auth endpoints) → Warning
- Resource exhaustion attack possibility → Warning
- Infinite loop possibility → REJECT

## Multi-Tenant Data Isolation

Prevent data access across tenant boundaries. Authorization (who can operate) and scoping (which tenant's data) are separate concerns.

| Criteria | Verdict |
|----------|---------|
| Reads are tenant-scoped but writes are not | REJECT |
| Write operations use client-provided tenant ID | REJECT |
| Endpoint using tenant resolver has no authorization control | REJECT |
| Some paths in role-based branching don't account for tenant resolution | REJECT |

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

## OWASP Top 10 Checklist

| Category | Check Items |
|----------|-------------|
| A01 Broken Access Control | Authorization checks, CORS config |
| A02 Cryptographic Failures | Encryption, sensitive data protection |
| A03 Injection | SQL, Command, XSS |
| A04 Insecure Design | Security design patterns |
| A05 Security Misconfiguration | Default settings, unnecessary features |
| A06 Vulnerable Components | Dependency vulnerabilities |
| A07 Auth Failures | Authentication mechanisms |
| A08 Software Integrity | Code signing, CI/CD |
| A09 Logging Failures | Security logging |
| A10 SSRF | Server-side requests |
