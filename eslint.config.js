// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allows `const { unwanted, ...rest } = obj` where only `rest` is used — a legitimate,
      // common way to build a "same object minus one field" test fixture. Also allows a
      // deliberately unused parameter when explicitly prefixed `_` — e.g. an interface requires
      // a signal/ctx a given implementation genuinely doesn't need.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // ic-core's renderer (phase 1.12) is the only React code in this repo — scoped here rather
    // than repo-wide since react-hooks/rules-of-hooks doesn't apply outside it.
    files: ['**/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Flags the standard "fetch once on mount, setState with the result" idiom — the pattern
      // every page here uses deliberately, with no framework-level cache/Suspense layer to
      // replace it with. rules-of-hooks/exhaustive-deps (kept above) catch the bugs that matter.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
);
