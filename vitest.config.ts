import { defineConfig } from 'vitest/config';

// 利用者は日本時間で使うため、テストも日本時間で実行する
// （日付の境界＝午前 0〜9 時の UTC とのずれを、実行環境によらず検証できるようにする）。
process.env.TZ = 'Asia/Tokyo';

// 純関数（src/domain, src/export）と SVG の静的描画のみをテストするため environment は node。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
