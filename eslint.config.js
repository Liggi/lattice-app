import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'dist/**',
      'src/web/dist/**',
      'src/web/dist-staging/**',
      'scripts/**',
      'public/**',
      'test/behavioral/agent-stub/**',
      'playwright.config.ts',
      'playwright.behavioral.config.ts',
      'vitest.config.ts',
      'tailwind.config.js',
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: ['./tsconfig.json', './tsconfig.web.json']
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        require: 'readonly',
        global: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        NodeJS: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // These rules flag intentional patterns (ANSI escape codes, emoji regex)
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
      // Stylistic rules that don't indicate bugs
      'no-case-declarations': 'off',
      'no-useless-escape': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',

      // ============================================================
      // TYPE-CHECKED ASYNC RULES - Catch silent async failures
      // ============================================================
      // Catches fire-and-forget promises that can silently fail
      '@typescript-eslint/no-floating-promises': 'error',
      // Catches promises in wrong contexts (e.g., if(promise) instead of if(await promise))
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: {
          // Allow async event handlers (common React pattern)
          attributes: false
        }
      }],
      // Catches awaiting non-promises (usually a programmer error)
      '@typescript-eslint/await-thenable': 'error',
      // In try/catch, await the return to capture errors properly
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // ============================================================
      // STRICTER TYPE SAFETY - Catch type holes
      // ============================================================
      // Disallow calling `any` typed values (catches obj.foo() where obj is any)
      '@typescript-eslint/no-unsafe-call': 'warn',
      // Disallow member access on `any` typed values (catches obj.foo where obj is any)
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      // Disallow returning `any` from functions (type info leaks out)
      '@typescript-eslint/no-unsafe-return': 'warn',
      // Disallow assigning `any` to variables (type info lost)
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      // Disallow passing `any` as arguments (type info ignored)
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Require explicit return types on exported functions (public API clarity)
      '@typescript-eslint/explicit-module-boundary-types': ['warn', {
        allowArgumentsExplicitlyTypedAsAny: true
      }],
      // Catch template literals with objects that produce [object Object]
      '@typescript-eslint/restrict-template-expressions': ['warn', {
        allowNumber: true,
        allowBoolean: true,
        allowNullish: true,
        allowRegExp: true
      }],

      // ============================================================
      // CUSTOM RULES - Project-specific bug prevention
      // ============================================================
      'no-restricted-syntax': [
        'error',
        // Ban h-screen in favor of h-dvh for mobile viewport compatibility
        // h-screen (100vh) breaks on mobile browsers where the URL bar affects viewport height
        {
          selector: 'Literal[value=/\\bh-screen\\b/]',
          message: 'Use h-dvh instead of h-screen for mobile viewport compatibility. See: https://tailscan.com/blog/tailwind-css-dynamic-viewport-unit-classes'
        },
        {
          selector: 'TemplateElement[value.raw=/\\bh-screen\\b/]',
          message: 'Use h-dvh instead of h-screen for mobile viewport compatibility. See: https://tailscan.com/blog/tailwind-css-dynamic-viewport-unit-classes'
        },
        // Ban 100vh in inline styles (same mobile viewport issue)
        {
          selector: 'Literal[value=/100vh/]',
          message: 'Use 100dvh instead of 100vh for mobile viewport compatibility.'
        },
        {
          selector: 'TemplateElement[value.raw=/100vh/]',
          message: 'Use 100dvh instead of 100vh for mobile viewport compatibility.'
        },
        // Ban outdated Claude model IDs - AI training data gets stale
        // Claude 3.x series (claude-3-haiku-*, claude-3-5-sonnet-*, etc.)
        {
          selector: 'Literal[value=/^claude-3-(?:haiku|sonnet|opus)-\\d{8}$/]',
          message: 'Outdated Claude 3.x model ID. Use Claude 4.5+ models. See CLAUDE.md for current IDs.'
        },
        {
          selector: 'Literal[value=/^claude-3-\\d+-(?:haiku|sonnet|opus)-\\d{8}$/]',
          message: 'Outdated Claude 3.x model ID. Use Claude 4.5+ models. See CLAUDE.md for current IDs.'
        },
        // Claude 4.0 series (hypothetical but catch them if AI hallucinates them)
        {
          selector: 'Literal[value=/^claude-(?:haiku|sonnet|opus)-4-0-\\d{8}$/]',
          message: 'Outdated Claude 4.0 model ID. Use Claude 4.5+ models. See CLAUDE.md for current IDs.'
        },
        // Ban direct JSON.parse — returns `any`, defeating type safety.
        // Use parseJson() from utils/json.ts which returns `unknown`.
        {
          selector: 'CallExpression[callee.object.name="JSON"][callee.property.name="parse"]',
          message: 'Use parseJson() from utils/json.ts instead of JSON.parse(). parseJson returns `unknown`, forcing proper type narrowing.'
        }
      ]
    }
  },
  {
    // Browser globals and React hooks for web files
    files: ['src/web/**/*.ts', 'src/web/**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks
    },
    languageOptions: {
      globals: {
        React: 'readonly',
        JSX: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        location: 'readonly',
        history: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        EventSource: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLDivElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        NodeList: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WebSocket: 'readonly',
        MediaRecorder: 'readonly',
        AudioContext: 'readonly',
        AnalyserNode: 'readonly',
        Uint8Array: 'readonly',
        Float32Array: 'readonly',
        Image: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        DragEvent: 'readonly',
        ClipboardEvent: 'readonly',
        Touch: 'readonly',
        TouchEvent: 'readonly',
        PointerEvent: 'readonly',
        FocusEvent: 'readonly',
        WheelEvent: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        matchMedia: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        // Vite build-time constants (injected via vite.config.mts define)
        __BUILD_TIME__: 'readonly',
        __GIT_HASH__: 'readonly'
      }
    },
    rules: {
      // React hooks rules - catches stale closures, missing deps
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly'
      }
    },
    rules: {
      // Relax some rules for tests
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off'
    }
  }
];
