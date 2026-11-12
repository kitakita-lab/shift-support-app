// レイアウトの確認：L字（組み合わせ）を 1 つの部品として扱えること、番号の自動付番と手動上書き、
// 移動・回転・図面の境界、会場雛形のコピー。試算との連動（備品費・席数）は calc.test.ts 側。
import { describe, expect, it } from 'vitest';
import { Layout, PlacedItem } from '../types';
import { countParts } from './calc';
import {
  addComposite, addPart, bbox, buildLabels, dragSet, emptyLayout, itemSize, moveItems, noteLines,
  removeItems, removeLastPart, rotateItem, ungroup, updateItem,
} from './layout';
import { defaultComposites, defaultPartTypes, layoutFromTemplate, sampleTemplate } from './seed';

const parts = defaultPartTypes();
const pt = (id: string) => parts.find((p) => p.id === id)!;
const [L, Lrev, row2] = defaultComposites();
const labelsOf = (l: Layout) => l.items.map((i) => buildLabels(l, parts).items.get(i.id));
const groupTitles = (l: Layout) => buildLabels(l, parts).groups.map((g) => g.title);
const rel = (l: Layout, ids: string[]) => {
  const xs = l.items.filter((i) => ids.includes(i.id));
  return xs.map((i) => [i.x - xs[0].x, i.y - xs[0].y]);
};

