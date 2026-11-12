// 画面上部のお知らせ（共有に反映できなかった変更など）。利用者が閉じるまで残す。
export interface Notice { id: string; kind: 'warn' | 'info'; text: string; at: number }

export const MAX_NOTICES = 50;
/**
 * 増えすぎたら、古い「案内」（info）から落とす。「警告」（warn）＝反映できなかった変更・控えを残した知らせなどは、できるだけ残す
 * （警告だけで上限を超えた場合に限り、古い警告から落とす）。
 */
export function capNotices(list: Notice[]): Notice[] {
  let over = list.length - MAX_NOTICES;
  if (over <= 0) return list;
  const out: Notice[] = [];
  for (const n of list) {
    if (over > 0 && n.kind === 'info') { over -= 1; continue; }
    out.push(n);
  }
  return over > 0 ? out.slice(over) : out;
}
