# Browser Boundary Security Knowledge

## Applicability

Apply when low-trust values reach HTML, JavaScript, CSS, URLs, the DOM, browser storage, or requests that a browser interprets or sends. Static presentation changes and internal representations do not imply this boundary.

## Browser Interpretation Semantics

Browser semantics determine whether a value remains text, becomes executable content, changes an origin or navigation target, or is sent with credentials. A validation or sanitization function name does not establish the resulting browser context.

| Condition | Browser boundary and impact to verify |
|-----------|---------------------------------------|
| A low-trust value reaches HTML, script, style, or a DOM sink | Determine the final parsing context and whether the browser can execute or reinterpret the value in the victim origin |
| A value reaches text or an attribute through framework rendering | Confirm the framework's escaping semantics for that context and separately evaluate URL behavior |
| A value selects a URL, redirect, frame, or resource | Establish allowed schemes, origins, destinations, and whether credentials or protected data accompany the request |
| A value is stored and rendered later | Trace the stored source through the later renderer to the browser sink and affected observer |

Known browser parsing and request behavior can establish execution or credential effects without running a payload when the reachable source-to-sink path is clear.

## Origins and Credentialed Requests

CORS controls which origins may read a response in a browser; it does not establish server-side authorization. For state-changing requests, identify whether the browser automatically attaches cookies or other credentials, which origins can initiate the request, and whether the server independently authenticates, authorizes, and scopes the action.

## Files Received from Browsers

Filenames, content types, and extensions are low-trust metadata. Trace storage location, publication behavior, and downstream parser or renderer. The relevant impact is execution, overwrite, protected-data access, or reinterpretation under a higher-trust origin or service.
