import { describe, expect, it } from 'vitest';
import { defaultComposites, defaultPartTypes, emptyData, newProject, newVenue, sampleData } from '../domain/seed';
import { AppData } from '../types';
import { BACKUP_COLL, MASTER_COLL, PROJECT_COLL } from './paths';
import {
  Body, DOC_META_KEYS, LegacyData, Overlay, ServerDoc, applyOverlay, canon, changedFields, composeDocs, diffById, emptyOverlay,
  isValidMemberEmail, judgeRecovery, legacyHasData, nextOrder, normalizeEmail, planMigration, planProjectCopy, sameContent,
  settleOverlay, stripMeta, verifyMigration,
} from './sharedLogic';

/** 入力を書き換えていないことを確かめるため、奥まで凍結する */
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v as object).forEach(freeze); Object.freeze(v); }
  return v;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('内容の比較', () => {
  it('キーの順序が違っても同じ内容とみなす（Firestore から届くとキーの順序が変わるため）', () => {
    expect(sameContent({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 })).toBe(true);
  });
  it('undefined の項目は「無い」のと同じ。null は別物', () => {
    expect(sameContent({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameContent({ a: 1, b: null }, { a: 1 })).toBe(false);
  });
  it('配列は順序も比べる。数値と文字は区別する', () => {
    expect(sameContent([1, 2], [2, 1])).toBe(false);
    expect(sameContent({ a: 1 }, { a: '1' })).toBe(false);
    expect(canon({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
});

describe('差分（利用者が変えたところだけを取り出す）', () => {
  const a = { id: 'a', name: 'A', n: 1 }, b = { id: 'b', name: 'B', n: 2 }, c = { id: 'c', name: 'C', n: 3 };
  it('増えた・変わった・消えた を id で見分ける', () => {
    const d = diffById([a, b, c], [a, { ...b, n: 20 }, { id: 'd', name: 'D', n: 4 }]);
    expect(d.added.map((x) => x.id)).toEqual(['d']);
    expect(d.changed.map((x) => x.id)).toEqual(['b']);
    expect(d.removed).toEqual(['c']);
  });
  it('作り直しただけで内容が同じものは、変わったとみなさない', () => {
    expect(diffById([a, b], [{ ...a }, clone(b)])).toEqual({ added: [], changed: [], removed: [] });
  });
  it('変えた最上位の項目だけを取り出す。消した項目は undefined として出す', () => {
    const base = { id: 'p', name: 'x', memo: 'm', layout: { w: 1, items: [1, 2] }, label: 'L' };
    const next = { id: 'p', name: 'y', memo: 'm', layout: { items: [1, 2], w: 1 } };
    const out = changedFields(base, next);
    expect(out).toEqual({ name: 'y', label: undefined });
    expect('label' in out).toBe(true);
    expect('layout' in out).toBe(false);
  });
});

describe('手元の変更の重ね合わせ（画面 ＝ 届いた内容 ＋ まだ反映されていない自分の変更）', () => {
  const server = (body: Body, pending = false): ServerDoc => ({ body, pending });
  const o = (p: Partial<Overlay>): Overlay => ({ ...emptyOverlay(), ...p });

  it('手元の変更が無ければ、届いた内容そのもの（同じオブジェクト）を返す', () => {
    const body = { id: 'a', memo: 'x' };
    expect(applyOverlay(body, undefined)).toBe(body);
    expect(applyOverlay(body, emptyOverlay())).toBe(body);
    expect(applyOverlay(undefined, undefined)).toBeNull();
  });
  it('入力中に古い内容が届いても、自分が変えた項目は巻き戻らない。触っていない項目は、ほかの人の変更が見える', () => {
    const mine = o({ pending: { memo: '入力中' } });
    const arrived = { id: 'a', memo: '古い内容', fixedRevenue: 50000, rev: 'other' };
    expect(applyOverlay(arrived, mine)).toEqual({ id: 'a', memo: '入力中', fixedRevenue: 50000, rev: 'other' });
    expect(settleOverlay(mine, server(arrived))).toBe(mine);              // 送っていない変更は残る
  });
  it('送った変更は、その変更が反映された内容が届いたら手元から外す（それより前に送った分も一緒に）', () => {
    const mine = o({ issued: [{ rev: 'r1', patch: { memo: '1' } }, { rev: 'r2', patch: { memo: '2' } }], pending: { name: 'n' } });
    expect(settleOverlay(mine, server({ id: 'a', memo: '0', rev: 'other' }))!.issued.length).toBe(2);
    const after = settleOverlay(mine, server({ id: 'a', memo: '1', rev: 'r1' }))!;
    expect(after.issued.map((i) => i.rev)).toEqual(['r2']);
    expect(settleOverlay(mine, server({ id: 'a', memo: '2', rev: 'r2' }))!.issued).toEqual([]);
    expect(settleOverlay(o({ issued: [{ rev: 'r1', patch: {} }] }), server({ id: 'a', rev: 'r1' }))).toBeNull();
  });
  it('送った順に重ねる（後から送った変更・まだ送っていない変更が勝つ）', () => {
    const mine = o({ issued: [{ rev: 'r1', patch: { memo: '1', a: 1 } }, { rev: 'r2', patch: { memo: '2' } }], pending: { memo: '3' } });
    expect(applyOverlay({ id: 'a', memo: '0' }, mine)).toEqual({ id: 'a', memo: '3', a: 1 });
  });
  it('自分が作ったものは、届くまで手元の内容で表示し、届いたら届いた内容に切り替える', () => {
    const mine = o({ created: { id: 'n', name: '新規' }, pending: { name: '新規2' } });
    expect(applyOverlay(undefined, mine)).toEqual({ id: 'n', name: '新規2' });
    const after = settleOverlay(mine, server({ id: 'n', name: '新規' }))!;
    expect(after.created).toBeUndefined();
    expect(after.pending).toEqual({ name: '新規2' });
  });
  it('自分が削除したものは表示しない。届いた内容から消えたら、削除は完了', () => {
    const mine = o({ deleted: true });
    expect(applyOverlay({ id: 'a' }, mine)).toBeNull();
    expect(settleOverlay(mine, server({ id: 'a' }))).toBe(mine);
    expect(settleOverlay(mine, undefined)).toBeNull();
  });
  it('編集中に、ほかの端末で削除された場合: 送信の結果が出るまでは、編集を始めたときの内容に自分の変更を重ねて表示する', () => {
    const mine = o({ base: { id: 'a', name: '案件', memo: '' }, pending: { memo: '書きかけ' } });
    expect(applyOverlay(undefined, mine)).toEqual({ id: 'a', name: '案件', memo: '書きかけ' });
    expect(settleOverlay(mine, undefined)).toBe(mine);
  });
  it('並び順（order → id）にそろえる。新しく作るものは末尾の番号', () => {
    const s = new Map<string, ServerDoc>([
      ['b', server({ id: 'b', order: 1 })], ['a', server({ id: 'a', order: 1 })], ['z', server({ id: 'z', order: 0 })], ['q', server({ id: 'q' })],
    ]);
    const ov = new Map<string, Overlay>([['a', o({ deleted: true })], ['n', o({ created: { id: 'n', order: 2 } })]]);
    const docs = composeDocs(s, ov);
    expect(docs.map((d) => d.id)).toEqual(['z', 'b', 'n', 'q']);
    expect(nextOrder(docs)).toBe(3);
    expect(nextOrder([])).toBe(0);
  });
});

describe('管理用の項目（order・rev・updatedBy）', () => {
  it('中身の項目名と重ならない（マスタ・案件を最上位に並べて保存するため）', () => {
    const d = sampleData();
    const all: object[] = [...d.staff, ...d.venues, ...d.contents, ...d.partTypes, ...d.composites, ...d.projects, newProject(), newVenue(), ...emptyData().partTypes];
    for (const x of all) for (const k of DOC_META_KEYS) expect(k in x, `${k} が中身の項目名と重なっています`).toBe(false);
  });
  it('読むときに取り除く', () => {
    expect(stripMeta({ id: 'a', name: 'x', order: 3, rev: 'r', updatedBy: { uid: 'u' } })).toEqual({ id: 'a', name: 'x' });
  });
});

describe('メンバー名簿のメールアドレス', () => {
  it('前後の空白を除き、小文字にそろえる', () => {
    expect(normalizeEmail('  Taro.Yamada@Example.COM ')).toBe('taro.yamada@example.com');
  });
  it('形式が正しくないもの・ドキュメント名に使えないものは受け付けない', () => {
    expect(isValidMemberEmail('a@example.com')).toBe(true);
    expect(isValidMemberEmail(' A@Example.com ')).toBe(true);
    for (const bad of ['', 'abc', 'a@b', 'a b@example.com', 'a/b@example.com', '@example.com', 'a@.com ', 'a@@example.com']) {
      expect(isValidMemberEmail(bad), bad).toBe(false);
    }
  });
});

// ── 移行 ─────────────────────────────────────────────────────
function legacyOf(d: AppData): LegacyData {
  return {
    masters: {
      staff: { items: d.staff, updatedAt: 1, updatedBy: { uid: 'u', displayName: 'x' } },
      venues: { items: d.venues, updatedAt: 1 },
      contents: { items: d.contents, updatedAt: 1 },
      partTypes: { items: d.partTypes, updatedAt: 1 },
      composites: { items: d.composites, updatedAt: 1 },
    },
    projects: d.projects.map((p) => ({ id: p.id, doc: { ...(p as unknown as Body), updatedBy: { uid: 'u', displayName: 'x' } } })),
  } as LegacyData;
}
const defaults = () => ({ partTypes: defaultPartTypes(), composites: defaultComposites() });
const writeAll = (plan: ReturnType<typeof planMigration>) =>
  new Map<string, Body | null>([...plan.docs, ...plan.backups].map((d) => [`${d.coll}/${d.id}`, clone(d.body)]));

describe('旧形式（V1・V2）からの移行の計画', () => {
  const data = sampleData();
  const legacy = freeze(legacyOf(clone(data)));

  it('マスタは 1 件＝1 ドキュメントにばらし、ドキュメント名に元の ID を使う。案件は同じ ID のまま写す', () => {
    const plan = planMigration(legacy, 'b1', defaults());
    expect(plan.counts).toEqual({
      staff: data.staff.length, venues: data.venues.length, contents: data.contents.length,
      partTypes: data.partTypes.length, composites: data.composites.length, projects: data.projects.length,
    });
    const staff = plan.docs.filter((d) => d.coll === MASTER_COLL.staff);
    expect(staff.map((d) => d.id)).toEqual(data.staff.map((s) => s.id));
    expect(staff.map((d) => d.body.order)).toEqual(data.staff.map((_, i) => i));
    expect(stripMeta(staff[0].body)).toEqual(clone(data.staff[0]));
    const projects = plan.docs.filter((d) => d.coll === PROJECT_COLL);
    expect(projects.map((d) => d.id)).toEqual(data.projects.map((p) => p.id));
    expect(stripMeta(projects[0].body)).toEqual(clone(data.projects[0]));
  });
  it('何度計画しても同じ場所・同じ内容になる（やり直しても重複しない）', () => {
    const a = planMigration(legacy, 'b1', defaults()), b = planMigration(legacy, 'b1', defaults());
    expect(b.docs).toEqual(a.docs);
    expect(b.backups).toEqual(a.backups);
    expect(new Set(a.docs.map((d) => `${d.coll}/${d.id}`)).size).toBe(a.docs.length);
  });
  it('移行前バックアップは、旧形式のドキュメントをそのままの形で写す（目録つき）', () => {
    const plan = planMigration(legacy, 'b1', defaults());
    expect(plan.backups.every((b) => b.coll === BACKUP_COLL && b.id.startsWith('b1__'))).toBe(true);
    const manifest = plan.backups[0];
    expect(manifest.id).toBe('b1__manifest');
    expect((manifest.body.files as string[]).length).toBe(plan.backups.length - 1);
    expect(plan.backups.find((b) => b.id === 'b1__data__staff')!.body.doc).toEqual(legacy.masters.staff);
    expect(plan.backups.find((b) => b.id === `b1__project__${data.projects[0].id}`)!.body.doc).toEqual(legacy.projects[0].doc);
  });
  it('旧形式に保存されていなかったパーツ・組み合わせ配置は、初期値を入れる（その旨を記録）', () => {
    const l = legacyOf(clone(data));
    l.masters.partTypes = null;
    l.masters.composites = null;
    const plan = planMigration(freeze(l), 'b1', defaults());
    expect(plan.counts.partTypes).toBe(defaultPartTypes().length);
    expect(plan.counts.composites).toBe(defaultComposites().length);
    expect(plan.notes.length).toBe(2);
    expect(plan.backups.some((b) => b.id === 'b1__data__partTypes')).toBe(false);
  });
  it('ID の無いもの・ID が重複しているものがあっても止まらず、どう扱ったかを記録する', () => {
    const l = legacyOf(clone(data));
    const items = l.masters.staff!.items as Body[];
    items.push({ ...items[0], name: '重複' }, { name: 'ID なし', hourlyRate: 1 });
    const plan = planMigration(freeze(l), 'b1', defaults());
    const staff = plan.docs.filter((d) => d.coll === MASTER_COLL.staff);
    expect(staff.length).toBe(data.staff.length + 1);
    expect(staff[staff.length - 1].id).toBe(`legacy-staff-${data.staff.length + 1}`);
    expect(staff.map((d) => d.body.order)).toEqual(staff.map((_, i) => i));
    expect(plan.notes.some((n) => n.includes('重複'))).toBe(true);
    expect(plan.notes.some((n) => n.includes('ID が無かった'))).toBe(true);
  });
  it('旧形式のデータが何も無ければ「移行するものが無い」と分かる', () => {
    const none = { masters: { staff: null, venues: null, contents: null, partTypes: null, composites: null }, projects: [] } as LegacyData;
    expect(legacyHasData(none)).toBe(false);
    expect(legacyHasData(legacy)).toBe(true);
    expect(legacyHasData({ ...none, projects: [{ id: 'p', doc: {} }] })).toBe(true);
  });
});

describe('移行後の照合（件数と、1 件ずつの内容）', () => {
  const plan = planMigration(legacyOf(clone(sampleData())), 'b1', defaults());
  it('すべて一致すれば合格', () => {
    const r = verifyMigration(plan, writeAll(plan));
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.rows.every((x) => x.match && x.source === x.target)).toBe(true);
    expect(r.rows.map((x) => x.label)).toEqual(['スタッフ', '会場', 'コンテンツ', 'パーツ', '組み合わせ配置', '案件', 'バックアップ']);
  });
  it('1 件でも欠けていれば不合格（どれが欠けたかを示す）', () => {
    const back = writeAll(plan);
    const lost = plan.docs.find((d) => d.coll === PROJECT_COLL)!;
    back.delete(`${lost.coll}/${lost.id}`);
    const r = verifyMigration(plan, back);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([`${lost.coll}/${lost.id}`]);
    expect(r.rows.find((x) => x.label === '案件')).toMatchObject({ match: false, target: plan.counts.projects - 1 });
  });
  it('件数が同じでも、内容が 1 か所違えば不合格', () => {
    const back = writeAll(plan);
    const target = plan.docs.find((d) => d.coll === MASTER_COLL.staff)!;
    back.set(`${target.coll}/${target.id}`, { ...clone(target.body), hourlyRate: 1 });
    const r = verifyMigration(plan, back);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([`${target.coll}/${target.id}`]);
  });
  it('バックアップが欠けていても不合格', () => {
    const back = writeAll(plan);
    back.delete(`${BACKUP_COLL}/b1__data__staff`);
    expect(verifyMigration(plan, back).ok).toBe(false);
  });
});

describe('置き場所をまたぐ案件のコピー', () => {
  const source = freeze(sampleData());
  const pid = source.projects[1].id;

  it('案件が使っている会場・コンテンツ・スタッフ・パーツのうち、コピー先に無いものを一緒に足す', () => {
    const target = freeze({ ...emptyData(), partTypes: [], composites: [] });
    const copy = planProjectCopy(source, pid, target, 'new-id')!;
    const p = source.projects[1];
    expect(copy.project.id).toBe('new-id');
    expect({ ...copy.project, id: p.id }).toEqual(p);
    expect(copy.add.venues!.map((v) => v.id)).toEqual([p.venueId]);
    expect(copy.add.contents!.map((c) => c.id).sort()).toEqual([...new Set(p.contents.map((c) => c.contentId))].sort());
    expect(copy.add.staff!.map((s) => s.id).sort()).toEqual([...new Set(p.assignments.map((a) => a.staffId))].sort());
    expect(copy.add.partTypes!.map((x) => x.id).sort()).toEqual([...new Set(p.layout.items.map((i) => i.partTypeId))].sort());
    expect(copy.notes).toEqual([]);
  });
  it('コピー先に同じ ID のものがあれば、コピー先のものを使う（上書きしない）。内容が違う場合は知らせる', () => {
    const changed = clone(source.staff[0]);
    changed.hourlyRate = 9999;
    const target = freeze({ ...emptyData(), staff: [changed], venues: clone(source.venues), partTypes: clone(source.partTypes) });
    const copy = planProjectCopy(source, pid, target, 'new-id')!;
    expect((copy.add.staff ?? []).some((s) => s.id === changed.id)).toBe(false);
    expect(copy.add.venues).toBeUndefined();
    expect(copy.notes.length).toBe(1);
    expect(copy.notes[0]).toContain(changed.name);
    expect(copy.notes[0]).toContain('上書きしていません');
  });
  it('パーツの単価など、コピー先と内容が違うマスタは 1 件ずつ知らせる（サンプルは仮の単価を持つため、初期値と違う）', () => {
    const copy = planProjectCopy(source, pid, emptyData(), 'new-id')!;
    const differing = source.partTypes.filter((x) => {
      const d = emptyData().partTypes.find((y) => y.id === x.id);
      return d && !sameContent(d, x) && source.projects[1].layout.items.some((i) => i.partTypeId === x.id);
    });
    expect(differing.length).toBeGreaterThan(0);
    expect(copy.notes.length).toBe(differing.length);
    for (const x of differing) expect((copy.add.partTypes ?? []).some((y) => y.id === x.id)).toBe(false);
  });
  it('名前に印を付けられる（控え）。元のデータは書き換えない。無い案件は null', () => {
    const copy = planProjectCopy(source, pid, emptyData(), 'x', '（控え）')!;
    expect(copy.project.name).toBe(`${source.projects[1].name}（控え）`);
    copy.project.layout.items.length = 0;
    expect(source.projects[1].layout.items.length).toBeGreaterThan(0);
    expect(planProjectCopy(source, 'no-such', emptyData(), 'x')).toBeNull();
  });
  it('元から参照先が無いもの（削除済みのスタッフなど）は、そのまま持っていく（足すものは無い）', () => {
    const src = clone(source) as AppData;
    src.staff = [];
    const copy = planProjectCopy(src, pid, emptyData(), 'x')!;
    expect(copy.add.staff).toBeUndefined();
    expect(copy.project.assignments.length).toBe(source.projects[1].assignments.length);
  });
});

describe('前回の残り（送る前に画面が閉じられた変更）を、共有側のいまの内容と突き合わせる', () => {
  const server = { id: 'p1', name: '案件', memo: '共有側のメモ', contents: [{ contentId: 'c1', count: 2 }], order: 3, updatedAt: 100, rev: 'r5', updatedBy: { uid: 'u9' } };
  it('共有側に無い（削除された・届いていなかった）→ 何も書かない', () => {
    expect(judgeRecovery({ memo: '前回のメモ' }, ['r5'], null)).toBe('gone');
  });
  it('変えた項目が、共有側と同じ内容 → 何も書かない（共有側の印が何であっても）', () => {
    expect(judgeRecovery({ memo: '共有側のメモ' }, [], freeze(clone(server)))).toBe('same');
    expect(judgeRecovery({ contents: [{ count: 2, contentId: 'c1' }] }, ['r1'], freeze(clone(server)))).toBe('same');   // キーの順序の違いは、同じ内容
  });
  it('違うのが管理用の項目（並び順・更新時刻・印・最後に書いた人）だけなら、同じ内容として扱う', () => {
    expect(judgeRecovery({ memo: '共有側のメモ', order: 9, updatedAt: 999, rev: 'x', updatedBy: { uid: 'u1' } }, ['r5'], freeze(clone(server)))).toBe('same');
  });
  it('内容が違い、共有側の印が「誰も触っていない」しるしのどれか → 書く', () => {
    expect(judgeRecovery({ memo: '前回のメモ' }, ['r4', 'r5'], freeze(clone(server)))).toBe('send');
  });
  it('内容が違い、共有側の印が、しるしのどれでもない（＝その後に誰かが保存した）→ 書かない', () => {
    expect(judgeRecovery({ memo: '前回のメモ' }, ['r3', 'r4'], freeze(clone(server)))).toBe('changed');
    expect(judgeRecovery({ memo: '前回のメモ' }, [], freeze(clone(server)))).toBe('changed');
  });
  it('印の無いドキュメントは、しるしに空文字があるときだけ「誰も触っていない」とみなす', () => {
    const noRev = { id: 'p1', memo: '共有側のメモ' };
    expect(judgeRecovery({ memo: '前回のメモ' }, [''], noRev)).toBe('send');
    expect(judgeRecovery({ memo: '前回のメモ' }, ['r5'], noRev)).toBe('changed');
  });
  it('共有側に無い項目を足す変更・項目を消す変更も、内容の違いとして扱う', () => {
    expect(judgeRecovery({ caption: '新しい項目' }, ['r5'], freeze(clone(server)))).toBe('send');
    expect(judgeRecovery({ memo: undefined }, ['r5'], freeze(clone(server)))).toBe('send');
    expect(judgeRecovery({ caption: undefined }, ['r1'], freeze(clone(server)))).toBe('same');   // 無い項目を消す＝変わらない
  });
});
