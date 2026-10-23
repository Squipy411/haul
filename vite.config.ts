import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = 'http://127.0.0.1:60700';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/addon', '/stream-file', '/stream-sub', '/addon-poster', '/health'].map((path) => [path, server]))
  }
});
