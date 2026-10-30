/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](ai|@ai-sdk|zod|eventsource-parser)[\\/]/.test(id)) return 'vendor-ai';
          if (/[\\/](@tiptap|prosemirror-[^\\/]+|marked|linkifyjs)[\\/]/.test(id)) return 'vendor-editor';
          if (/[\\/]katex[\\/]/.test(id)) return 'vendor-katex';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
