# Browser Boundary Security Knowledge

## Applicability

Apply when low-trust values reach HTML, JavaScript, CSS, URLs, the DOM, or requests that a browser interprets or sends. Do not apply to static presentation changes or internal representation changes that do not cross a trust boundary.

## Browser Interpretation Boundaries

Review the context in which the browser ultimately interprets a value, not merely whether it was validated. HTML, attributes, scripts, styles, and URLs require different defenses.

| Criterion | Verdict |
|-----------|---------|
| A low-trust value reaches executable HTML or a script sink without contextual handling | REJECT |
| A low-trust value can select a dangerous URL scheme, open redirect target, or credential destination | REJECT |
| Framework default escaping matches the text or attribute context, with URL allow conditions checked separately | OK |
| Encoding, sanitization, or allowlisting matches the value's use context at the boundary | OK |

## Origins and Requests

CORS controls which origins may read a response in a browser; it is not a substitute for authentication or authorization. For state-changing requests that use automatically sent credentials such as cookies, also verify that an unintended origin cannot initiate the action.

| Criterion | Verdict |
|-----------|---------|
| CORS permission is treated as server-side authorization | REJECT |
| A credentialed request can be initiated from any origin and reach a state change | REJECT |
| Allowed origins are limited to operational need and the server still authorizes the action | OK |

## Files Received from Browsers

Treat filenames, content types, and extensions as low-trust metadata. Trace the storage location, publication behavior, and downstream parser or renderer. Report a problem only when there is a concrete path to execution, overwrite, or reinterpretation as another format.
