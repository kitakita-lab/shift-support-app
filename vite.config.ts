import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { buildReport, decideTeam, effectiveVercelEnv, type TeamInput } from './src/store/team'

/**
 * 共有データの置き場所（環境変数 VITE_TEAM_ID）を、ビルドの条件から確かめる（決め方は src/store/team.ts）。
 *
 * - ビルドの記録に、ビルドの種類と、共有データの置き場所を出す。配信されたビルドが検証用（通常とは別のチーム名を指定したもの）かどうかを、
 *   画面を開かなくても、ビルドの記録から確かめられるようにする。値は秘密ではない（ビルドした JavaScript にそのまま入る）。
 * - 本番ではないビルド（Vercel のプレビューなど）で、実際の Firebase の設定があるのに、検証用のチーム名が無い・使えない形のときは、
 *   **ビルドを失敗させる**（通常のチーム＝本番のデータにつながるビルドを、作らない）。
 * - 開発サーバー（vite）は止めずに、警告だけ出す（アプリの側が、Firebase を起動しない）。
 *   開発サーバーは、VERCEL_ENV=production が付いていても、本番のビルドとしては扱わない。
 */
function teamGuard(input: TeamInput, command: 'build' | 'serve'): Plugin {
  const report = buildReport(decideTeam(input), input, command)
  return {
    name: 'kkl-team-guard',
    buildStart() {
      for (const line of report.lines) console.log(line)
      if (!report.error) return
      if (command === 'build') this.error(report.error)
      console.warn(report.error)
    },
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const vercelEnv = effectiveVercelEnv(process.env.VERCEL_ENV, command)
  const input: TeamInput = {
    teamId: env.VITE_TEAM_ID, vercelEnv, apiKey: env.VITE_FIREBASE_API_KEY, projectId: env.VITE_FIREBASE_PROJECT_ID,
  }
  return {
    plugins: [react(), teamGuard(input, command)],
    // アプリの側（src/store/paths.ts）が、同じ判定をするための値。Vercel の外では空文字。開発サーバーでは、production にならない
    define: { __KKL_VERCEL_ENV__: JSON.stringify(vercelEnv) },
  }
})
