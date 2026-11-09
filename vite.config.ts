/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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

  return {
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' },
    define: byokRelease
      ? {
          'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(''),
          'import.meta.env.VITE_BYOK_ONLY': JSON.stringify('true'),
        }
      : undefined,
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
