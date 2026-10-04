# Initial security review: credential written to logs

Review only this supplied change:

```typescript
const authorization = `Bearer ${process.env.PRODUCTION_API_TOKEN}`
logger.info('outbound request', { authorization })
await sendRequest({ authorization })
```

The token grants production account write access. The centralized log is readable by support contractors who are not authorized for the production secret store or account. The logger serializes the `authorization` field unchanged at this enabled level. The token is not attacker-supplied.

Produce the initial security-review result and identify the concrete unauthorized observer, output path, protected credential, and resulting capability.