describe('L字（組み合わせ配置）を 1 つの部品として扱える', () => {
  it('置く：構成どおりの 3 台が 1 グループとして入る', () => {
    const l = addComposite(emptyLayout(), L, parts);
    expect(l.items).toHaveLength(3);
    expect(l.groups).toEqual([{ id: l.items[0].groupId, name: 'L字' }]);
    expect(new Set(l.items.map((i) => i.groupId)).size).toBe(1);
    // 構成（横2台＋縦1台）の相対位置がそのまま入る
    expect(rel(l, l.items.map((i) => i.id))).toEqual(L.members.map((m) => [m.dx, m.dy]));
    expect(l.items.map((i) => i.rot)).toEqual([0, 0, 90]);
    expect(countParts(l).get('pt-table')).toBe(3);
  });
  it('選ぶ：どの 1 台をつかんでも、グループ全員が移動対象になる', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = addPart(l, pt('pt-table'));
    const group = l.items.slice(0, 3).map((i) => i.id);
    for (const id of group) expect(dragSet(l, id)).toEqual(group);
    expect(dragSet(l, l.items[3].id)).toEqual([l.items[3].id]);   // グループ外の単体は自分だけ
    expect(dragSet(l, 'no-such-id')).toEqual([]);
  });
  it('動かす：全員が同じ量だけ動き、L字の形（相対位置）が崩れない', () => {
    const l0 = addComposite(emptyLayout(), L, parts);
    const ids = l0.items.map((i) => i.id);
    const l1 = moveItems(l0, ids, 123, -17, parts, 0);
    l1.items.forEach((i, k) => expect([i.x - l0.items[k].x, i.y - l0.items[k].y]).toEqual([123, -17]));
    expect(rel(l1, ids)).toEqual(rel(l0, ids));
  });
  it('動かす：図面の端に当たっても形は崩れない（グループ全体の外枠で止まる）', () => {
    const l0 = addComposite(emptyLayout(1000, 800), L, parts);
    const ids = l0.items.map((i) => i.id);
    for (const [dx, dy] of [[9999, 9999], [-9999, -9999], [9999, -9999]]) {
      const l1 = moveItems(l0, ids, dx, dy, parts, 5);
      expect(rel(l1, ids)).toEqual(rel(l0, ids));
      const bb = bbox(l1.items, parts);
      expect(bb.x).toBeGreaterThanOrEqual(0);
      expect(bb.y).toBeGreaterThanOrEqual(0);
      expect(bb.x + bb.w).toBeLessThanOrEqual(1000);
      expect(bb.y + bb.h).toBeLessThanOrEqual(800);
    }
  });
  it('動かす：吸着（5/10/50cm）は先頭の 1 台を格子に合わせ、残りは同じ量だけ動く', () => {
    const l0 = addComposite(emptyLayout(), L, parts);       // 先頭は (30, 30)
    const ids = l0.items.map((i) => i.id);
    const l1 = moveItems(l0, ids, 23, 48, parts, 50);       // 53, 78 → 50, 100
    expect([l1.items[0].x, l1.items[0].y]).toEqual([50, 100]);
    expect(rel(l1, ids)).toEqual(rel(l0, ids));
  });
  it('消す：グループごと削除すると 3 台とグループの両方が消える', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = addComposite(l, Lrev, parts);
    const first = l.items.filter((i) => i.groupId === l.groups[0].id).map((i) => i.id);
    const out = removeItems(l, first);
    expect(out.items).toHaveLength(3);
    expect(out.groups.map((g) => g.name)).toEqual(['L字（逆）']);
    expect(countParts(out).get('pt-table')).toBe(3);
  });
  it('消す：1 台だけ削除するとグループは残りの台で続く。最後の 1 台を消すとグループも消える', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = removeItems(l, [l.items[1].id]);
    expect(l.items).toHaveLength(2);
    expect(l.groups).toHaveLength(1);
    expect(labelsOf(l)).toEqual(['①-1', '①-2']);            // 番号は詰まる
    l = removeItems(l, l.items.map((i) => i.id));
    expect(l.groups).toEqual([]);
  });
  it('解除：グループ解除でパーツは残り、1 台ずつ動かせる単体になる', () => {
    let l = addComposite(emptyLayout(), L, parts);
    const gid = l.groups[0].id;
    l = ungroup(l, gid);
    expect(l.items).toHaveLength(3);
    expect(l.groups).toEqual([]);
    expect(l.items.every((i) => i.groupId === undefined)).toBe(true);
    expect(dragSet(l, l.items[0].id)).toEqual([l.items[0].id]);
    expect(labelsOf(l)).toEqual(['T1', 'T2', 'T3']);
  });
  it('個数の［−］：グループ外の単体を先に減らす。単体が無くなったらグループから 1 台ずつ減る', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = addPart(l, pt('pt-table'));
    l = addPart(l, pt('pt-table'));
    const n = (x: Layout) => [countParts(x).get('pt-table') ?? 0, x.items.filter((i) => i.groupId).length, x.groups.length];
    expect(n(l)).toEqual([5, 3, 1]);
    l = removeLastPart(l, 'pt-table'); expect(n(l)).toEqual([4, 3, 1]);
    l = removeLastPart(l, 'pt-table'); expect(n(l)).toEqual([3, 3, 1]);   // ここまで L字は無傷
    l = removeLastPart(l, 'pt-table'); expect(n(l)).toEqual([2, 2, 1]);
    l = removeLastPart(l, 'pt-table'); expect(n(l)).toEqual([1, 1, 1]);
    l = removeLastPart(l, 'pt-table'); expect(n(l)).toEqual([0, 0, 0]);
    expect(removeLastPart(l, 'pt-table')).toBe(l);                          // 0 個からは減らない（何も変えない）
  });
  it('構成に削除済みの種別が混ざっていたら、その 1 台だけ飛ばして置く。全部が無効なら何も置かない', () => {
    const noTable = parts.filter((p) => p.id !== 'pt-table');
    const mixed = { ...L, members: [...L.members, { partTypeId: 'pt-nego', dx: 300, dy: 0, rot: 0 as const }] };
    expect(addComposite(emptyLayout(), mixed, noTable).items.map((i) => i.partTypeId)).toEqual(['pt-nego']);
    const l = emptyLayout();
    expect(addComposite(l, L, noTable)).toBe(l);
  });
  it('他の組み合わせ（L字（逆）・横2台連結）も同じ扱い', () => {
    const l = addComposite(addComposite(emptyLayout(), Lrev, parts), row2, parts);
    expect(l.groups.map((g) => g.name)).toEqual(['L字（逆）', '横2台連結']);
    expect(labelsOf(l)).toEqual(['①-1', '①-2', '①-3', '②-1', '②-2']);
    expect(buildLabels(l, parts).groups.map((g) => g.subtitle)).toEqual(['横2台＋縦1台', '横2台']);
  });
});

