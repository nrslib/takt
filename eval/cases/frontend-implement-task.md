Add a reusable `SearchBox` shared component and use it in the user list screen.

Requirements:

- Create `src/shared/components/search-box.tsx` exporting a `SearchBox` component with props `value: string` and `onChange: (value: string) => void`. It renders a text input.
- `SearchBox` is a shared component: it must not import from `features/` or `app/`.
- Replace the inline `<input>` in `src/app/routes/user-list.tsx` with the new `SearchBox`.
- Keep the existing filtering behavior of the user list unchanged.
