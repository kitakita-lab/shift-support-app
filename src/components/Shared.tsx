// 共有データまわりの画面部品: 置き場所の帯／お知らせ／共有データを使えないときの案内（移行を含む）／メンバー名簿。
import { useCallback, useEffect, useState } from 'react';
import { AppStore, Notice, Space } from '../store/useAppData';
import { Member, SharedSession, SharedView } from '../store/sharedSession';
import { MigrationReport } from '../store/sharedLogic';

// ── 置き場所の帯（いまどちらのデータを見ているかを、常に表示する） ──────────────
export function SpaceBar({ store, signedIn, configured }: { store: AppStore; signedIn: boolean; configured: boolean }) {
  const { space, shared } = store;
  // テスト用の目印: 画面に出ているデータ（共有を選んでいて、まだ使えない間は none）
  const shown = space === 'local' ? 'local' : shared.phase === 'ready' ? 'shared' : 'none';
  const pick = (s: Space) => () => store.setSpace(s);
  return (
    <div className={`spacebar spacebar--${space}`} data-testid="space" data-space={shown} data-phase={shared.phase}>
      <span className="spacebar__label">表示中のデータ</span>
      {signedIn ? (
        <span className="seg">
          <button data-testid="space-shared" className={space === 'shared' ? 'is-on' : ''} onClick={pick('shared')}>共有データ</button>
          <button data-testid="space-local" className={space === 'local' ? 'is-on' : ''} onClick={pick('local')}>この端末だけのデータ</button>
        </span>
      ) : (
        <b>この端末だけのデータ</b>
      )}
      <span className="spacebar__note">
        {space === 'shared'
          ? 'チームで共有しているデータです。変更はメンバー全員に反映されます。'
          : signedIn
            ? 'このブラウザの中だけに保存されます。共有データには反映されません（サンプルや下書きはこちら）。'
            : configured
              ? 'このブラウザの中だけに保存されます。ログインすると、チームの共有データを使えます。'
              : 'このブラウザの中だけに保存されます。'}
      </span>
      {space === 'shared' && shared.phase === 'ready' && !shared.enforced && (
        <span className="spacebar__warn" title="現在は、Google アカウントでログインできる人なら誰でも共有データを読み書きできます。「メンバー」タブを参照してください。">⚠ メンバー制 未適用</span>
      )}
    </div>
  );
}

// ── お知らせ（共有に反映できなかった変更など。閉じるまで残る） ──────────────────
export function NoticeList({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: string) => void }) {
  if (notices.length === 0) return null;
  return (
    <ul className="notices" data-testid="notices">
      {notices.map((n) => (
        <li key={n.id} className={`notices__item notices__item--${n.kind}`}>
          <span>{n.kind === 'warn' ? '⚠ ' : ''}{n.text}</span>
          <button className="cellbtn" onClick={() => onDismiss(n.id)}>閉じる</button>
        </li>
      ))}
    </ul>
  );
}