describe('テーブル番号の自動付番', () => {
  it('グループは作成順に ①②…、グループ内のテーブルは ①-1 形式', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = addComposite(l, L, parts);
    expect(labelsOf(l)).toEqual(['①-1', '①-2', '①-3', '②-1', '②-2', '②-3']);
    expect(groupTitles(l)).toEqual(['L字①', 'L字②']);
  });
  it('グループ外の番号つきパーツは「表示名＋連番」。連番は種別ごと', () => {
    let l = emptyLayout();
    for (const id of ['pt-table', 'pt-nego', 'pt-table', 'pt-pop-l', 'pt-nego']) l = addPart(l, pt(id));
    expect(labelsOf(l)).toEqual(['T1', '商談席1', 'T2', 'POP1', '商談席2']);
  });
  it('番号なしのパーツは表示名だけ。表示名が空（椅子など）なら何も出さない', () => {
    let l = emptyLayout();
    for (const id of ['pt-banner', 'pt-work', 'pt-chair', 'pt-pop-s']) l = addPart(l, pt(id));
    expect(labelsOf(l)).toEqual(['バナー', '中央作業台', '', '']);
  });
  it('グループ内の連番と、グループ外の連番は別々に数える', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = addPart(l, pt('pt-table'));
    expect(labelsOf(l)).toEqual(['①-1', '①-2', '①-3', 'T1']);
  });
  it('減らすと自動的に詰まる（欠番を作らない。作業ログ D-08）', () => {
    let l = emptyLayout();
    for (let i = 0; i < 3; i++) l = addPart(l, pt('pt-nego'));
    l = removeItems(l, [l.items[1].id]);                    // 真ん中の「商談席2」を削除
    expect(labelsOf(l)).toEqual(['商談席1', '商談席2']);
  });
  it('グループを消すと、後ろのグループの番号が繰り上がる（②→①）', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = addComposite(l, Lrev, parts);
    l = removeItems(l, l.items.filter((i) => i.groupId === l.groups[0].id).map((i) => i.id));
    expect(groupTitles(l)).toEqual(['L字（逆）①']);
    expect(labelsOf(l)).toEqual(['①-1', '①-2', '①-3']);
  });
  it('番号は保存しない（毎回レイアウトから導出する）', () => {
    const l = addPart(addComposite(emptyLayout(), L, parts), pt('pt-nego'));
    expect(l.items.every((i) => i.label === undefined)).toBe(true);
    expect(JSON.stringify(l)).not.toContain('①');
  });
  it('グループ名の副題は「横◯台＋縦◯台」。1 台を回転させると数え直す', () => {
    let l = addComposite(emptyLayout(), L, parts);
    expect(buildLabels(l, parts).groups[0].subtitle).toBe('横2台＋縦1台');
    l = rotateItem(l, l.items[0].id, parts);
    expect(buildLabels(l, parts).groups[0].subtitle).toBe('横1台＋縦2台');
  });
  it('21 個目以降のグループは (21) と表示する（丸数字は ⑳ まで）', () => {
    let l = emptyLayout(5000, 5000);
    for (let i = 0; i < 21; i++) l = addComposite(l, row2, parts);
    const titles = groupTitles(l);
    expect(titles[19]).toBe('横2台連結⑳');
    expect(titles[20]).toBe('横2台連結(21)');
    expect(buildLabels(l, parts).items.get(l.items[40].id)).toBe('(21)-1');
  });
});

