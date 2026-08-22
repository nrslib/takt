Plan complete.

- Create `src/shared/components/search-box.tsx` with a `SearchBox` component (`value`, `onChange` props), following the layering rule that `shared/` must not depend on `features/` or `app/`.
- Update `src/app/routes/user-list.tsx` to render `SearchBox` instead of the inline `<input>`, keeping the filter state and behavior as-is.
- No API or routing changes are needed.
