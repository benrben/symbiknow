import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'data/**', '.venv/**', 'coverage/**', '.quality/**', 'public/webmcp.js'] },
  ...tseslint.configs.recommended,
);
