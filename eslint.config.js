import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  // Global ignores — must be a standalone config object with only `ignores`
  {
    ignores: [
      'node_modules/',
      '**/dist/**',
      // Build scripts emit several sibling directories such as dist-server,
      // dist-server-artifact, dist-renderer-artifact, and dist-computer-use.
      // Keep the naming contract here instead of chasing every new output.
      'dist-*/**',
      // Desktop Vite builds use the same family for dist-renderer and
      // dist-splash; both contain bundled JavaScript that must not be linted.
      'desktop/dist-*/**',
      'desktop/native/**/.build/**',
      '.claude/**',
      '.cache/**',
      'build/.cli-closure-*/**',
      'build/.cli-closure-*.mjs',
      // .docs/ 不入版本控制、CI 不可见；lint 覆盖它会造成本地/CI 语义不对称
      '.docs/**',
      '**/*.cjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Browser JS files (pre-React bootstrap layer: i18n, theme, platform)
  {
    files: ['desktop/src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Shared CJS-style JS (loaded via require from preload.cjs; runs in preload context)
  {
    files: ['desktop/src/shared/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Node-side JS files
  {
    files: [
      'cli/**/*.{js,ts}',
      'core/**/*.{js,ts}',
      'hub/**/*.{js,ts}',
      'index.js',
      'lib/**/*.{js,ts}',
      'plugins/**/*.{js,ts}',
      'scripts/**/*.{js,mjs,ts}',
      'tools/npm-ea/**/*.mjs',
      'server/**/*.{js,ts}',
      'shared/**/*.{js,ts}',
      'tests/**/*.{js,ts,tsx}',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },

  // Vitest files mix Node helpers with jsdom/browser primitives.
  {
    files: ['tests/**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  // Browser package TypeScript files
  {
    files: [
      'packages/plugin-sdk/src/**/*.ts',
      'packages/plugin-components/src/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // TypeScript/React frontend files
  {
    files: [
      'desktop/src/**/*.{ts,tsx}',
      'packages/plugin-components/src/**/*.{ts,tsx}',
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // React components should render with JSX. DOM utilities, CodeMirror widgets,
  // and tests may create DOM nodes directly.
  {
    files: ['desktop/src/react/**/*.tsx'],
    ignores: [
      'desktop/src/react/**/__tests__/**',
      'desktop/src/react/**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name='createElement']",
          message:
            'React 组件中不要用 document.createElement，用 JSX。如确需操作 DOM（canvas/resize），加 eslint-disable 注释说明原因。',
        },
      ],
    },
  },

  // Downgrade noisy recommended rules to warnings (non-architectural, fix incrementally)
  {
    rules: {
      'no-empty': 'warn',
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // 禁止绕过 adapter 直接导入 PI SDK（后端全覆盖）
  {
    files: ['core/**/*.{js,ts}', 'lib/**/*.{js,ts}', 'hub/**/*.{js,ts}', 'server/**/*.{js,ts}'],
    ignores: ['lib/pi-sdk/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@mariozechner/*', '@earendil-works/*'],
          message: '请从 lib/pi-sdk/index.js 导入，不要直接引用 PI SDK 包。',
        }],
      }],
    },
  },

  // Prevent engine._ access in server routes
  {
    files: ['server/routes/**/*.{js,ts}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='engine'][property.name=/^_/]",
          message: '不要访问 engine 的私有方法。通过 engine 公开 API 访问。',
        },
      ],
    },
  },
];
