import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import * as path from 'path'
import { execSync } from 'child_process'

// Get git hash at build time (fallback to 'dev' if not in git repo)
const getGitHash = () => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

const apiTarget = process.env.LATTICE_API_TARGET || 'http://localhost:3001'

// Dev-only: point the toolkit import at a source checkout instead of the installed
// dist copy, so toolkit edits show up on save without a rebuild + reinstall. Also
// adds that checkout to Tailwind's sources, since index.css only scans the dist.
//   LATTICE_TOOLKIT_SRC=/path/to/agent-ui-toolkit/src npx vite
const toolkitSrc = process.env.LATTICE_TOOLKIT_SRC
const toolkitSourcePlugin = () => ({
  name: 'lattice-toolkit-source',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!toolkitSrc || !id.endsWith('/web/styles/index.css')) return
    return { code: `@source "${toolkitSrc}";\n${code}`, map: null }
  },
})

const getManualChunk = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined
  if (
    id.includes('/react/')
    || id.includes('/react-dom/')
    || id.includes('/scheduler/')
    || id.includes('react-router')
    || id.includes('@tanstack/react-query')
  ) {
    return 'vendor-react'
  }
  if (
    id.includes('react-markdown')
    || id.includes('remark-')
    || id.includes('rehype-')
    || id.includes('unified')
    || id.includes('micromark')
    || id.includes('mdast-util')
    || id.includes('hast-util')
    || id.includes('unist-')
  ) {
    return 'vendor-markdown'
  }
  if (id.includes('@radix-ui/react-slot') || id.includes('@radix-ui/react-collapsible')) return 'vendor-radix'
  return undefined
}

export default defineConfig({
  root: 'src/web',
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_HASH__: JSON.stringify(getGitHash()),
  },
  plugins: [
    toolkitSourcePlugin(),
    react(),
    tailwindcss(),
    visualizer({
      filename: 'bundle-analysis.html',
      open: false,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  publicDir: '../../public',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      ...(toolkitSrc ? { '@liggi/agent-ui-toolkit': path.resolve(toolkitSrc, 'index.ts') } : {}),
    },
    // One React: the toolkit checkout has its own node_modules.
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'src/web/index.html')
      },
      output: {
        manualChunks: getManualChunk,
      },
    }
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    // Tailscale MagicDNS names are allowed by default; add others (comma-separated)
    // with LATTICE_ALLOWED_HOSTS.
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.ts.net',
      ...(process.env.LATTICE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean) ?? []),
    ],
    proxy: {
      // Defaults to the usual local API. Override with LATTICE_API_TARGET to point a
      // dev UI at an API running on another port — e.g. when a checkout's server is
      // running on 3001 and you want to preview a second one without stopping it.
      '/api': apiTarget,
      '/ambient-watch': {
        target: 'http://127.0.0.1:43117',
        rewrite: (path) => path.replace(/^\/ambient-watch/, ''),
      },
      '/ambient/': apiTarget,
    },
  }
})
