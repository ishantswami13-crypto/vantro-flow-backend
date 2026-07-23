// Minimal ESLint flat config.
// Intentionally lightweight: this codebase has never run a linter before
// (large pre-existing files, no prior lint debt paid down), so the goal
// here is to catch real correctness bugs (undefined variables, broken
// syntax patterns, duplicate keys, unreachable code) rather than to
// enforce a style guide or fail CI on the huge volume of pre-existing
// stylistic issues (unused vars, etc.) that would need a dedicated cleanup
// pass. See .github/workflows/ci.yml for how this runs in CI
// (continue-on-error: true — informational, not a hard gate, on purpose).
const js = require('@eslint/js');

module.exports = [
  {
    ignores: ['node_modules/**', 'migrations/**', '*.sql'],
  },
  {
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        setImmediate: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        global: 'readonly',
        // Node.js 18+ built-in globals (this repo targets node >=18.0.0 per package.json)
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        performance: 'readonly',
      },
    },
    rules: {
      // Real bugs — keep these as errors.
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-compare': 'error',
      'no-compare-neg-zero': 'error',
      // Noisy on a codebase with no prior lint history — downgrade to
      // warnings so CI can surface them without blocking every existing PR.
      'no-unused-vars': 'warn',
      'no-empty': 'warn',
      'no-case-declarations': 'warn',
      'no-constant-condition': 'warn',
      'no-prototype-builtins': 'warn',
    },
  },
];
