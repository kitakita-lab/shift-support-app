// 共有データの置き場所（チーム名）を、ビルドの条件から 1 つに決める。
//
// 守ること: **通常のチーム（実際の運用で使っているデータ）につながるのは、本番のビルドだけ**。
//   - 本番のビルド（Vercel が VERCEL_ENV=production を付けたビルド） … VITE_TEAM_ID が無ければ、通常のチーム
//   - それ以外（プレビュー・手元）で、実際の Firebase につなぐビルド … 通常とは別のチーム名（VITE_TEAM_ID）が必ず要る。
//     無い・使えない形・通常のチーム名そのもの、のどれかなら、止める（通常のチームには、切り替えない）
//   - 実際の Firebase に届かないビルド（Firebase の設定が無い／架空のプロジェクト＝ID が demo- で始まる。自動テスト） … 通常のチーム名のまま動かしてよい
//
// 「止める」の中身は 2 つで、どちらも、この判定（decideTeam）を使う。
//   - ビルド（vite.config.ts） … 失敗させる（配信できるものを作らない。Vercel では、その URL は前のビルドのまま残る）
//   - アプリ（paths.ts・firebase.ts） … Firebase を起動しない（ログインも、共有データも使わない。この端末だけのデータで動く）
//
// これは、誤って通常の共有データを操作しないための仕組みで、権限の境界ではない（誰が何を読み書きできるかは、Firestore のルールが決める）。
// このファイルは、ほかのファイルを読み込まない（vite.config.ts が Node で読むため）。

/** 通常の（実際の運用で使っている）チームの名前 */
export const DEFAULT_TEAM_ID = 'intention-dev';
/** 止めたときに、チーム名の代わりに使う値。Firestore が ID として受け付けない形（__…__）で、どの場所にも当たらない */
export const BLOCKED_TEAM_ID = '__blocked__';

/** ビルドの種類。production は、Vercel が本番と示したビルドだけ。preview は、Vercel のそれ以外。local は、Vercel の外（手元・自動テスト） */
export type BuildEnv = 'production' | 'preview' | 'local';
/** つなぐ先の Firebase。real＝実際のプロジェクト／demo＝架空のプロジェクト（エミュレータ用）／none＝設定なし */
export type FirebaseKind = 'real' | 'demo' | 'none';
/** 止める理由。unset＝チーム名が無い／invalid＝チーム名が使えない形／production-team＝本番以外のビルドに、通常のチーム名が指定されている */
export type BlockReason = 'unset' | 'invalid' | 'production-team';

export interface TeamInput {
  /** 環境変数 VITE_TEAM_ID */
  teamId?: string | null;
  /** Vercel が付ける VERCEL_ENV（production／preview／development）。Vercel の外では、無い */
  vercelEnv?: string | null;
  /** 環境変数 VITE_FIREBASE_API_KEY・VITE_FIREBASE_PROJECT_ID */
  apiKey?: string | null;
  projectId?: string | null;
}

export type TeamDecision =
  /** explicit: VITE_TEAM_ID に書いてあった（false は、書いていないので通常のチームにした）。verify: 検証用のビルド（通常とは別のチーム） */
  | { ok: true; env: BuildEnv; firebase: FirebaseKind; teamId: string; explicit: boolean; verify: boolean }
  | { ok: false; env: BuildEnv; firebase: FirebaseKind; reason: BlockReason };

/** チーム名として使える形: 英小文字で始まり、英小文字・数字・ハイフンだけ、3〜40 文字（空白・「/」・「.」・大文字は不可） */
const VALID_TEAM_ID = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const isValidTeamId = (v: unknown): v is string => typeof v === 'string' && VALID_TEAM_ID.test(v);

/** 本番と言えるのは、VERCEL_ENV が、ちょうど production のときだけ（分からないときは、本番として扱わない） */
export function buildEnvOf(vercelEnv: string | null | undefined): BuildEnv {
  if (vercelEnv === 'production') return 'production';
  return vercelEnv ? 'preview' : 'local';
}

/**
 * 判定に使う VERCEL_ENV。本番として扱うのは、ビルド（vite build）だけ。
 * 開発サーバー（vite）は、VERCEL_ENV=production が付いていても、本番のビルドではない（手元の localhost から、本番のデータにつながない）。
 */
export function effectiveVercelEnv(vercelEnv: string | null | undefined, command: 'build' | 'serve'): string {
  const v = vercelEnv ?? '';
  return command === 'serve' && v === 'production' ? 'development' : v;
}

export function firebaseKindOf(apiKey: string | null | undefined, projectId: string | null | undefined): FirebaseKind {
  if (!apiKey || !projectId) return 'none';
  return projectId.startsWith('demo-') ? 'demo' : 'real';
}

