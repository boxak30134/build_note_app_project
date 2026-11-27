/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

function readAppBuildMeta() {
  let version = '0.1.0';
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')) as {
      version?: string;
    };
    if (pkg.version) version = pkg.version;
  } catch {
    /* ignore */
  }
  let commit = 'dev';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim() || 'dev';
  } catch {
    /* ignore */
  }
  const builtAt = new Date().toISOString();
  return { version, commit, builtAt };
}

function emitVersionManifestPlugin(meta: { version: string; commit: string; builtAt: string }): Plugin {
  return {
    name: 'eduink-version-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(meta, null, 2),
      });
    },
  };
}

const isReleaseByokBuild =
  process.env.VITE_BYOK_ONLY === 'true' ||
  process.env.VITE_RELEASE_BUILD === 'true' ||
  process.argv.includes('release');

if (!process.env.VITEST && !isReleaseByokBuild && !process.env.VITE_GEMINI_API_KEY) {
  const fallbackEnvKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (fallbackEnvKey) {
    process.env.VITE_GEMINI_API_KEY = fallbackEnvKey;
  }
}

export default defineConfig(({ mode }) => {
  const byokRelease =
    mode === 'release' ||
    process.env.VITE_BYOK_ONLY === 'true' ||
    process.env.VITE_RELEASE_BUILD === 'true';
  const appMeta = readAppBuildMeta();

  return {
    plugins: [
      react(),
      tailwindcss(),
      emitVersionManifestPlugin(appMeta),
      VitePWA({
        registerType: 'prompt',
        manifest: {
          name: 'EduInk Studio',
          short_name: 'EduInk',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          theme_color: '#ffffff',
          background_color: '#ffffff',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any maskable',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallbackDenylist: [/^\/oauth\/callback/, /^\/version\.json/],
        },
      }),
    ],
    worker: { format: 'es' },
    define: {
      __APP_VERSION__: JSON.stringify(appMeta.version),
      __APP_COMMIT__: JSON.stringify(appMeta.commit),
      __APP_BUILT_AT__: JSON.stringify(appMeta.builtAt),
      ...(byokRelease
        ? {
            'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(''),
            'import.meta.env.VITE_BYOK_ONLY': JSON.stringify('true'),
          }
        : {}),
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/](ai|@ai-sdk|@google[\\/]genai|zod|eventsource-parser)[\\/]/.test(id)) return 'vendor-ai';
            if (/[\\/](@tiptap|prosemirror-[^\\/]+|marked|linkifyjs)[\\/]/.test(id)) return 'vendor-editor';
            if (/[\\/]katex[\\/]/.test(id)) return 'vendor-katex';
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: [
        {
          find: /^stream$/,
          replacement: fileURLToPath(new URL('./src/utils/emptyStreamStub.ts', import.meta.url)),
        },
        {
          find: /^node:stream$/,
          replacement: fileURLToPath(new URL('./src/utils/emptyStreamStub.ts', import.meta.url)),
        },
        {
          find: /.*\/src\/utils\/androidDeployment$/,
          replacement: fileURLToPath(new URL('./src/core/android/androidDeployment.ts', import.meta.url)),
        },
      ],
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
    },
  };
});
