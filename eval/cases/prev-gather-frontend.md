Review target gathered.

- Target: new files `src/app/routes/user-list.tsx`, `src/features/orders/components/order-panel.tsx`, `src/shared/components/user-avatar.tsx`
- Task intent: add the user list screen, an order panel showing the buyer, and a reusable avatar component
- Layering convention: `app/routes/` -> `features/` -> `shared/` (one-way dependencies; routes stay thin)
- Scope: the inline diff in the review request; working directory contains the post-change state
- Tests: none added in this change
- Report: see `00-review-target.md` in the report directory