export function decideTeam(input: TeamInput): TeamDecision {
  const env = buildEnvOf(input.vercelEnv);
  const firebase = firebaseKindOf(input.apiKey, input.projectId);
  const raw = input.teamId ?? '';
  // 使えない形の値は、どのビルドでも止める（設定の誤りを、通常のチームへの切り替えで隠さない）
  if (raw !== '' && !isValidTeamId(raw)) return { ok: false, env, firebase, reason: 'invalid' };
  if (raw !== '' && raw !== DEFAULT_TEAM_ID) return { ok: true, env, firebase, teamId: raw, explicit: true, verify: true };
  // ここから下は、通常のチームを使うことになる場合（書いていない、または、通常のチーム名が書いてある）
  if (env === 'production' || firebase !== 'real') {
    return { ok: true, env, firebase, teamId: DEFAULT_TEAM_ID, explicit: raw !== '', verify: false };
  }
  return { ok: false, env, firebase, reason: raw === '' ? 'unset' : 'production-team' };
}

/** 止めた理由（画面とビルドの記録に出す） */
export const BLOCK_TEXT: Record<BlockReason, string> = {
  unset: '本番ではないビルドに、共有データの場所（VITE_TEAM_ID）が設定されていません',
  invalid: '共有データの場所（VITE_TEAM_ID）の値が、使えない形です（英小文字で始まる、英小文字・数字・ハイフンの 3〜40 文字）',
  'production-team': '本番ではないビルドに、本番の共有データの場所が指定されています',
};

/**
 * 止めたあとに、何を直せばよいか。ビルドの種類と理由で変える: 本番のビルドに、検証用のチーム名を入れさせないため
 * （入れると、ビルドは通るが、本番が検証用の場所を指す）。
 */
function remedy(d: Extract<TeamDecision, { ok: false }>): string[] {
  const fix = d.reason === 'invalid'
    ? '検証用のビルドなら、VITE_TEAM_ID を、検証用のチーム名（例: kkl-preview）に直してください。'
    : '検証用のビルド（Vercel の Preview・手元）なら、VITE_TEAM_ID に、検証用のチーム名（例: kkl-preview）を設定してください。';
  // 本番のビルドで止まるのは、値が使えない形のときだけ
  if (d.env === 'production') return ['本番のビルドです。Production 環境の VITE_TEAM_ID を、消してください（本番には、設定しません）。検証用のチーム名は、入れないでください。'];
  // Vercel が「本番ではない」と示したビルド
  if (d.env === 'preview') return [fix];
  // VERCEL_ENV が渡っていないビルド。手元のほか、Vercel の本番のビルドで、VERCEL_ENV が渡っていない場合も、ここに来る
  return [
    fix,
    '本番のビルド（Vercel の Production）でこの表示が出た場合は、VITE_TEAM_ID に、検証用のチーム名を入れないでください。',
    'Vercel が VERCEL_ENV=production を渡していません（プロジェクトの設定「Automatically expose System Environment Variables」を確かめてください）。',
    d.reason === 'invalid' ? 'あわせて、Production 環境の VITE_TEAM_ID を、消してください（本番には、設定しません）。' : '本番の配信は、前のビルドのまま残っています。',
  ];
}

/**
 * ビルドの記録に出す行と、止めるときのメッセージ。
 * 「[kkl] VITE_TEAM_ID=…」の行は、配信されたビルドが検証用かどうかを、画面を開かなくても確かめるためのもの（値は秘密ではない）。
 * command: build＝ビルド（止めるときは、失敗させる）／serve＝開発サーバー（止めずに、アプリが Firebase を起動しないことを知らせる）
 */
export function buildReport(d: TeamDecision, input: TeamInput, command: 'build' | 'serve' = 'build'): { lines: string[]; error: string | null } {
  const what = command === 'build' ? 'build' : 'dev server';
  const head = `[kkl] ${what}: ${d.env} (${input.vercelEnv ? `VERCEL_ENV=${input.vercelEnv}` : 'VERCEL_ENV is not set'}), firebase: ${d.firebase}`;
  if (d.ok) {
    const team = d.verify ? `[kkl] VITE_TEAM_ID=${d.teamId}`
      : d.explicit ? `[kkl] VITE_TEAM_ID=${d.teamId} (default team)`
      : '[kkl] VITE_TEAM_ID is not set (default team)';
    return { lines: [head, team], error: null };
  }
  const shown = d.reason === 'unset' ? 'is not set' : `= ${JSON.stringify(String(input.teamId)).slice(0, 80)}`;
  const first = command === 'build'
    ? [`[kkl] Build stopped for safety (${d.reason}): VITE_TEAM_ID ${shown}.`, `安全のため、ビルドを止めました: ${BLOCK_TEXT[d.reason]}。`]
    : [`[kkl] Firebase is switched off in this dev server (${d.reason}): VITE_TEAM_ID ${shown}.`, `この開発サーバーのアプリは、Firebase を起動しません（ログイン・共有データは使えません）: ${BLOCK_TEXT[d.reason]}。`];
  return {
    lines: [head, `[kkl] VITE_TEAM_ID ${shown} -> STOPPED (${d.reason})`],
    error: [
      ...first,
      `Only a production build (VERCEL_ENV=production) may use the default team "${DEFAULT_TEAM_ID}"; it must not have VITE_TEAM_ID set to another name.`,
      'Every other build that has real Firebase settings needs VITE_TEAM_ID set to a separate, valid team name.',
      `本番のデータ（${DEFAULT_TEAM_ID}）につながるビルドは、本番のビルドでしか作りません。`,
      ...remedy(d),
    ].join('\n'),
  };
}
