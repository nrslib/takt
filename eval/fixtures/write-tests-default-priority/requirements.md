# Retry menu requirements

- The failed restart leaf is the default row and receives the initial cursor.
- A valid Resume checkpoint remains available as a separate selectable action.
- Resume preserves prior execution state; Restart from a leaf starts fresh from that leaf. They are not equivalent actions.
