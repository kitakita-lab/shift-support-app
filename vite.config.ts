import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * ビルドの記録に、共有データの置き場所（環境変数 VITE_TEAM_ID）を 1 行出す。
 * 配信されたビルドが検証用（通常とは別のチーム名を指定したもの）かどうかを、画面を開かなくても、ビルドの記録から確かめられるようにする。
 * 値は秘密ではない（ビルドした JavaScript にそのまま入る）。チーム名の使い方は src/store/paths.ts。
 */
function teamIdLog(mode: string): Plugin {
  return {
    name: 'kkl-team-id-log',
    apply: 'build',
    buildStart() {
      const team = loadEnv(mode, process.cwd(), 'VITE_').VITE_TEAM_ID ?? ''
      console.log(team ? `[kkl] VITE_TEAM_ID=${team}` : '[kkl] VITE_TEAM_ID is not set (default team)')
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), teamIdLog(mode)],
}))
