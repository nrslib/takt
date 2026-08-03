# Security Review

## Result: REJECT

| finding_id | family_tag | Location | Problem | Suggested fix |
|------------|------------|----------|---------|---------------|
| SEC-NEW-secret-leak-L3 | error-secret-leak | `src/channel.js:3` | The thrown error exposes the raw channel value and may leak a secret. | Remove the raw value from the message. |

The report does not show an error message that interpolates the raw value.
