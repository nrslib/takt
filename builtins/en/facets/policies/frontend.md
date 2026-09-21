{extends:gui}

# Frontend Policy

Judge URLs, screen navigation, HTML operations, communication states, accessibility, browser safety, and change impact through screen responsibilities.

## Principles

| Principle | Criterion |
|-----------|-----------|
| URL and screen | Trace URL-to-screen entry, history, and parameter handling |
| HTML operation | Treat native element behavior, forms, focus, and default actions as user-facing contracts |
| Communication state | Reflect loading, success, empty, failure, and cancellation in display and operations |
| Accessibility | Check accessible name, role, state, keyboard operation, and focus |
| Browser safety | Trace values entering HTML, URLs, storage, cookies, and cross-origin requests |
| Change path | Separate reasons to change generic display, screen behavior, state, and communication |
| Evidence | Judge conditions confirmed by code, specifications, actual entries, and outputs |

## URLs and screen navigation

| Criterion | Judgment |
|-----------|----------|
| A new screen cannot be reached from the router or framework entry | REJECT |
| The screen reads path, query, or hash values without handling types, omission, or invalid input | REJECT |
| A screen control or link connects user intent to the matching navigation and history operation | OK |
| Direct URL, back/forward, missing resource, and insufficient permission are represented as screen states | OK |
| A route is added while menus, links, or external entries included in the change are not wired | REJECT |

## HTML operations and accessibility

| Criterion | Judgment |
|-----------|----------|
| A visually interactive element has no accessible name, keyboard operation, or suitable element/role | REJECT |
| Form controls and labels are not associated, so users cannot identify errors or required state | REJECT |
| Selected, expanded, checked, or disabled state is not exposed to assistive technology | REJECT |
| Dialog or menu opening leaves focus movement, closing operation, or restoration broken | REJECT |
| An operation in a repeated list cannot identify its target by name or row/group association | REJECT |
| A generated accessible name is empty, misleading, or meaningless when announced | REJECT |
| A change to accessible name, role, or wording makes the target unidentifiable or its state unintelligible | REJECT |
| DOM capture/bubble and application intent notification execute the same operation twice | REJECT |
| Unsupported props or element structure in the installed UI library break rendering, interaction, or accessibility | REJECT |

## Communication states and display

| Criterion | Judgment |
|-----------|----------|
| Loading, empty, failure, and cancellation use one display or empty array, so the user has no recovery choice | REJECT |
| A communication failure has no traceable retry, correction, or back operation | REJECT |
| A generic display component owns a screen-specific URL, API, retry, or navigation procedure | REJECT |
| The screen or region communication owner passes display parameters and operation entries to the display component | OK |
| One user operation invokes communication twice through form, click, or parent callback paths | REJECT |

## Data retrieval, cache, and pagination

| Criterion | Judgment |
|-----------|----------|
| A URL, user, tenant, filter, sort, page, or cursor that changes the result is missing from a cache key or dependency, so different data is shared | REJECT |
| An update leaves stale display as canonical because invalidation, refetch, or contract-compliant cache update is absent | REJECT |
| Cursor or offset retrieval has no condition for continuity, duplicates, gaps, or reordered results | REJECT |
| A query, handwritten request, or screen-held snapshot satisfies retrieval conditions and the update path | OK |
| Types, authentication, or error handling for the same API are duplicated outside the existing client, so changes reach only one path | REJECT |

## Frontend and server responsibilities

| Criterion | Judgment |
|-----------|----------|
| A client display decision treats server-managed inventory, payment, authorization, or business state as finalized | REJECT |
| Input-format feedback, display filters, sorting, and previews are handled as UI state | OK |
| UI renders server-authorized state and sends operations to a server command | OK |
| The same business decision is reimplemented in multiple layers, leaving authority and result propagation unclear | REJECT |

## Browser safety

| Criterion | Judgment |
|-----------|----------|
| User input enters HTML, script, URL, or style without an escaping or sanitization boundary | REJECT |
| The source and allowed range for direct HTML, external navigation, storage, cookies, or cross-origin requests cannot be traced | REJECT |
| CSRF, credentials, or sensitive data handling does not match the server communication contract | REJECT |
| A dangerous browser API is used without a code-traceable need and input boundary | REJECT |

## Structure and changeability

| Criterion | Judgment |
|-----------|----------|
| A generic display component directly couples to screen communication, URL, or state transitions, so a display change requires screen processing changes | REJECT |
| Equivalent display, failure, or operation contracts are rebuilt separately across screens and drift after one changes | REJECT |
| Display components handle render parameters and operation intent while screen or region owners handle communication and transitions | OK |
| Component sharing and splitting are explained by responsibility, reason to change, and reuse unit | OK |
| Props are delegated without changing meaning and the operation and state owner remain traceable | Check change impact |
