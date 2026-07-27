import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import type { Plugin } from 'vite';
import { handleGateway } from './server/gateway-relay.mjs';

const gatewayRelayPlugin = (): Plugin => ({
  name: 'cursem-loopback-gateway',
  configureServer(server) {
    server.middlewares.use('/gateway', (req, res) => { void handleGateway(req, res); });
  },
  configurePreviewServer(server) {
    server.middlewares.use('/gateway', (req, res) => { void handleGateway(req, res); });
  },
});

// CURSE'M IDE — Vite configuration.
//
// §1 Application format:
//   - Configurable base path via CURSEM_BASE_PATH env (defaults to '/').
//   - No hard-coded ports, hostnames, workspace paths, or credentials.
//   - Desktop-first but usable on iPad-sized screens.

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const basePath = env.CURSEM_BASE_PATH || '/';

  return {
    base: basePath,
    plugins: [react(), gatewayRelayPlugin()],

    // Security: restrict the development server to loopback by default.
    server: {
      host: '127.0.0.1',
      port: Number(env.CURSEM_PORT) || 5180,
      strictPort: false,
      cors: env.CURSEM_ALLOWED_ORIGIN
        ? { origin: [env.CURSEM_ALLOWED_ORIGIN] }
        : false,
    },

    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },

    // Monaco worker setup — Vite needs explicit worker entry points.
    worker: {
      format: 'es',
    },

    optimizeDeps: {
      include: [
        'monaco-editor',
        '@xterm/xterm',
      ],
      exclude: [],
    },

    build: {
      outDir: 'dist',
      sourcemap: true,
      // Large Monaco workers are intentional and checked by check-bundle-budget.mjs.
      chunkSizeWarningLimit: 7_500,
    },

    define: {
      __CURSEM_BASE_PATH__: JSON.stringify(basePath),
    },
  };
});
