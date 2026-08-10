# Dependency and Software Supply Chain Security Knowledge

## Applicability

Apply this Knowledge when a change affects a package manifest, lockfile, dependency resolver, download or install path, build artifact, release pipeline, or CI path. Do not apply it to application code that does not affect dependencies.

## Dependency Components

- A package introduced into an executed path has a known exploitable vulnerability that applies to the resolved version → REJECT candidate
- Maintenance inactivity without a verified vulnerability → Warning
- An unnecessary dependency → Quality suggestion; non-blocking without a concrete security-boundary impact

Do not judge by package name or general reputation. Verify the locked version, used feature, reachability, and advisory preconditions.

## Acquisition and Integrity Boundaries

| Surface | Evidence to inspect |
|---------|---------------------|
| Download source | Who controls the artifact and with which privileges it is used |
| Integrity validation | Existing lock hash, signature, checksum, or equivalent contract |
| Build and release | Whether low-trust input can modify a distributed or executed artifact |
| Install scripts | Code and privileges exercised during package installation |

Do not demand a new signature or checksum as a blocking requirement by itself. Evaluate cases where the change breaks an existing integrity contract or a concrete supply path reaches code execution.
