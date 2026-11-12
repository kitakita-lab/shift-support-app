// 共有データの同期（sharedSession.ts）の回帰テスト。
// Firestore とブラウザは、メモリ上の模擬（sessionTestkit.ts）に置き換えている。実物での確認は e2e/sync（エミュレータ）。
//
// ここで確かめるのは、主に「前回の残り（送る前に画面が閉じられた変更）」の扱い:
//   - 黙って消えない（あとから同じものを編集しても、ほかの画面が同じものを保存しても）
//   - 共有側のいまの状態を確かめてから送る（ほかの人の新しい変更を、古い内容で上書きしない）
//   - いまの画面が編集・送信しているものを、前回の残りと取り違えない
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../types';
import { MASTER_COLL, MEMBER_COLL, META_COLL, META_DOC, PROJECT_COLL } from './paths';
import {
  browser, dispatch, fake, installBrowser, newWindow, outboxEntries, projectDoc, resetFake, serverDoc, setMeta, setNetwork, setOnline, setServer,
} from './sessionTestkit';
import type { SessionUser, SharedSession } from './sharedSession';
import type { ProjectCopy } from './sharedLogic';

vi.mock('./remote', async () => (await import('./sessionTestkit')).remote);
vi.mock('../firebase', async () => (await import('./sessionTestkit')).firebase);

type Mod = typeof import('./sharedSession');
interface Tab {
  mod: Mod;
  session: SharedSession;
  notices: string[];
  stashes: Project[];
  /** この画面だけにイベントを起こす（focus・pagehide） */
  fire: (type: string) => void;
  /** 強制終了（閉じる前の送信もされない） */
  kill: () => void;
  /** ふつうに閉じる（閉じる前に、待っている変更を送信へ回す） */
  close: () => void;
  /** 同じ画面のまま、ログインし直す（前のセッションは止まっている前提） */
  relogin: (user?: SessionUser) => SharedSession;
}
const USER: SessionUser = { uid: 'u1', email: 'a@example.com', displayName: 'A' };
const P = PROJECT_COLL;
const HOUR = 3600 * 1000;
const tabs: Tab[] = [];
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** 画面（タブ）を 1 つ開く＝同期のモジュール一式を読み込み直した、別の実体を作る */
async function openTab(user: SessionUser = USER): Promise<Tab> {
  vi.resetModules();
  const fire = newWindow();
  const before = new Set(browser.locks);
  const mod = await import('./sharedSession');
  const lock = browser.locks.find((l) => !before.has(l) && l.name.startsWith('kkl-tab-'));
  const notices: string[] = [];
  const stashes: Project[] = [];
  const make = (u: SessionUser) => {
    const s = new mod.SharedSession(u, {
      stash: (p) => { stashes.push(p); return `${p.name}（控え）`; },
      notify: (kind, text) => { notices.push(`${kind}: ${text}`); },
      download: () => { /* 使わない */ },
    });
    s.start();
    return s;
  };
  const tab: Tab = {
    mod, session: make(user), notices, stashes, fire,
    kill: () => { tab.session.stop(); browser.locks = browser.locks.filter((l) => l !== lock); },
    close: () => { fire('pagehide'); tab.kill(); },
    relogin: (u = user) => { tab.session = make(u); return tab.session; },
  };
  tabs.push(tab);
  return tab;
}
async function ready(t: Tab, max = 10000): Promise<void> {
  for (let i = 0; i < max / 20 && t.session.getView().phase !== 'ready'; i++) await tick(20);
  expect(t.session.getView().phase).toBe('ready');
}
const view = (t: Tab) => t.session.getView();
const project = (t: Tab, id: string) => view(t).data.projects.find((p) => p.id === id);
const memo = (text: string) => (p: Project): Project => ({ ...p, memo: text });
const rename = (name: string) => (p: Project): Project => ({ ...p, name });
const count = (coll: string) => [...fake.server.keys()].filter((k) => k.startsWith(`${coll}/`)).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T10:00:00+09:00'));
  resetFake();
  installBrowser();
  setServer(P, 'p1', projectDoc('p1'));
  fake.metaCache = { formatVersion: 1, status: 'done' };
});
afterEach(() => {
  for (const t of tabs.splice(0)) t.session.stop();
  vi.useRealTimers();
});

describe('ふだんの編集', () => {
  it('変更は入力が止まって 0.7 秒後に送られ、届いたら控えが消える', async () => {
    const t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('メモ'));
    expect(view(t).unsent).toBe(1);
    expect(outboxEntries()).toHaveLength(1);        // 変更した時点で、すぐ控えに書く
    await tick(600);
    expect(serverDoc(P, 'p1')?.memo).toBe('');      // まだ送っていない
    await tick(400);
    expect(serverDoc(P, 'p1')?.memo).toBe('メモ');
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
    expect(t.notices).toEqual([]);
  });

  it('圏外での変更は未送信として残り、つながると送られる', async () => {
    const t = await openTab();
    await ready(t);
    setOnline(false);
    t.session.updateProject('p1', memo('圏外のメモ'));
    await tick(2000);
    expect(view(t)).toMatchObject({ unsent: 1, online: false });
    expect(outboxEntries()).toHaveLength(1);
    setOnline(true);
    await tick(1000);
    expect(serverDoc(P, 'p1')?.memo).toBe('圏外のメモ');
    expect(view(t).unsent).toBe(0);
    expect(outboxEntries()).toHaveLength(0);
    expect(t.notices).toEqual([]);
  });

  it('いま編集・送信しているものを、前回の残りと取り違えない（通信が遅くても、通知も控えも出ない）', async () => {
    fake.writeDelay = 60;
    fake.readDelay = 1600;                          // サーバーからの読み取りに 1.6 秒かかる
    const t = await openTab();
    await ready(t, 20000);
    await tick(2500);
    t.session.updateProject('p1', memo('あ'));
    await tick(720);                                // 送信中
    t.fire('focus');                                // 画面に戻った（引き取りの確認が走る）
    await tick(150);
    t.session.updateProject('p1', memo('あい'));    // そのまま入力を続ける
    await tick(15000);
    expect(serverDoc(P, 'p1')?.memo).toBe('あい');
    expect(t.notices).toEqual([]);
    expect(t.stashes).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('拒否された書き込みは、1 回だけ知らせて 1 件だけ控えを残す（送り直さない）', async () => {
    fake.writeDelay = 900;
    fake.rejectWrite = (w) => (w.path === `${P}/p1` ? 'permission-denied' : null);
    const t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('拒否される変更'));
    await tick(720);
    t.fire('focus');                                // 送信中に、引き取りの確認が走る
    await tick(20000);
    expect(fake.log.filter((l) => l.startsWith('REJECT'))).toHaveLength(1);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('書き込む権限がない');
    expect(t.stashes.map((p) => p.memo)).toEqual(['拒否される変更']);
    expect(outboxEntries()).toHaveLength(0);
    expect(project(t, 'p1')?.memo).toBe('');        // 画面も、共有側の内容に戻る
  });

  it('控えを端末に保存できないときは、1 回だけ知らせる（送信は続ける）', async () => {
    const t = await openTab();
    await ready(t);
    browser.storageFull = true;
    t.session.updateProject('p1', memo('メモ'));
    t.session.updateProject('p1', rename('名前'));
    await tick(1500);
    expect(t.notices.filter((n) => n.includes('保存領域がいっぱい'))).toHaveLength(1);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'メモ', name: '名前' });
  });
});

