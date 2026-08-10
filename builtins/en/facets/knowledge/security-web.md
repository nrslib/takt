# Web Security Knowledge

## Applicability

Apply this Knowledge when a change affects browser-interpreted HTML, JavaScript, URLs, DOM operations, cookies, CORS, or browser-originated file submission. Do not apply it to CLI output, server-internal string handling, or local-only files.

## Cross-Site Scripting (XSS)

- A reachable path writes a low-trust value into HTML or JavaScript without context-appropriate escaping → REJECT
- A low-trust value reaches `innerHTML` or `dangerouslySetInnerHTML` without effective sanitization → REJECT
- A URL parameter is inserted directly into an executable browser context → REJECT

The use of an HTML-generation API alone is not grounds for REJECT. Identify the input controller, output context, and effective escaping or sanitization.

## Browser Boundaries

| Surface | Evidence to inspect |
|---------|---------------------|
| Cookies and sessions | Attributes, destination, and availability to a third-party origin |
| CORS | Allowed origins, credentials, and the operations or data exposed |
| Redirects and URLs | Whether low-trust input controls a destination or executable scheme |
| Browser storage | Data sensitivity and reachability from same-origin scripts |

Do not reject a broad setting in isolation. Establish what an attacker can read or execute because of that setting.

## File Submission

- A low-trust file reaches a public or executable location without required validation → REJECT
- Allowing executable files leads to a concrete code-execution path → REJECT
- Do not reject solely because a file-size limit is absent; evaluate the concrete path and impact under the Security-specific policy

## Web Application Review Categories

Consider access control, cryptographic failures, injection, insecure design, misconfiguration, vulnerable components, authentication failures, software integrity, and logging only when they relate to the changed browser boundary.
