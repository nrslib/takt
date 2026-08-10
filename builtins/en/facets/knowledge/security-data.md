# Data and Sensitive Information Security Knowledge

## Applicability

Apply to changes that involve sensitive information, logs, error responses, or cryptography.

## Data Protection

**Sensitive information exposure:**

- Hardcoded API keys, secrets → Immediate REJECT
- Sensitive info in logs → REJECT
- Internal info exposure in error messages → REJECT
- Committed `.env` files → REJECT

## Logging & Masking

Prevent sensitive information from leaking into logs and responses.

**Never log:**
- Passwords, tokens, API keys
- Credit card numbers, personal identification numbers
- Session IDs, authentication header values
- Personal information (email, phone) unless necessary for debugging

**Masking patterns:**

```typescript
// NG - Password exposed in logs
logger.info('User login attempt', { email, password })

// OK - Exclude sensitive fields
logger.info('User login attempt', { email })
```

```kotlin
// NG - Logging entire request object
logger.info("Request: {}", request)

// OK - Log only safe fields
logger.info("Request: userId={}, action={}", request.userId, request.action)
```

**Structured logging field filtering:**

When passing objects to log output, ensure `toString()` or JSON serialization does not include sensitive fields.

```kotlin
// NG - data class toString() includes password
data class UserCredentials(val email: String, val password: String)

// OK - Override toString() to mask sensitive fields
data class UserCredentials(val email: String, val password: String) {
    override fun toString(): String = "UserCredentials(email=$email, password=***)"
}
```

| Criteria | Verdict |
|----------|---------|
| Log output contains passwords, tokens, or API keys | REJECT |
| Error responses contain stack traces or internal paths | REJECT |
| data class toString() exposes sensitive fields | REJECT |
| Sensitive info can be output regardless of log level | REJECT |
| Debug logs contain PII but disabled in production | Warning. Risk of misconfiguration |

## Cryptography

- Use of weak crypto algorithms → REJECT
- Fixed IV/Nonce usage → REJECT
- Hardcoded encryption keys → Immediate REJECT
- No HTTPS (production) → REJECT

## Error Handling

- Stack trace exposure in production → REJECT
- Detailed error message exposure → REJECT
- Swallowing security events → REJECT

## OWASP Top 10 Checklist

| Category | Check Items |
|----------|-------------|
| A02 Cryptographic Failures | Encryption, sensitive data protection |
| A09 Logging Failures | Security logging |
