import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5199,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4199',
        // The API only trusts its own origin, so present requests as coming from it.
        changeOrigin: true,
        headers: { origin: 'http://127.0.0.1:4199' },
      },
    },
  },
});
