# Resource Ownership Knowledge

## Ownership Chain

A resource lifetime is defined by its owner at acquisition, explicit ownership transfers, last consumer, and release responsibility.


## Release Scope

The presence of release code does not guarantee lifetime safety unless every post-acquisition path enters its protected scope.


## Values Versus Resources

A persisted value differs from a resource that requires explicit release. A missing value alone does not prove a resource leak.

| Observation | Classification |
|-------------|----------------|
| Persistence replaces a value with an empty value | Value wiring or persistence |
| An acquired resource remains unreleased after its last consumer | Resource ownership |
| An optional operation's exception fails the primary result | Failure boundary |
