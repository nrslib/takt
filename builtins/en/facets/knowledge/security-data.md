# Data and Sensitive Information Security Knowledge

## Applicability

Apply when a change affects credentials, personal or protected data, logs, errors, responses, artifacts, repository content, or cryptographic material.

## Exposure Boundaries

Do not decide from a field name or the presence of logging alone. Identify the data, where it originates, which output or storage receives it, every actor allowed to observe that destination, and the concrete unauthorized observer.

| Condition | Exposure and impact to verify |
|-----------|-------------------------------|
| A password, token, API key, session value, or authentication header reaches logs or artifacts | Determine who can read the destination and what access the credential grants |
| A request, object, exception, or serialized value is emitted as a whole | Establish which sensitive fields are included and which unauthorized observer receives them |
| Internal paths, queries, stacks, or another resource's content reach a response | Identify the caller and whether the disclosed information or data is protected from that caller |
| Personal information is logged | Identify the data classification, operational need, retention, destination readers, and unauthorized exposure |
| A secret or protected file is committed to a repository | Identify who can read the repository or downstream artifact and what capability or data becomes available |

Masking and exclusion are effective only when they cover the actual serialization path. A disabled log level changes exposure only when deployment and configuration prevent the value from reaching outputs available to unauthorized observers.

## Cryptographic Material and Semantics

For algorithms, keys, nonces, transport protection, and hashes, identify the protected property, attacker capability, runtime or protocol semantics, and concrete loss of confidentiality or integrity. A deprecated name alone does not establish impact; a hardcoded key, repeated nonce, or unprotected transport can establish impact when the relevant actor and observation or modification path are reachable.