// ── 移行の結果（件数表） ─────────────────────────────────────────────
export function ReportTable({ report }: { report: Pick<MigrationReport, 'rows' | 'notes' | 'mismatches' | 'ok'> }) {
  return (
    <>
      <table className="grid report" data-testid="migration-report" data-ok={report.ok ? '1' : '0'}>
        <thead><tr><th>種類</th><th>移行元</th><th>移行先（一致した件数）</th><th>照合</th></tr></thead>
        <tbody>
          {report.rows.map((r) => (
            <tr key={r.label}>
              <td className="is-ro"><div className="grid__ro">{r.label}</div></td>
              <td className="is-ro"><div className="grid__ro num">{r.source}</div></td>
              <td className="is-ro"><div className="grid__ro num">{r.target}</div></td>
              <td className={r.match ? 'is-ro' : 'is-warn'}><div className="grid__ro">{r.match ? '一致' : '不一致'}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.mismatches.length > 0 && <p className="hint">一致しなかったデータ: {report.mismatches.slice(0, 10).join('、')}{report.mismatches.length > 10 ? ' ほか' : ''}</p>}
      {report.notes.map((t, i) => <p key={i} className="hint">※ {t}</p>)}
    </>
  );
}

const COUNT_LABELS: [string, string][] = [
  ['projects', '案件'], ['staff', 'スタッフ'], ['venues', '会場'], ['contents', 'コンテンツ'], ['partTypes', 'パーツ'], ['composites', '組み合わせ配置'],
];

// ── 共有データを使えないときの案内 ─────────────────────────────────────
export function SharedPhasePanel({ shared, session, onUseLocal }: { shared: SharedView; session: SharedSession | null; onUseLocal: () => void }) {
  const admin = shared.role === 'owner' || shared.role === 'open';
  const meta = shared.meta;
  const useLocal = <button onClick={onUseLocal}>「この端末だけのデータ」を表示する</button>;
  let body: JSX.Element;
  switch (shared.phase) {
    case 'unregistered':
      body = (
        <>
          <div className="panel__title">このアカウントは、チームに登録されていません</div>
          <p>ログイン中のアカウント（{shared.email || 'メールアドレス不明'}）は、メンバー名簿にありません。共有データは表示できません。</p>
          <p className="hint">共有データを使うには、管理者にこのメールアドレスの登録を依頼してください。「この端末だけのデータ」は、これまでどおり使えます。</p>
          <div className="panel__btns">{useLocal}<button onClick={() => void session?.check()}>登録されたので、もう一度確認する</button></div>
        </>
      );
      break;
    case 'needs-init':
      body = admin ? (
        <>
          <div className="panel__title">共有データは、まだ用意されていません</div>
          <p>このチームの共有データを使い始めますか？ 始めると、共有側にパーツと組み合わせ配置の初期値が作られ、メンバーが案件やマスタを登録できるようになります。</p>
          <p className="hint">ボタンを押すまで、共有側には何も書き込みません。「この端末だけのデータ」は、これまでどおり使えます。</p>
          {shared.error && <p className="neg" data-testid="shared-error">{shared.error}</p>}
          <div className="panel__btns">
            <button className="primary" data-testid="init-shared" disabled={!!shared.job} onClick={() => void session?.startFresh()}>{shared.job || '共有データを使い始める'}</button>
            {useLocal}
          </div>
        </>
      ) : (
        <>
          <div className="panel__title">共有データは、まだ用意されていません</div>
          <p>管理者がこのアプリで共有データを使い始めると、この画面は自動で切り替わります。</p>
          <div className="panel__btns">{useLocal}</div>
        </>
      );
      break;
    case 'needs-migration':
      body = (
        <>
          <div className="panel__title">以前の版の形式の共有データがあります</div>
          <p>
            この版から、共有データの保存の形が変わりました（マスタを 1 件ずつ保存し、削除したものが復活したり、ほかの人の追加が消えたりしないようにするため）。
            以前の形式のデータを、新しい形式へ移す必要があります。
          </p>
          {shared.legacyCounts && (
            <p>以前の形式のデータ：{COUNT_LABELS.map(([k, l]) => `${l} ${shared.legacyCounts![k] ?? 0} 件`).join('／')}</p>
          )}
          {meta && meta.status !== 'done' && (
            <p className="hint">
              ※ 前回の移行は完了していません（{meta.status === 'failed' ? `失敗: ${String(meta.error ?? '')}` : 'ほかの端末で実行中か、途中で中断'}）。完了していない間は、どの端末も移行先を使いません。やり直しても、データが重複することはありません。
            </p>
          )}
          {shared.error && <p className="neg" data-testid="shared-error">{shared.error}</p>}
          {shared.report && <ReportTable report={shared.report} />}
          {admin ? (
            <>
              <ul className="hint">
                <li>以前の形式のデータは、<b>読むだけ</b>です。書き換えも削除もしません（移行後もそのまま残ります）。</li>
                <li>最初に、以前のデータの写し（移行前バックアップ）を共有側の別の場所に保存し、同じ内容のファイルをこの端末にも保存します。</li>
                <li>保存後に読み直して、件数と内容が移行元と一致することを確かめます。一致して初めて移行が完了します。</li>
                <li>途中で失敗した場合は、「やり直す」で最初から安全に実行できます。</li>
              </ul>
              <div className="panel__btns">
                <button className="primary" data-testid="migrate" onClick={() => void session?.migrate()}>{meta ? '移行をやり直す' : '新しい形式へ移行する'}</button>
                {!meta && (
                  <button
                    data-testid="start-fresh"
                    onClick={() => { if (window.confirm('以前の形式のデータを移さずに、共有データを空の状態から使い始めます。\n以前の形式のデータは消えませんが、このアプリには表示されなくなります。\n\nよろしいですか？')) void session?.startFresh(); }}
                  >移行せず、空の状態から始める</button>
                )}
                {useLocal}
              </div>
            </>
          ) : (
            <>
              <p className="hint">移行は管理者が行います。完了すると、この画面は自動で切り替わります。</p>
              <div className="panel__btns">{useLocal}</div>
            </>
          )}
        </>
      );
      break;
    case 'migrating':
      body = (
        <>
          <div className="panel__title">新しい形式へ移行しています</div>
          <p data-testid="shared-job">{shared.job || '処理しています…'}</p>
          <p className="hint">完了するまで、この画面を閉じないでください（閉じても以前のデータは壊れません。もう一度開いて、やり直せます）。</p>
        </>
      );
      break;
    case 'too-new':
      body = (
        <>
          <div className="panel__title">アプリの更新が必要です</div>
          <p>共有データが、このアプリより新しい版の形式になっています。古い版のまま書き込むとデータを壊すおそれがあるため、共有データの表示と編集を止めています。</p>
          <div className="panel__btns"><button className="primary" onClick={() => window.location.reload()}>再読み込みして最新版にする</button>{useLocal}</div>
        </>
      );
      break;
    case 'error':
      body = (
        <>
          <div className="panel__title">共有データを確認できませんでした</div>
          <p data-testid="shared-error">{shared.error}</p>
          <div className="panel__btns"><button className="primary" onClick={() => void session?.check()}>もう一度確認する</button>{useLocal}</div>
        </>
      );
      break;
    default:
      body = <p>{shared.job || '共有データを確認しています…'}</p>;
  }
  return <section className="panel panel--wide sharedphase" data-testid="shared-phase" data-phase={shared.phase}>{body}</section>;
}

// ── メンバー名簿（管理者用） ───────────────────────────────────────────
const dateTime = (ms: number) => (ms ? new Date(ms).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '');

export function MembersPanel({ shared, session }: { shared: SharedView; session: SharedSession | null }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!session) return;
    try {
      setMembers(await session.listMembers());
      setError('');
    } catch {
      setError('名簿を読み込めませんでした（接続、または権限を確認してください）。');
    }
  }, [session]);
  useEffect(() => { void reload(); }, [reload, shared.role]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    const msg = await fn();
    setBusy(false);
    setError(msg);
    await reload();
    return msg === '';
  };
  const add = async () => {
    if (!session || !members) return;
    if (await run(() => session.saveMember(email, role, members))) { setEmail(''); setRole('member'); }
  };
  const list = members ?? [];
  const owners = list.filter((m) => m.role === 'owner').length;

  return (
    <section>
      <h2>メンバー<small>共有データを読み書きできる Google アカウントの名簿です</small></h2>
      {shared.enforced ? (
        <p className="hint" data-testid="rules-state" data-enforced="1">メンバー制：<b>適用中</b>。この名簿にあるアカウントだけが、共有データを読み書きできます。名簿を変更できるのは管理者だけです。</p>
      ) : (
        <div className="warnlist" data-testid="rules-state" data-enforced="0">
          <b>⚠ メンバー制は、まだ適用されていません。</b>
          現在は、Google アカウントでログインできる人なら<b>誰でも</b>、共有データを読み書きできる状態です（この名簿も、誰でも変更できます）。
          名簿はここで先に準備できますが、効力が生じるのは、Firebase のセキュリティルールを切り替えたあとです（手順は docs/02_新アプリ設計書.md）。
          切り替える前に、少なくとも 1 人を管理者として登録しておいてください（管理者がいないと、切り替え後に誰も名簿を変更できません）。
        </div>
      )}
      {error && <p className="neg" data-testid="members-error">{error}</p>}
      <div className="grid-wrap">
        <table className="grid members" data-testid="members">
          <thead><tr><th style={{ width: 280 }}>メールアドレス</th><th style={{ width: 110 }}>役割</th><th style={{ width: 150 }}>登録日時</th><th style={{ width: 220 }}>登録した人</th><th className="grid__tail" /></tr></thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.email} data-email={m.email}>
                <td className="is-ro"><div className="grid__ro">{m.email}{m.email === shared.email ? '（自分）' : ''}</div></td>
                <td>
                  <select
                    value={m.role} disabled={busy}
                    onChange={(e) => void run(() => session!.saveMember(m.email, e.target.value === 'owner' ? 'owner' : 'member', list))}
                  >
                    <option value="member">メンバー</option>
                    <option value="owner">管理者</option>
                  </select>
                </td>
                <td className="is-ro"><div className="grid__ro">{dateTime(m.addedAt)}</div></td>
                <td className="is-ro"><div className="grid__ro">{m.addedBy}</div></td>
                <td className="grid__tail">
                  <button
                    className="cellbtn" title="名簿から外す" disabled={busy}
                    onClick={() => {
                      const self = m.email === shared.email;
                      if (window.confirm(`${m.email} を名簿から外します。${self ? '\n\n⚠ 自分自身です。外すと、メンバー制の適用後は共有データを使えなくなります。' : ''}\n\nよろしいですか？`)) void run(() => session!.removeMember(m.email, list));
                    }}
                  >×</button>
                </td>
              </tr>
            ))}
            {members && list.length === 0 && <tr><td colSpan={5} className="grid__empty">名簿は空です。</td></tr>}
            {!members && !error && <tr><td colSpan={5} className="grid__empty">読み込んでいます…</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="panel panel--wide">
        <div className="panel__title">メンバーを追加</div>
        <div className="panel__row">
          <input
            type="email" placeholder="Google アカウントのメールアドレス" value={email} data-testid="member-email"
            onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add(); }}
          />
          <select value={role} onChange={(e) => setRole(e.target.value === 'owner' ? 'owner' : 'member')} data-testid="member-role">
            <option value="member">メンバー</option>
            <option value="owner">管理者</option>
          </select>
          <button className="primary" disabled={busy || !email.trim()} onClick={() => void add()} data-testid="member-add">追加</button>
        </div>
        <p className="panel__hint">メールアドレスは小文字にそろえて登録します。管理者は、名簿の変更と、共有データの初期設定・移行ができます。</p>
        {members && owners === 0 && shared.email && (
          <div className="panel__btns">
            <button data-testid="member-self-owner" disabled={busy} onClick={() => void run(() => session!.saveMember(shared.email, 'owner', list))}>
              自分（{shared.email}）を最初の管理者として登録する
            </button>
          </div>
        )}
      </div>
      <p className="hint">
        管理者が 1 人もいなくなる変更は、この画面ではできません。万一、管理者が誰もいなくなった場合は、Firebase コンソールから名簿に管理者を登録し直します（手順は docs/02_新アプリ設計書.md）。
      </p>
    </section>
  );
}
