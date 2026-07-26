import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        '**/*.test.js',
        '**/*.smoke.test.js'
      ]
    },
    testMatch: ['test/**/*.smoke.test.js'],
    include: ['test/**/*.smoke.test.js']
  }
});
