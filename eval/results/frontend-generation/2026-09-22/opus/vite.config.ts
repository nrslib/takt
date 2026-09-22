import { defineConfig } from 'vite';

// @vitejs/plugin-react は導入していないため、esbuild の automatic runtime で JSX を変換する
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
});
