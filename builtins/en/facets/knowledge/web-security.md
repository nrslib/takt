# Web security knowledge

Review web-facing behavior at the boundaries that handle HTTP and browser state:

- authentication, authorization, session cookies, CSRF, CORS, and origin checks;
- URL, header, body, redirect, upload, and content-type validation;
- DOM injection, template escaping, browser storage, and client/server trust boundaries;
- SSRF, open redirects, cache confusion, and unsafe cross-origin data exposure.

Tie each finding to an actual web entry point or browser-facing data flow. Do not infer a web vulnerability from a non-web configuration or local-only code path.
