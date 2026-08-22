# API and Server Security Knowledge

## Applicability

Apply when a low-trust request reaches server-side authentication, authorization, resource selection, an interpreter, an outbound connection, or persistence. An endpoint's presence alone does not establish a changed boundary.

## Input-to-Interpreter and Destination Boundaries

SQL, templates, query languages, expressions, and outbound destinations interpret values under server authority. Trace which portion remains data and which portion can become instructions or a destination.

| Condition | Boundary and impact to verify |
|-----------|-------------------------------|
| A request value is concatenated into a query or template instruction | Trace the request source to the interpreter and the database or service operations available to its authority |
| A request URL or host selects an outbound destination | Establish reachable schemes, hosts, redirects, internal targets, and attached credentials |
| Parameter binding or a structured builder is used | Confirm that the value remains data at the interpreter boundary |
| A destination is constrained | Confirm that scheme, host, redirects, and credentials remain within the required set |

A static code path can establish the chain from request input through concatenation or resource selection to the interpreter and protected asset. A successful attack PoC is not required when the code and known interpreter behavior establish every link and concrete impact.

## Authentication, Authorization, and Resource Scope

Authentication establishes the caller; authorization establishes allowed actions; resource scope establishes which owner, tenant, workspace, or account the action may affect. Route middleware alone does not prove resource scope.

| Condition | Boundary and impact to verify |
|-----------|-------------------------------|
| A protected resource is loaded or changed by request-provided ID | Determine whether the operation also constrains ownership scope from the authenticated caller |
| Reads apply scope but corresponding updates or deletes do not | Trace whether a caller can modify another ownership domain |
| A client-provided owner, tenant, or role overrides caller identity | Identify the independent authorization that permits the override, if any |
| Scope is derived from the authenticated caller | Confirm that the same constraint reaches every relevant read and write operation |

## Input, Output, and Resource Contracts

Types, formats, enumerations, lengths, and counts matter when the downstream contract depends on them. Missing validation or rate limiting becomes security evidence only with a path to authority bypass, interpretation, protected output, or realistic resource exhaustion. For responses and errors, identify which caller or observer can receive credentials, internal details, or another resource's content.
