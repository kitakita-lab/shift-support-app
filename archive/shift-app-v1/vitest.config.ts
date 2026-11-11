import { defineConfig } from 'vitest/config';

// 最小構成。対象は src/ 内の *.test.ts のみ。
// 純関数のみをテストするため environment は node（jsdom 不要）。
// コンポーネントテストを追加する場合は environment: 'jsdom' への変更と
// @testing-library/react の導入を検討する。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
