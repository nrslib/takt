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

## Precedence Resolution, Override, and Trust Boundaries

Resolving multiple configuration or definition sources by precedence, intentional override behavior, and extension points are not vulnerabilities by themselves. The real question is whether the change breaks a trust boundary or gives a lower-trust actor a new attack capability.

| Criteria | Verdict |
|----------|---------|
| Behavior follows documented precedence rules within the same user and trust level | OK |
| An explicit selector or argument chooses the target and resolution still follows the documented precedence model | OK |
| A higher-precedence definition wins over a lower-precedence one, but stays within the documented customization contract and does not expand privileges or data access | Warning at most. Normally not REJECT |
| A lower-trust actor can override a higher-trust setting or definition and thereby gain new code execution, modify higher-trust assets, access data, or bypass authorization | REJECT |
| An interactive confirmation step is removed, but explicit selection already makes intent unambiguous and the trust boundary is unchanged | OK |
| An interactive confirmation step was the only trust-boundary control, and removing it silently enables lower-trust override | May be REJECT. Make the attack preconditions and impact concrete |

### How to Evaluate

To treat precedence resolution or override behavior as a vulnerability, make all of the following concrete:

- Who the lower-trust actor is and what input or configuration they control
- What the higher-trust asset is
- What becomes possible only after this change
- Why that behavior exceeds the documented precedence or extension model

If the product already allows behavior to be customized through multiple scoped definition files or configuration sources, enabling selection among definitions at the same trust level is usually not a new attack capability by itself.

## OWASP Top 10 Checklist

| Category | Check Items |
|----------|-------------|
| A04 Insecure Design | Security design patterns |
| A05 Security Misconfiguration | Default settings, unnecessary features |
