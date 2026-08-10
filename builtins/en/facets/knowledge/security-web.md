# Web Security Knowledge

## Applicability

Apply to changes that involve browser-interpreted HTML, JavaScript, URLs, DOM operations, CORS, or browser-originated file submission.

## Injection Attacks

**XSS (Cross-Site Scripting):**

- Unescaped output to HTML/JS → REJECT
- Improper use of `innerHTML`, `dangerouslySetInnerHTML` → REJECT
- Direct embedding of URL parameters → REJECT

## File Operations

**File Upload:**

- No file type validation → REJECT
- Missing file-size limits can contribute to resource exhaustion; evaluate the concrete path under the Security policy
- Allowing executable file uploads → REJECT

## OWASP Top 10 Checklist

| Category | Check Items |
|----------|-------------|
| A01 Broken Access Control | CORS config |
| A03 Injection | XSS |
