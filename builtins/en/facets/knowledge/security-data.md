# Data and Secret Security Knowledge

## Applicability

Apply this Knowledge when a change affects credentials, tokens, personal information, confidential data, logs, error responses, cryptography, or signatures. Do not apply it to control flow or presentation that handles no protected data.

## Sensitive Information Exposure

- Hardcoded API keys or secrets → Immediate REJECT
- A reachable log path emits a password, token, or API key → REJECT
- A response or exception exposes a stack trace, internal path, or credential to a low-trust party → REJECT
- A committed `.env` or credential file contains real values → REJECT

Calling a value “internal information” is insufficient. Establish the output path available to an attacker and the concrete impact of disclosure.

## Logging and Masking

Exclude passwords, tokens, API keys, authentication headers, session IDs, and unnecessary personal information from logs. Inspect whole-object serialization and `toString()` output as real output paths.

| Criterion | Decision |
|-----------|----------|
| Logs contain passwords, tokens, or API keys | REJECT |
| An error response contains a stack trace or internal path | Evaluate the reachable principal and information sensitivity |
| Object serialization exposes a sensitive field | REJECT |
| Debug logs contain personal data but are disabled in production | Warning; inspect the configuration path |

## Cryptography

- New use of a weak cryptographic algorithm → REJECT
- A fixed IV or nonce breaks the security property of the chosen construction → REJECT
- Hardcoded cryptographic keys → Immediate REJECT
- Missing transport encryption → REJECT when a concrete production path sends sensitive data in plaintext

Do not judge by primitive name alone. Inspect the purpose, mode, key management, and nonce requirements.

## Error Handling

- A swallowed security event prevents an authentication, authorization, or audit boundary from detecting failure → REJECT
- Swallowing an ordinary error is not a Security finding when no security boundary is affected
- Evaluate a detailed error message when a reachable path exposes sensitive information to a low-trust party
