import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // El build (output: standalone) copia assets —incluidos tests— a .next/.
    // Sin este exclude, una corrida local posterior al build descubre y
    // ejecuta las copias obsoletas duplicando la suite.
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
