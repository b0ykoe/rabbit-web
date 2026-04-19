import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8')
);

export default defineConfig({
  plugins: [react()],
  define: {
    // Baked in at build-time from client/package.json — readable as a
    // global identifier in any client source file.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log('[proxy] error:', err.message);
          });
        },
      },
    },
  },
});