describe('前回の残り（送る前に画面が閉じられた変更）', () => {
  for (const how of ['強制終了', '閉じた（送信待ちに残らなかった）', '閉じた（送信待ちに残った）'] as const) {
    it(`圏外で開き直して同じ案件を編集しても、前回の変更が消えない: ${how}`, async () => {
      let t = await openTab();
      await ready(t);
      await tick(100);
      t.session.updateProject('p1', memo('閉じる直前に書いた一文'));
      if (how === '強制終了') t.kill();              // 0.7 秒たつ前に、画面が消えた
      else t.close();
      if (how === '閉じた（送信待ちに残らなかった）') fake.queue.length = 0;
      expect(outboxEntries()).toHaveLength(1);

      setOnline(false);
      t = await openTab();
      await ready(t);
      await tick(200);
      // 引き取った変更が画面に出て、未送信として数えられる
      expect(project(t, 'p1')?.memo).toBe('閉じる直前に書いた一文');
      expect(view(t).unsent).toBe(1);
      t.session.updateProject('p1', rename('案件（改名）'));
      await tick(900);
      const entries = outboxEntries();
      expect(entries).toHaveLength(1);              // 控えは 1 件にまとまり、両方の変更を含む
      expect(entries[0].fields).toEqual(expect.arrayContaining(['memo', 'name']));
      expect(entries[0].body).toMatchObject({ memo: '閉じる直前に書いた一文', name: '案件（改名）' });

      setOnline(true);
      await tick(5000);
      expect(serverDoc(P, 'p1')).toMatchObject({ memo: '閉じる直前に書いた一文', name: '案件（改名）' });
      expect(outboxEntries()).toHaveLength(0);
      expect(view(t).unsent).toBe(0);
      expect(t.notices).toEqual([]);
      expect(t.stashes).toEqual([]);
    });
  }

  it('誰も触っていなければ、開き直したときに送る', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('送る前に閉じたメモ'));
    t.kill();
    t = await openTab();
    await ready(t);
    await tick(3000);
    expect(serverDoc(P, 'p1')?.memo).toBe('送る前に閉じたメモ');
    expect(serverDoc(P, 'p1')?.updatedBy).toMatchObject({ uid: 'u1' });
    expect(outboxEntries()).toHaveLength(0);
    expect(t.notices).toEqual([]);
  });

  it('その後ほかの人が変更していたら、上書きしない（知らせて、控えを残す）', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A の古いメモ'));
    t.kill();
    setServer(P, 'p1', { ...serverDoc(P, 'p1'), memo: 'B の新しいメモ', name: 'B が付けた名前', rev: 'rB' });
    t = await openTab();
    await ready(t);
    await tick(3000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B の新しいメモ', name: 'B が付けた名前', rev: 'rB' });
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('自動では反映していません');
    // 控えには、反映しなかった自分の変更が入っている（ほかの項目は、共有側のいまの内容）
    expect(t.stashes).toHaveLength(1);
    expect(t.stashes[0]).toMatchObject({ memo: 'A の古いメモ', name: 'B が付けた名前' });
    expect(project(t, 'p1')?.memo).toBe('B の新しいメモ');     // 画面も、共有側の内容に戻る
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('その後に削除されていたら、復活させない（知らせて、控えを残す）', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('削除される前のメモ'));
    t.kill();
    setServer(P, 'p1', null);
    t = await openTab();
    await ready(t);
    await tick(3000);
    expect(serverDoc(P, 'p1')).toBeUndefined();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('削除されていた');
    expect(t.stashes.map((p) => p.memo)).toEqual(['削除される前のメモ']);
    expect(project(t, 'p1')).toBeUndefined();
    expect(outboxEntries()).toHaveLength(0);
  });

  it('前回作成して届かなかった案件は、作り直さず、控えに残して知らせる', async () => {
    let t = await openTab();
    await ready(t);
    setOnline(false);
    t.session.addProject(projectDoc('p-new', { name: '圏外で作った案件' }) as unknown as Project);
    await tick(100);
    t.kill();
    fake.queue.length = 0;                          // 送信待ちに残らなかった
    setOnline(true);
    t = await openTab();
    await ready(t);
    await tick(3000);
    expect(serverDoc(P, 'p-new')).toBeUndefined();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('共有データに保存されていませんでした');
    expect(t.stashes.map((p) => p.name)).toEqual(['圏外で作った案件']);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('前回の削除が届いていなければ、知らせる（送り直さない）', async () => {
    let t = await openTab();
    await ready(t);
    setOnline(false);
    t.session.removeProject('p1');
    await tick(100);
    t.kill();
    fake.queue.length = 0;
    setOnline(true);
    t = await openTab();
    await ready(t);
    await tick(3000);
    expect(serverDoc(P, 'p1')).toBeDefined();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('削除が、共有データに反映されていませんでした');
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('引き取ったあとに削除したら、前回の変更は送らず、削除だけを送る', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('送る前に閉じたメモ'));
    t.kill();
    setOnline(false);
    t = await openTab();
    await ready(t);
    await tick(200);
    t.session.removeProject('p1');
    setOnline(true);
    await tick(3000);
    expect(serverDoc(P, 'p1')).toBeUndefined();
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('同じ画面でログインし直したとき、前のログインで送れなかった変更を引き取る', async () => {
    const t = await openTab();
    await ready(t);
    setOnline(false);
    t.session.updateProject('p1', memo('前のログインのメモ'));
    await tick(100);
    t.session.stop();                               // ほかの画面でのログアウトなどで、この画面の同期が止まった（画面は開いたまま）
    fake.queue.length = 0;
    setOnline(true);
    t.relogin();
    await ready(t);
    await tick(3000);
    expect(serverDoc(P, 'p1')?.memo).toBe('前のログインのメモ');
    expect(outboxEntries()).toHaveLength(0);
    expect(t.notices).toEqual([]);
  });

  it('別のアカウントの控えは引き取らない', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A のメモ'));
    t.kill();
    t = await openTab({ uid: 'u2', email: 'b@example.com', displayName: 'B' });
    await ready(t);
    await tick(15000);
    expect(serverDoc(P, 'p1')?.memo).toBe('');
    expect(project(t, 'p1')?.memo).toBe('');
    expect(outboxEntries()).toHaveLength(1);        // A の控えは、A が次にログインするまで残る
  });
});

// Codex のレビュー（PR #86 の 1 回目）P1 と、同じ種類の抜け:
// 引き取った古い変更が、あとから重ねた編集や別の残りの「基準の印」で「誰も触っていない」と判定されてはいけない。
describe('前回の残りを「誰も触っていない」と判定する根拠', () => {
  const byB = () => setServer(P, 'p1', { ...serverDoc(P, 'p1'), memo: 'B の新しいメモ', rev: 'rB' });

  it('確認が済む前に別の項目を編集しても、ほかの人が変更していたら上書きしない（確認に時間がかかっている間の編集）', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A の古いメモ'));
    t.kill();                                       // 送る前に消えた（控えの基準は r0）
    byB();                                          // その間に B が保存した
    fake.readDelay = 3000;                          // サーバーからの読み取りが遅い（確認に時間がかかる）
    t = await openTab();
    await ready(t, 30000);
    await tick(300);                                // 引き取りは済み、共有側の確認はまだ終わっていない
    expect(project(t, 'p1')?.memo).toBe('A の古いメモ');
    t.session.updateProject('p1', rename('A が今回付けた名前'));   // この時点の共有側の印は rB
    await tick(20000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B の新しいメモ', name: '案件', rev: 'rB' });
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('自動では反映していません');
    expect(t.stashes).toHaveLength(1);
    expect(t.stashes[0]).toMatchObject({ memo: 'A の古いメモ', name: 'A が今回付けた名前' });   // 反映しなかった変更は、どちらも控えに残る
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('確認が済む前に別の項目を編集しても、ほかの人が変更していたら上書きしない（つながらないまま開き直して編集）', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A の古いメモ'));
    t.kill();
    byB();
    setOnline(false);
    t = await openTab();                            // 端末内の控えには、B の保存後の内容（rB）が入っている
    await ready(t);
    await tick(200);
    t.session.updateProject('p1', rename('A が今回付けた名前'));
    await tick(1000);
    setOnline(true);
    await tick(5000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B の新しいメモ', name: '案件', rev: 'rB' });
    expect(t.notices).toHaveLength(1);
    expect(t.stashes).toHaveLength(1);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('引き取った残りに編集を重ねた画面が、送る前にまた閉じられても、次に開いた画面は古い変更を送らない', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A の古いメモ'));
    t.kill();
    byB();
    setOnline(false);
    t = await openTab();
    await ready(t);
    await tick(200);
    t.session.updateProject('p1', rename('A が今回付けた名前'));
    await tick(100);
    t.kill();                                       // 残りと今回の編集をまとめた控えを残して、また消えた
    expect(outboxEntries()).toHaveLength(1);
    setOnline(true);
    t = await openTab();
    await ready(t);
    await tick(5000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B の新しいメモ', name: '案件', rev: 'rB' });
    expect(t.notices).toHaveLength(1);
    expect(t.stashes).toHaveLength(1);
    expect(t.stashes[0]).toMatchObject({ memo: 'A の古いメモ', name: 'A が今回付けた名前' });
    expect(outboxEntries()).toHaveLength(0);
  });

  it('基準の違う 2 つの残りをまとめて引き取ったとき、新しいほうの基準で、古いほうの変更を送らない', async () => {
    const x1 = await openTab();
    const x2 = await openTab();
    await ready(x1);
    await ready(x2);
    x1.session.updateProject('p1', memo('画面 1 の古いメモ'));
    x1.kill();                                      // 残り 1: 基準は r0
    byB();
    await tick(50);                                 // 画面 2 に、B の保存（rB）が届く
    x2.session.updateProject('p1', rename('画面 2 の名前'));
    x2.kill();                                      // 残り 2: 基準は rB
    expect(outboxEntries()).toHaveLength(2);
    const t = await openTab();
    await ready(t);
    await tick(5000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B の新しいメモ', rev: 'rB' });   // 古いメモで上書きしていない
    expect(t.notices).toHaveLength(1);
    expect(t.stashes).toHaveLength(1);
    expect(t.stashes[0]).toMatchObject({ memo: '画面 1 の古いメモ', name: '画面 2 の名前' });
    expect(outboxEntries()).toHaveLength(0);
  });

  it('基準が同じ 2 つの残りは、誰も触っていなければ、まとめて送る', async () => {
    const x1 = await openTab();
    const x2 = await openTab();
    await ready(x1);
    await ready(x2);
    x1.session.updateProject('p1', memo('画面 1 のメモ'));
    x2.session.updateProject('p1', rename('画面 2 の名前'));
    x1.kill();
    x2.kill();
    const t = await openTab();
    await ready(t);
    await tick(5000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: '画面 1 のメモ', name: '画面 2 の名前' });
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('一連の変更のうち、届いたと確認できた項目は、残りを送るときに送り直さない（その後のほかの人の変更を巻き戻さない）', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A のメモ'));
    await tick(720);                                // メモを送信中
    t.session.updateProject('p1', rename('A の名前'));   // 一連の変更が続く
    await tick(200);                                // メモは届いた（確認済み）。名前は送信待ち
    expect(serverDoc(P, 'p1')?.memo).toBe('A のメモ');
    setServer(P, 'p1', { ...serverDoc(P, 'p1'), memo: 'B が書き直したメモ', rev: 'rB' });   // B がメモを書き直した
    await tick(520);                                // A の名前を送信中（一連の変更は、まだ続いている）
    t.session.updateProject('p1', (p) => ({ ...p, status: '確定' }));
    await tick(100);                                // A の名前が届く（共有側の印は A のものになる）
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B が書き直したメモ', name: 'A の名前' });
    t.kill();                                       // 最後の変更（状態）だけが、送る前に残った
    const left = outboxEntries();
    expect(left).toHaveLength(1);
    expect(left[0].fields).not.toContain('memo');   // 届いたと確認できた項目は、控えの「変えた項目」に残さない
    expect(left[0].fields).not.toContain('name');
    t = await openTab();
    await ready(t);
    await tick(5000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B が書き直したメモ', name: 'A の名前', status: '確定' });
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
  });
});

// Codex のレビュー（PR #86 の 2 回目）P2: 「誰も触っていない」と確かめることと、書くことを、切り離さない。
// 確かめたあと、書き込みが届くまでの間に、ほかの人が保存した・接続が切れた場合に、古い値で上書きしてはいけない。
describe('前回の残りを「確かめてから送る」の、確かめたあと', () => {
  const leftover = async () => {
    const t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A の古いメモ'));
    t.kill();
  };
  /** 引き取った残りについて、共有側を読んだ直後に 1 回だけ fn を起こす */
  const justAfterCheck = (fn: () => void) => {
    let done = false;
    fake.afterRead = (path) => {
      if (path !== `${P}/p1` || done) return;
      done = true;
      fn();
    };
  };

  it('確かめたあと、書き込みが届く前に、ほかの人が同じ項目を保存したら、上書きしない', async () => {
    await leftover();
    justAfterCheck(() => setServer(P, 'p1', { ...serverDoc(P, 'p1'), memo: 'B の新しいメモ', rev: 'rB' }));
    const t = await openTab();
    await ready(t);
    await tick(5000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B の新しいメモ', rev: 'rB' });
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('自動では反映していません');
    expect(t.stashes.map((p) => p.memo)).toEqual(['A の古いメモ']);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('確かめたあと、書く前に接続が切れたら、端末内の送信待ちに残さない（つながったあとで、古い値が送られない）', async () => {
    await leftover();
    justAfterCheck(() => setNetwork(false));        // 読めた直後に切れた（アプリからは、まだつながっているように見える）
    const t = await openTab();
    await ready(t);
    await tick(3000);
    expect(fake.queue).toHaveLength(0);             // 引き取った変更は、送信待ちに入っていない
    expect(serverDoc(P, 'p1')?.memo).toBe('');
    setServer(P, 'p1', { ...serverDoc(P, 'p1'), memo: 'B の新しいメモ', rev: 'rB' });   // 切れている間に B が保存した
    setNetwork(true);
    await tick(40000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'B の新しいメモ', rev: 'rB' });
    expect(t.notices).toHaveLength(1);
    expect(t.stashes.map((p) => p.memo)).toEqual(['A の古いメモ']);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('確かめたあと、書く前に接続が切れても、誰も触っていなければ、つながったあとで送る', async () => {
    await leftover();
    justAfterCheck(() => setNetwork(false));
    const t = await openTab();
    await ready(t);
    await tick(3000);
    expect(view(t).unsent).toBe(1);                 // 未送信のまま残っている
    expect(outboxEntries()).toHaveLength(1);
    setNetwork(true);
    await tick(40000);
    expect(serverDoc(P, 'p1')?.memo).toBe('A の古いメモ');
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  /** p1 のメモが、画面にどう出てきたか（変わるたびに 1 つ足す） */
  const watchMemo = (t: Tab): string[] => {
    const seen: string[] = [];
    t.session.subscribe(() => { const m = project(t, 'p1')?.memo; if (m !== undefined && seen[seen.length - 1] !== m) seen.push(m); });
    return seen;
  };

  // ここから下は、「確かめる」と「書く」を 1 つにまとめた（送信待ちの列を通さずに書く）ことで、新しく気をつける点。
  // そうして書いた内容は、購読には少し遅れて届く。それまでの間に、画面や、続けて送る編集が、古い内容を基にしてはいけない
  it('送った内容が購読に届くのが遅れても、画面は古い値に戻らない（その上に重ねた編集を送るときも）', async () => {
    await leftover();
    fake.watchDelay = 4000;                         // 書いた内容が、購読に届くまで 4 秒かかる
    const t = await openTab();
    await ready(t);
    const seen = watchMemo(t);
    t.session.updateProject('p1', rename('A が今回付けた名前'));
    await tick(10000);
    expect(seen).toEqual(['A の古いメモ']);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'A の古いメモ', name: 'A が今回付けた名前' });
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('既に届いていた場合も、購読が追いつくまでは、画面は引き取った内容を出し続ける', async () => {
    await leftover();
    fake.watchDelay = 4000;
    setServer(P, 'p1', { ...serverDoc(P, 'p1'), memo: 'A の古いメモ', rev: 'rX' });   // 同じ内容が、既に共有側にある（購読には、まだ届いていない）
    const t = await openTab();
    await ready(t);
    const seen = watchMemo(t);
    await tick(10000);
    expect(seen.filter((m) => m !== 'A の古いメモ')).toEqual([]);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'A の古いメモ', rev: 'rX' });   // 何も書いていない
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('書けた直後に接続が切れても、画面は古い値に戻らない。重ねた編集は、つながったあとで送る', async () => {
    await leftover();
    fake.afterCommit = () => { fake.afterCommit = null; setNetwork(false); };   // 書けた直後に切れた（アプリからは、まだつながっているように見える）
    const t = await openTab();
    await ready(t);
    const seen = watchMemo(t);
    t.session.updateProject('p1', rename('A が今回付けた名前'));
    await tick(30000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'A の古いメモ', name: '案件' });   // 引き取った分は書けている。重ねた編集は、まだ
    expect(fake.queue).toHaveLength(0);             // 古い内容を基にした書き込みを、送信待ちに入れていない
    expect(seen).toEqual(['A の古いメモ']);
    expect(view(t).unsent).toBe(1);
    setNetwork(true);
    await tick(40000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'A の古いメモ', name: 'A が今回付けた名前' });
    expect(seen).toEqual(['A の古いメモ']);
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('書けた直後に接続が切れ、そのまま画面が閉じられても、次に開いた画面は、重ねてあった編集を送る', async () => {
    await leftover();
    fake.afterCommit = () => { fake.afterCommit = null; setNetwork(false); };
    const b = await openTab();
    await ready(b);
    b.session.updateProject('p1', rename('B の画面で付けた名前'));
    await tick(15000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'A の古いメモ', name: '案件' });
    b.kill();                                       // 片付く前に、画面が閉じられた
    setNetwork(true);
    const c = await openTab();
    await ready(c);
    await tick(40000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'A の古いメモ', name: 'B の画面で付けた名前' });
    expect(c.notices).toEqual([]);
    expect(c.stashes).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('前回の画面が先に送った書き込みが、まだ送信待ちに残っている間は、待つ（その古い書き込みが、あとから届いて上書きしない）', async () => {
    fake.writeDelay = 15000;                        // 送信待ちが、なかなかサーバーに届かない
    const a = await openTab();
    await ready(a);
    a.session.updateProject('p1', memo('途中のメモ'));
    await tick(1000);                               // 「途中のメモ」は、送信待ちに入った（まだ届いていない）
    a.session.updateProject('p1', memo('最後のメモ'));
    a.kill();                                       // 「最後のメモ」は、送る前に画面が閉じられた
    const t = await openTab();
    await ready(t);
    await tick(10000);
    expect(fake.log.filter((l) => l.includes('recover'))).toEqual([]);   // まだ書いていない（先に送った書き込みが、届いていない）
    expect(project(t, 'p1')?.memo).toBe('最後のメモ');                    // 画面には出ている
    await tick(40000);
    expect(fake.log.filter((l) => l.startsWith('ACK'))).toEqual([`ACK update ${P}/p1`, `ACK recover ${P}/p1`]);
    expect(serverDoc(P, 'p1')?.memo).toBe('最後のメモ');
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
  });

  // トランザクションの失敗には、「あとでやり直せば通るもの（通信・競合）」と「やり直しても通らないもの（権限・内容）」がある。
  // 後者を前者と同じに扱うと、黙って繰り返し続け、後ろに並んだほかの残りも片付かない
  it('書き込みが受け付けられなかったら（権限が無い）、知らせて控えを残す。黙って繰り返さず、ほかの残りは続けて片付ける', async () => {
    setServer(P, 'p2', projectDoc('p2', { name: '別の案件' }));
    setServer(P, 'p3', projectDoc('p3', { name: 'もう 1 つの案件' }));
    const a = await openTab();
    await ready(a);
    a.session.updateProject('p2', memo('p2 のメモ'));
    a.session.updateProject('p1', memo('A の古いメモ'));
    a.session.updateProject('p3', memo('p3 のメモ'));
    a.kill();
    fake.rejectWrite = (w) => (w.path === `${P}/p1` ? 'permission-denied' : null);
    const t = await openTab();
    await ready(t);
    t.session.updateProject('p1', rename('A が今回付けた名前'));   // その上に重ねた編集も、同じ控えに入る
    await tick(40000);
    expect(fake.log.filter((l) => l.includes('REJECT'))).toEqual([`REJECT(permission-denied) recover ${P}/p1`]);   // 1 回だけ
    expect([serverDoc(P, 'p2')?.memo, serverDoc(P, 'p3')?.memo]).toEqual(['p2 のメモ', 'p3 のメモ']);              // ほかの残りは届いている
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: '', name: '案件' });
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('書き込む権限がない');
    expect(t.notices[0]).toContain('今回この画面で行った変更も含みます');
    expect(t.stashes.map((p) => [p.memo, p.name])).toEqual([['A の古いメモ', 'A が今回付けた名前']]);
    expect(project(t, 'p1')).toMatchObject({ memo: '', name: '案件' });   // 画面は、共有の内容に戻る
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('書き込みが受け付けられなかったら（内容が大きすぎる、など）、理由を知らせて控えを残す', async () => {
    await leftover();
    fake.rejectWrite = (w) => (w.path === `${P}/p1` ? 'invalid-argument' : null);
    const t = await openTab();
    await ready(t);
    await tick(40000);
    expect(fake.log.filter((l) => l.includes('REJECT'))).toHaveLength(1);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('保存できませんでした（理由: invalid-argument）');
    expect(t.stashes.map((p) => p.memo)).toEqual(['A の古いメモ']);
    expect(serverDoc(P, 'p1')?.memo).toBe('');
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });

  it('送ったあと、画面の内容が一瞬古い値に戻らない。その上に重ねた編集は、続けて送られる', async () => {
    await leftover();
    const t = await openTab();
    await ready(t);
    t.session.updateProject('p1', rename('A が今回付けた名前'));
    const seen: string[] = [];
    t.session.subscribe(() => { const m = project(t, 'p1')?.memo; if (m !== undefined) seen.push(m); });
    await tick(5000);
    expect(serverDoc(P, 'p1')).toMatchObject({ memo: 'A の古いメモ', name: 'A が今回付けた名前' });
    expect(seen.every((m) => m === 'A の古いメモ')).toBe(true);
    expect(t.notices).toEqual([]);
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t).unsent).toBe(0);
  });
});

describe('同じブラウザの 2 つの画面', () => {
  it('片方が保存しても、もう片方の控えを消さない。閉じられた画面の変更は、黙って消えない', async () => {
    const t1 = await openTab();
    const t2 = await openTab();
    await ready(t1);
    await ready(t2);
    await tick(200);
    t1.session.updateProject('p1', memo('画面 1 のメモ'));
    await tick(650);
    t2.session.updateProject('p1', rename('画面 2 で付けた名前'));
    expect(outboxEntries()).toHaveLength(2);        // 控えは画面ごと
    await tick(200);                                // 画面 1 の変更が届く
    const left = outboxEntries();
    expect(left).toHaveLength(1);                   // 画面 2 の控えは残っている
    expect(left[0].fields).toContain('name');
    t2.kill();                                      // 画面 2 が、送る前に消えた
    await tick(20000);                              // 残っている画面 1 が引き取る
    const s = serverDoc(P, 'p1')!;
    expect(s.memo).toBe('画面 1 のメモ');
    // 送られたか、知らせて控えを残したかのどちらか（黙って消えない）
    const applied = s.name === '画面 2 で付けた名前';
    const told = t1.notices.length === 1 && t1.stashes.length === 1 && t1.stashes[0].name === '画面 2 で付けた名前';
    expect(applied || told).toBe(true);
    expect(outboxEntries()).toHaveLength(0);
    expect(view(t1).unsent).toBe(0);
  });

  it('開いている画面の控えは引き取らない', async () => {
    const t1 = await openTab();
    const t2 = await openTab();
    await ready(t1);
    await ready(t2);
    setOnline(false);
    t2.session.updateProject('p1', memo('画面 2 が編集中'));
    const sid = outboxEntries()[0].sid;
    await tick(30000);                              // 画面 1 の引き取りの確認が、何度か走る
    expect(outboxEntries().map((e) => e.sid)).toEqual([sid]);   // 控えは、画面 2 のもののまま
    // 端末内の送信待ちは画面の間で共有されるので、未送信の件数はどちらの画面にも出る
    expect(view(t1).unsent).toBe(1);
    expect(view(t2).unsent).toBe(1);
    expect(project(t1, 'p1')?.memo).toBe('画面 2 が編集中');
    setOnline(true);
    await tick(3000);
    expect(serverDoc(P, 'p1')?.memo).toBe('画面 2 が編集中');
    expect([...t1.notices, ...t2.notices]).toEqual([]);
  });

  it('2 つの画面が同時に開いても、同じ控えを二重に引き取らない', async () => {
    let t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('A の古いメモ'));
    t.kill();
    setServer(P, 'p1', { ...serverDoc(P, 'p1'), memo: 'B の新しいメモ', rev: 'rB' });
    const t1 = await openTab();
    const t2 = await openTab();
    await ready(t1);
    await ready(t2);
    await tick(20000);
    expect([...t1.notices, ...t2.notices]).toHaveLength(1);
    expect([...t1.stashes, ...t2.stashes]).toHaveLength(1);
    t = t1;
    expect(outboxEntries()).toHaveLength(0);
  });
});

describe('長く送信待ちだった変更', () => {
  it('同じ画面のまま 12 時間以上たってから送信されたら、知らせる', async () => {
    const t = await openTab();
    await ready(t);
    setOnline(false);
    t.session.updateProject('p1', memo('圏外で書いたメモ'));
    await tick(1000);
    vi.setSystemTime(Date.now() + 13 * HOUR);
    setOnline(true);
    await tick(3000);
    expect(serverDoc(P, 'p1')?.memo).toBe('圏外で書いたメモ');
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('送信待ちのまま残っていた変更');
    expect(t.notices[0]).toContain('約 13 時間前');
    expect(t.notices[0]).toContain('案件「案件」');
  });

  it('画面を閉じ、12 時間以上たって開き直したときに送信された場合も、知らせる', async () => {
    let t = await openTab();
    await ready(t);
    setOnline(false);
    t.session.updateProject('p1', memo('圏外で書いたメモ'));
    await tick(1000);                               // 端末内の送信待ちに入った
    t.kill();
    vi.setSystemTime(Date.now() + 3 * 24 * HOUR);
    setOnline(true);                                // 開き直した時点で、送信待ちがそのまま送られる
    t = await openTab();
    await ready(t);
    await tick(5000);
    expect(serverDoc(P, 'p1')?.memo).toBe('圏外で書いたメモ');
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('約 3 日前');
    expect(outboxEntries()).toHaveLength(0);
  });

  it('短い時間で送信されたものは、知らせない', async () => {
    const t = await openTab();
    await ready(t);
    setOnline(false);
    t.session.updateProject('p1', memo('圏外で書いたメモ'));
    await tick(1000);
    vi.setSystemTime(Date.now() + 2 * HOUR);
    setOnline(true);
    await tick(3000);
    expect(serverDoc(P, 'p1')?.memo).toBe('圏外で書いたメモ');
    expect(t.notices).toEqual([]);
  });
});

describe('「使える状態」の印（形式の情報）', () => {
  const legacy = () => ({
    masters: { staff: null, venues: null, contents: null, partTypes: null, composites: null },
    projects: [1, 2, 3, 4, 5, 6].map((n) => {
      const doc = projectDoc(`old${n}`, { name: `以前の案件 ${n}` });
      delete doc.rev;
      delete doc.order;
      return { id: `old${n}`, doc };
    }),
  });
  const meta = () => fake.server.get(`${META_COLL}/${META_DOC}`);

  it('「空の状態から始める」を押したとき、ほかの端末が移行を始めていたら、何も作らず、使い始めない', async () => {
    setMeta(null);
    fake.metaCache = null;
    fake.legacy = legacy();
    const t = await openTab();
    await tick(500);
    expect(view(t).phase).toBe('needs-migration');
    setMeta({ formatVersion: 1, status: 'running', attempt: 1 });   // ほかの端末が移行を始めた（この画面には、まだ届いていない）
    const run = t.session.startFresh();
    await tick(1000);
    await run;
    expect(view(t).phase).toBe('needs-migration');
    expect(view(t).data.projects).toHaveLength(0);
    expect(meta()).toMatchObject({ status: 'running', attempt: 1 });
    expect(count(MASTER_COLL.partTypes)).toBe(0);
  });

  it('使っている最中に印が外れたら、使い続けない', async () => {
    const t = await openTab();
    await ready(t);
    setMeta({ formatVersion: 1, status: 'failed', attempt: 1 });
    await tick(1000);
    expect(view(t).phase).toBe('needs-migration');
    expect(view(t).data.projects).toHaveLength(0);
  });

  it('移行: バックアップ → 保存 → 照合 → 印、の順に進む', async () => {
    setMeta(null);
    fake.metaCache = null;
    setServer(P, 'p1', null);
    fake.legacy = legacy();
    fake.access = { role: 'owner', enforced: true };
    const t = await openTab();
    await tick(500);
    expect(view(t).phase).toBe('needs-migration');
    const run = t.session.migrate();
    await tick(5000);
    await run;
    await tick(500);
    expect(meta()).toMatchObject({ status: 'done', attempt: 1 });
    expect(view(t).phase).toBe('ready');
    expect(view(t).data.projects.map((p) => p.name)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `以前の案件 ${n}`));
    expect(view(t).report?.ok).toBe(true);
  });

  it('移行の途中で、ほかの端末がやり直したら、それ以上 1 件も書かない（失敗の記録もしない）', async () => {
    setMeta(null);
    fake.metaCache = null;
    setServer(P, 'p1', null);
    fake.legacy = legacy();
    fake.access = { role: 'owner', enforced: true };
    const t = await openTab();
    await tick(500);
    const run = t.session.migrate();
    for (let i = 0; i < 500 && count(P) < 2; i++) await tick(5);
    const written = count(P);
    expect(written).toBeGreaterThanOrEqual(2);
    expect(written).toBeLessThan(6);
    setMeta({ ...meta(), attempt: 2, startedBy: { uid: 'other', displayName: 'ほかの端末' } });
    await tick(5000);
    await run;
    expect(count(P)).toBe(written);
    expect(meta()).toMatchObject({ status: 'running', attempt: 2 });
    expect(t.notices.some((n) => n.includes('この端末での移行は中止しました'))).toBe(true);
    expect(view(t).phase).toBe('needs-migration');
  });

  it('移行の途中で、ほかの端末が完了させていたら、完了後のデータを上書きしない', async () => {
    setMeta(null);
    fake.metaCache = null;
    setServer(P, 'p1', null);
    fake.legacy = legacy();
    fake.access = { role: 'owner', enforced: true };
    const t = await openTab();
    await tick(500);
    const run = t.session.migrate();
    for (let i = 0; i < 500 && count(P) < 2; i++) await tick(5);
    // ほかの端末が移行を完了させ、そのあと誰かが案件を編集した
    setMeta({ formatVersion: 1, status: 'done', attempt: 2 });
    setServer(P, 'old1', { ...serverDoc(P, 'old1'), name: '移行後に編集した名前', rev: 'rX' });
    const snapshot = JSON.stringify([...fake.server]);
    await tick(5000);
    await run;
    await tick(500);
    expect(JSON.stringify([...fake.server])).toBe(snapshot);
    expect(view(t).phase).toBe('ready');
    expect(project(t, 'old1')?.name).toBe('移行後に編集した名前');
  });
});

describe('置き場所をまたぐコピー', () => {
  const copy = (add: ProjectCopy['add'] = {}): ProjectCopy => ({ project: projectDoc('p-copy', { name: 'コピー' }) as unknown as Project, add, notes: [] });
  /** importCopy の結果（空文字＝できた／文字列＝できなかった理由）。直す前の版（true／false を、待たずに返す）も同じ形にそろえる */
  const run = async (t: Tab, c: ProjectCopy, ms = 3000): Promise<string> => {
    const r = (t.session.importCopy as unknown as (c: ProjectCopy) => unknown).call(t.session, c);
    await tick(ms);
    const v = (await r) as boolean | { ok: boolean; message?: string };
    return typeof v === 'boolean' ? (v ? '' : 'しませんでした') : v.ok ? '' : v.message ?? '';
  };
  const staffS1 = { id: 's1', name: '端末側の古いスタッフ', hourlyRate: 1000, transportPerDay: 0, memo: '' };

  it('共有側の最新の内容を受け取れていない間（圏外）は、共有へコピーしない', async () => {
    const t = await openTab();
    await ready(t);
    setOnline(false);
    await tick(100);
    expect(await run(t, copy())).toContain('しませんでした');
    expect(fake.queue).toHaveLength(0);
    expect(outboxEntries()).toHaveLength(0);
    setOnline(true);
    await tick(100);
    expect(await run(t, copy())).toBe('');
    expect(serverDoc(P, 'p-copy')?.name).toBe('コピー');
  });

  // Codex の 2 回目の指摘と同じ種類の抜け: 「共有側に無い」と確かめることと、作ることを、切り離さない
  it('「無い」と確かめたあと、作る前に、ほかの人が同じ ID のものを作っていたら、上書きしない（案件はコピーされる）', async () => {
    const t = await openTab();
    await ready(t);
    const c = copy({ staff: [staffS1] as never });
    const r = (t.session.importCopy as unknown as (c: ProjectCopy) => unknown).call(t.session, c);
    setServer(MASTER_COLL.staff, 's1', { ...staffS1, name: 'B が先に作ったスタッフ', order: 0, rev: 'rB' });   // 確かめた直後に、B が同じ ID で作った
    await tick(3000);
    const v = await r;
    expect(serverDoc(MASTER_COLL.staff, 's1')).toMatchObject({ name: 'B が先に作ったスタッフ', rev: 'rB' });
    expect(serverDoc(P, 'p-copy')?.name).toBe('コピー');
    if (typeof v === 'object') expect(v).toEqual({ ok: true, existed: 1 });   // 足さなかった件数を、呼び出し側へ伝える（利用者への表示用）
  });

  // 「確かめてから作る」書き込みは、送信待ちの列を通らない。先に送った書き込みが残っている間に作ると、順番が入れ替わる
  it('この端末が先に送った削除が、まだ送信待ちに残っている間は、コピーしない（削除があとから届いて、コピーした案件の参照先が消えない）', async () => {
    setServer(MASTER_COLL.staff, 's1', { ...staffS1, name: '共有側のスタッフ', order: 0, rev: 'r0' });
    const t = await openTab();
    await ready(t);
    fake.writeDelay = 15000;                        // 送信待ちが、なかなかサーバーに届かない
    t.session.setMaster('staff', view(t).data.staff, []);   // 共有側の s1 を削除した（まだ届いていない。画面からは消えている）
    expect(view(t).data.staff).toEqual([]);
    expect(await run(t, copy({ staff: [staffS1] as never }), 9000)).toContain('送信中の変更が残っている');
    expect(serverDoc(P, 'p-copy')).toBeUndefined();
    await tick(10000);                              // 削除が届いた
    expect(serverDoc(MASTER_COLL.staff, 's1')).toBeUndefined();
    expect(await run(t, copy({ staff: [staffS1] as never }))).toBe('');
    expect(serverDoc(MASTER_COLL.staff, 's1')?.name).toBe('端末側の古いスタッフ');
    expect(serverDoc(P, 'p-copy')?.name).toBe('コピー');
  });

  it('押した直後に接続が切れたら、何も作らず、端末内の送信待ちにも残さない（あとから勝手に作られない）', async () => {
    const t = await openTab();
    await ready(t);
    setNetwork(false);                              // 切れた直後（アプリからは、まだつながっているように見える）
    expect(await run(t, copy({ staff: [staffS1] as never }))).not.toBe('');
    expect(fake.queue).toHaveLength(0);
    expect(outboxEntries()).toHaveLength(0);
    setNetwork(true);
    await tick(5000);
    expect(serverDoc(P, 'p-copy')).toBeUndefined();
    expect(serverDoc(MASTER_COLL.staff, 's1')).toBeUndefined();
  });
});

describe('アカウントの登録・端末内キャッシュ', () => {
  it('名簿から外されたら、送信前の変更を手放す（案件は控えに残し、件数を知らせる）', async () => {
    fake.writeDelay = 600000;                       // 送信が終わらない
    const t = await openTab();
    await ready(t);
    t.session.updateProject('p1', memo('送信前のメモ'));
    t.session.setMaster('staff', [], [{ id: 's1', name: '新しいスタッフ' }] as never);
    await tick(1000);
    expect(outboxEntries()).toHaveLength(2);
    fake.access = { role: 'none', enforced: true };
    const resets = fake.resets;
    const run = t.session.recheck();
    await tick(1000);
    await run;
    expect(view(t).phase).toBe('unregistered');
    expect(t.stashes.map((p) => p.memo)).toEqual(['送信前のメモ']);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('送信前だった変更 2 件');
    expect(t.notices[0]).toContain('案件の変更 1 件は');
    expect(t.notices[0]).toContain('そのほかの 1 件');
    expect(outboxEntries()).toHaveLength(0);
    expect(fake.resets).toBe(resets + 1);           // 端末内の共有データの控えを消した
    expect(view(t).unsent).toBe(0);
  });

  it('ログアウトの処理が遅れた別の画面は、開いている画面が使っているキャッシュを消さない', async () => {
    const a = await openTab();
    await ready(a);
    const resets = fake.resets;
    vi.resetModules();
    newWindow();
    const late = await import('./sharedSession');   // まだどのキャッシュも使っていない、別の画面
    await late.claimCache(null);
    expect(fake.resets).toBe(resets);
    await a.mod.claimCache(null);                   // キャッシュを使っていた画面がログアウトしたら、消す
    expect(fake.resets).toBe(resets + 1);
    expect(browser.store.has('kkl_shared_cache_v2')).toBe(false);
  });

  it('登録されていないアカウントは、端末内キャッシュを使っていないので、消さない（ほかの画面を読み込み直させない）', async () => {
    fake.access = { role: 'none', enforced: true };
    const resets = fake.resets;
    const t = await openTab();
    await tick(1000);
    expect(view(t).phase).toBe('unregistered');
    expect(fake.resets).toBe(resets);
    expect(browser.store.has('kkl_shared_cache_v2')).toBe(false);
  });

  it('名簿から外されて消したあと、読み込み直した画面は、もう一度消さない（2 つの画面が交互に読み込み直しを続けない）', async () => {
    const a = await openTab();
    await ready(a);
    fake.access = { role: 'none', enforced: true };
    const run = a.session.recheck();
    await tick(1000);
    await run;
    const resets = fake.resets;                     // 共有データを受け取っていた画面が、1 回消した
    const b = await openTab();                      // 知らせを受けて読み込み直した、もう 1 つの画面
    await tick(1000);
    expect(view(b).phase).toBe('unregistered');
    expect(fake.resets).toBe(resets);
  });

  it('別のアカウントに切り替えたら、前のアカウントのキャッシュを消す。消せなければ、印を前のアカウントのまま残す', async () => {
    const a = await openTab();
    await ready(a);
    const mark = () => JSON.parse(browser.store.get('kkl_shared_cache_v2') ?? 'null') as { uid: string } | null;
    expect(mark()?.uid).toBe('u1');
    fake.resetOk = false;
    await a.mod.claimCache('u2');
    expect(mark()?.uid).toBe('u1');                 // 消せなかった: 次に開いたときに、もう一度消す
    fake.resetOk = true;
    const resets = fake.resets;
    await a.mod.claimCache('u2');
    expect(fake.resets).toBe(resets + 1);
    expect(mark()?.uid).toBe('u2');
  });
});

describe('メンバー名簿', () => {
  const member = (email: string, role: 'owner' | 'member') => ({ email, role, addedAt: 1, addedBy: 'x' });

  it('管理者の人数は、実際に照合に使われる登録（小文字のメールアドレス）だけを数える', async () => {
    const t = await openTab();
    const list = [member('Owner@Example.com', 'owner'), member('b@example.com', 'owner'), member('c@example.com', 'member'), member('not-an-email', 'owner')];
    expect(t.mod.effectiveOwners(list).map((m) => m.email)).toEqual(['b@example.com']);
    await ready(t);
    for (const m of list) setServer(MEMBER_COLL, m.email, { role: m.role, addedAt: 1, addedBy: 'x' });
    // 有効な管理者は b だけなので、外すことも、メンバーに下げることもできない
    const refuse1 = t.session.removeMember('b@example.com');
    await tick(500);
    expect(await refuse1).toContain('管理者が 1 人もいなくなる');
    const refuse2 = t.session.saveMember('b@example.com', 'member');
    await tick(500);
    expect(await refuse2).toContain('管理者が 1 人もいなくなる');
    expect(serverDoc(MEMBER_COLL, 'b@example.com')?.role).toBe('owner');
    // 無効な登録は、外せる
    const run = t.session.removeMember('Owner@Example.com');
    await tick(500);
    expect(await run).toBe('');
    expect(serverDoc(MEMBER_COLL, 'Owner@Example.com')).toBeUndefined();
  });

  // Codex のレビュー（PR #86 の 1 回目）P2: 「最後の管理者」の確認を、画面が持っている古い一覧ではなく、共有側のいまの名簿で行う
  it('2 人の管理者が、それぞれ古い一覧のまま自分をメンバーに下げても、後のほうは止める', async () => {
    const t = await openTab();
    await ready(t);
    for (const e of ['a@example.com', 'b@example.com']) setServer(MEMBER_COLL, e, { role: 'owner', addedAt: 1, addedBy: 'x' });
    const stale = [member('a@example.com', 'owner'), member('b@example.com', 'owner')];   // どちらの画面も、最初に読んだ一覧のまま
    const save = t.session.saveMember as unknown as (email: string, role: string, current?: unknown) => Promise<string>;
    const first = save.call(t.session, 'a@example.com', 'member', stale);
    await tick(1000);
    expect(await first).toBe('');
    const second = save.call(t.session, 'b@example.com', 'member', stale);
    await tick(1000);
    expect(await second).toContain('管理者が 1 人もいなくなる');
    expect(serverDoc(MEMBER_COLL, 'b@example.com')?.role).toBe('owner');
  });

  it('2 人の管理者が、それぞれ古い一覧のまま自分を名簿から外しても、後のほうは止める', async () => {
    const t = await openTab();
    await ready(t);
    for (const e of ['a@example.com', 'b@example.com']) setServer(MEMBER_COLL, e, { role: 'owner', addedAt: 1, addedBy: 'x' });
    const stale = [member('a@example.com', 'owner'), member('b@example.com', 'owner')];
    const remove = t.session.removeMember as unknown as (email: string, current?: unknown) => Promise<string>;
    const first = remove.call(t.session, 'a@example.com', stale);
    await tick(1000);
    expect(await first).toBe('');
    const second = remove.call(t.session, 'b@example.com', stale);
    await tick(1000);
    expect(await second).toContain('管理者が 1 人もいなくなる');
    expect(serverDoc(MEMBER_COLL, 'b@example.com')?.role).toBe('owner');
  });

  it('圏外では、名簿の変更はその場で失敗する（送信待ちに残らない）', async () => {
    const t = await openTab();
    await ready(t);
    setOnline(false);
    const run = t.session.saveMember('new@example.com', 'member');
    await tick(20000);                              // 名簿の読み直しが時間切れになるまで
    expect(await run).toContain('名簿を変更できませんでした');
    setOnline(true);
    await tick(5000);
    expect(serverDoc(MEMBER_COLL, 'new@example.com')).toBeUndefined();
    dispatch('focus');
  });
});