describe('テーブル番号の手動上書き', () => {
  it('表示名を入れると自動の番号より優先される（グループ内・グループ外とも）', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = addPart(l, pt('pt-nego'));
    l = updateItem(l, l.items[0].id, { label: 'A-1' });
    l = updateItem(l, l.items[3].id, { label: 'VIP席' });
    expect(labelsOf(l)).toEqual(['A-1', '①-1', '①-2', 'VIP席']);          // 手入力したものは連番を使わない（D-18）
  });
  it('表示名を空に戻すと自動の番号に戻る', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = updateItem(l, l.items[1].id, { label: '受付' });
    expect(labelsOf(l)[1]).toBe('受付');
    l = updateItem(l, l.items[1].id, { label: undefined });
    expect(labelsOf(l)).toEqual(['①-1', '①-2', '①-3']);
    l = updateItem(l, l.items[1].id, { label: '' });
    expect(labelsOf(l)).toEqual(['①-1', '①-2', '①-3']);
  });
  it('番号なしのパーツ（バナー・椅子）にも表示名を付けられる。改行（\\n）も保持する', () => {
    let l = addPart(addPart(emptyLayout(), pt('pt-banner')), pt('pt-chair'));
    l = updateItem(l, l.items[0].id, { label: 'ブランド\nバナー' });
    l = updateItem(l, l.items[1].id, { label: '講師席' });
    expect(labelsOf(l)).toEqual(['ブランド\nバナー', '講師席']);
  });
  it('上書きは移動・回転・他パーツの増減で消えない', () => {
    let l = addComposite(emptyLayout(), L, parts);
    const id = l.items[2].id;
    l = updateItem(l, id, { label: '作業台' });
    l = moveItems(l, l.items.map((i) => i.id), 100, 100, parts, 5);
    l = rotateItem(l, id, parts);
    l = addPart(l, pt('pt-table'));
    l = removeItems(l, [l.items[0].id]);
    expect(buildLabels(l, parts).items.get(id)).toBe('作業台');
  });
  it('表示名を上書きしたテーブルは連番を使わない（①-1・受付・①-2）。グループ外も同じ。作業ログ D-18', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = updateItem(l, l.items[1].id, { label: '受付' });
    expect(labelsOf(l)).toEqual(['①-1', '受付', '①-2']);
    let m = emptyLayout();
    for (let i = 0; i < 3; i++) m = addPart(m, pt('pt-nego'));
    m = updateItem(m, m.items[0].id, { label: '相談窓口' });
    expect(labelsOf(m)).toEqual(['相談窓口', '商談席1', '商談席2']);
    m = updateItem(m, m.items[2].id, { label: '予備' });
    expect(labelsOf(m)).toEqual(['相談窓口', '商談席1', '予備']);
  });
  it('上書きしても、グループ名の副題（横◯台＋縦◯台）は実際の台数のまま', () => {
    let l = addComposite(emptyLayout(), L, parts);
    const before = buildLabels(l, parts).groups[0].subtitle;
    l = updateItem(l, l.items[0].id, { label: '受付' });
    l = updateItem(l, l.items[2].id, { label: '講師' });
    expect(buildLabels(l, parts).groups[0].subtitle).toBe(before);
    expect(before).toBe('横2台＋縦1台');
  });
  it('全部を上書きしたグループは、番号が 1 つも出ない（グループ名の番号 ① は残る）', () => {
    let l = addComposite(emptyLayout(), L, parts);
    for (const [i, name] of ['A', 'B', 'C'].entries()) l = updateItem(l, l.items[i].id, { label: name });
    expect(labelsOf(l)).toEqual(['A', 'B', 'C']);
    expect(buildLabels(l, parts).groups[0].title).toBe('L字①');
  });
  it('上書きを空に戻すと、その台も連番に戻り、後ろの番号が 1 つずつ下がる', () => {
    let l = addComposite(emptyLayout(), L, parts);
    l = updateItem(l, l.items[0].id, { label: '受付' });
    expect(labelsOf(l)).toEqual(['受付', '①-1', '①-2']);
    l = updateItem(l, l.items[0].id, { label: undefined });
    expect(labelsOf(l)).toEqual(['①-1', '①-2', '①-3']);
  });
});

