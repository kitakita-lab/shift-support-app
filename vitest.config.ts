import { defineConfig } from 'vitest/config';

// 純関数（src/domain, src/export）のみをテストするため environment は node。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
