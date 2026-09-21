{extends:gui}

# Frontend Policy

Judge URLs, HTML interactions, communication states, accessibility, and values entering or leaving the browser from the actual operation path and screen output.

## URLs and navigation

| Criterion | Decision |
|------|------|
| The screen opens from the URLs, menus, or links required by the specification and Back/Forward returns to the expected display | OK |
| The screen distinguishes an omitted or invalid path/query, a missing target, and insufficient permission | OK |
| The screen reads URL values without handling their type, omission, or invalid value and displays another target | REJECT |
| A screen operation leads to a link or button and history behavior that match the user's intent | OK |

## HTML interactions and accessibility

| Criterion | Decision |
|------|------|
| An element that looks clickable has no name, keyboard behavior, appropriate element, or role | REJECT |
| A form does not relate its input to its label, error, or required state, so users cannot tell what to enter | REJECT |
| States such as selected, expanded, checked, and disabled do not reach assistive technology, so users cannot tell the current state | REJECT |
| After a dialog or menu opens, focus movement, closing, or the return focus target is missing, so users cannot continue the operation | REJECT |
| An edit or delete operation in a list does not identify its target row by name or relationship | REJECT |
| DOM capture/bubble and screen notification cause the same operation to run twice | REJECT |
| Props absent from the installed version are passed, or the generated element's name, role, state, or operation disagrees with the implementation and breaks display, operation, or announcement | REJECT |

Do not decide from whether someone checked an accessible name or role alone; inspect the implementation to see whether users can identify the target and its state.

## Communication states and display

| Criterion | Decision |
|------|------|
| The display distinguishes not started, loading, success, empty, failure, and cancelled | OK |
| Loading or failure is converted to an empty array, leaving users unable to tell whether to wait or retry | REJECT |
| After a failure, users cannot take a required action such as retrying, correcting input, or going back | REJECT |
| Form, click, keyboard, or other entries send the same save twice | REJECT |

## Data fetching, cache, and paging

| Criterion | Decision |
|------|------|
| Conditions that change a result, such as user, tenant, URL, filter, sort, page, and cursor, are in the cache key or dependencies | OK |
| A condition that changes a result is missing from the key, so data from another user or screen is shared | REJECT |
| After an update, there is no invalidation, refetch, or library update, so stale cached data remains displayed | REJECT |
| Cursor or offset order, filter, or snapshot does not match, and duplicate or missing pages cannot be handled | REJECT |
| An existing API client's types, authentication, and error handling are duplicated, so a change is reflected in only one copy | REJECT |

## Browser and server responsibilities

| Criterion | Decision |
|------|------|
| The client treats inventory, payment, authorization, or business state managed and confirmed by the server as confirmed based only on a display decision | REJECT |
| Input format validation, display filters, sorting, and previews are handled as screen state | OK |
| The screen displays an allowed operation or result returned by the server and sends the operation to a server command | OK |
| The same business decision is implemented in multiple layers, leaving the correct result and update path unclear | REJECT |

## Browser safety

| Criterion | Decision |
|------|------|
| A path that sends user input to HTML, script, style, or URL has no escaping or sanitization | REJECT |
| The source and allowed range of values for direct HTML, external navigation, Storage, cookies, and cross-origin requests are readable | OK |
| CSRF, authentication data, or sensitive data handling disagrees with the browser/server contract | REJECT |
| Unvalidated input is passed to `innerHTML` or `eval` and executed as code | REJECT |
