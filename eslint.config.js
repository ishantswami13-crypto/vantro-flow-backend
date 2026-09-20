// Minimal ESLint flat config.
// Intentionally lightweight: this codebase has never run a linter before
// (large pre-existing files, no prior lint debt paid down), so the goal
// here is to catch real correctness bugs (undefined variables, broken
// syntax patterns, duplicate keys, unreachable code) rather than to
// enforce a style guide or fail CI on the huge volume of pre-existing
// stylistic issues (unused vars, etc.) that would need a dedicated cleanup
// pass.
//
// The error-level rules are now clean, so CI runs this as a blocking step: a
// failure means a real bug, not style debt. The warn-level rules stay
// informational and are free to accumulate without breaking a build.
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
  {
    // .mjs is ES modules by definition, so parsing it as commonjs fails on the
    // first import — a config gap rather than a problem with those files. Both
    // .mjs files in the repo (the Tally connector and its test) were reported
    // as errors purely because of this.
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  },
];
