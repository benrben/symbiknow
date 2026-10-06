import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'data/**', '.venv/**', 'coverage/**', '.quality/**', 'public/webmcp.js',
    'vendor/security-forks/argparse-1.0/**', 'vendor/security-forks/braces/**', 'vendor/security-forks/sprintf-js-1.1/**'] },
  ...tseslint.configs.recommended,
);