describe('移動・回転・図面の境界', () => {
  it('単体は図面の外に出ない（四隅）', () => {
    const l0 = addPart(emptyLayout(500, 400), pt('pt-table'));   // 150×60
    const id = l0.items[0].id;
    const pos = (dx: number, dy: number) => { const i = moveItems(l0, [id], dx, dy, parts).items[0]; return [i.x, i.y]; };
    expect(pos(-9999, -9999)).toEqual([0, 0]);
    expect(pos(9999, -9999)).toEqual([350, 0]);
    expect(pos(-9999, 9999)).toEqual([0, 340]);
    expect(pos(9999, 9999)).toEqual([350, 340]);
  });
  it('動かない移動（移動量 0・対象なし）はレイアウトを作り直さない（履歴や版を無駄に進めない）', () => {
    const l = addPart(emptyLayout(), pt('pt-table'));
    expect(moveItems(l, [l.items[0].id], 0, 0, parts)).toBe(l);
    expect(moveItems(l, ['no-such-id'], 50, 50, parts)).toBe(l);
    const corner = moveItems(l, [l.items[0].id], -9999, -9999, parts);
    expect(moveItems(corner, [corner.items[0].id], -10, -10, parts)).toBe(corner);   // すでに端にいる
  });
  it('90°回転：幅と奥行が入れ替わり、中心は動かない。もう一度回すと元の位置に戻る', () => {
    const l0 = moveItems(addPart(emptyLayout(), pt('pt-table')), [], 0, 0, parts);
    const base = { ...l0, items: l0.items.map((i) => ({ ...i, x: 400, y: 300 })) };
    const id = base.items[0].id;
    const center = (i: PlacedItem) => { const s = itemSize(i, pt(i.partTypeId)); return [i.x + s.w / 2, i.y + s.h / 2]; };
    const r1 = rotateItem(base, id, parts);
    expect(itemSize(r1.items[0], pt('pt-table'))).toEqual({ w: 60, h: 150 });
    expect(center(r1.items[0])).toEqual(center(base.items[0]));
    const r2 = rotateItem(r1, id, parts);
    expect(r2.items[0]).toEqual(base.items[0]);
  });
  it('回転しても図面の外に出ない', () => {
    const l0 = addPart(emptyLayout(500, 400), pt('pt-table'));
    const edge = { ...l0, items: l0.items.map((i) => ({ ...i, x: 350, y: 340 })) };   // 右下の隅
    const r = rotateItem(edge, edge.items[0].id, parts).items[0];
    const s = itemSize(r, pt('pt-table'));
    expect(r.x + s.w).toBeLessThanOrEqual(500);
    expect(r.y + s.h).toBeLessThanOrEqual(400);
  });
  it('追加したパーツは必ず図面の中に置かれる', () => {
    let l = emptyLayout(200, 150);
    for (let i = 0; i < 15; i++) l = addPart(l, pt('pt-chair'));
    for (const i of l.items) {
      expect(i.x).toBeGreaterThanOrEqual(0);
      expect(i.y).toBeGreaterThanOrEqual(0);
      expect(i.x + 40).toBeLessThanOrEqual(200);
      expect(i.y + 40).toBeLessThanOrEqual(150);
    }
  });
});

describe('図面サイズを小さくしたとき（作業ログ D-20：判断待ち）', () => {
  it('現状の仕様：図面の外に取り残されたパーツは動かず、個数（＝試算）には入り続ける。警告は出ない', () => {
    let l = addPart(emptyLayout(1440, 1130), pt('pt-chair'));
    l = moveItems(l, [l.items[0].id], 9999, 0, parts);            // 右端（x = 1400）へ
    const shrunk = { ...l, width: 1000 };                         // 図面の幅を 1000 に縮める（会場変更で雛形が小さい場合も同じ）
    expect(shrunk.items[0].x).toBe(1400);                         // 図面の外（図には描かれない）
    expect(countParts(shrunk).get('pt-chair')).toBe(1);           // でも個数には入る
    // 次に動かしたときに図面の中へ戻る
    expect(moveItems(shrunk, [shrunk.items[0].id], -1, 0, parts).items[0].x).toBe(960);
  });
});

describe('会場雛形と案件レイアウト（作業ログ D-09：コピーして使う）', () => {
  it('案件のレイアウトは雛形の周辺環境のコピー。案件側を直しても雛形は変わらない', () => {
    const tpl = sampleTemplate();
    const snapshot = structuredClone(tpl);
    const l = layoutFromTemplate(tpl);
    expect(l.env.map(({ id: _id, ...e }) => e)).toEqual(tpl.env.map(({ id: _id, ...e }) => e));
    expect(l.env.some((e) => tpl.env.some((t) => t.id === e.id))).toBe(false);   // id は振り直す
    expect([l.width, l.height, l.version, l.issued, l.items]).toEqual([tpl.width, tpl.height, 1, [], []]);
    l.env[0].label = '書き換え';
    l.env.pop();
    expect(tpl).toEqual(snapshot);
  });
});

describe('未確認事項', () => {
  it('1 行 1 項目。前後の空白と空行は除く', () => {
    expect(noteLines('実寸（ブース・通路幅）\n\n  防災条件  \n\n電源の位置\n')).toEqual(['実寸（ブース・通路幅）', '防災条件', '電源の位置']);
    expect(noteLines('')).toEqual([]);
    expect(noteLines(' \n \n')).toEqual([]);
  });
});
