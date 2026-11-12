// 図の内容の指紋と、それで決まる版の状態（作業ログ D-21・D-22）。
// 守りたいこと：「同じ版番号の図は 1 種類だけ」が、エディタの外で起きる変更（案件名・会場名・会期・パーツマスタ）でも保たれること。
// 「指紋が同じなら図も同じ／図が変われば指紋も変わる」ことは、実際に描いた図と突き合わせて LayoutSvg.test.ts で確かめる。
import { describe, expect, it } from 'vitest';
import { Layout, PartType } from '../types';
import {
  FigureContext, SECTION_LABEL, changedSections, figureModel, figureState, figureTitle, fingerprint, issue, pdfFileName,
} from './figure';
import { addPart, bumpIfIssued, emptyLayout, markIssued, undoTo } from './layout';
import { defaultPartTypes, sampleData } from './seed';

const parts = defaultPartTypes();
const chair = parts.find((p) => p.id === 'pt-chair')!;
const CTX: FigureContext = { mode: 'project', projectName: 'ikyu', venueName: 'ラソラ札幌', startDate: '2026-11-13', endDate: '2026-11-17' };
const fpOf = (l: Layout, ctx: Partial<FigureContext> = {}, pts: PartType[] = parts) => fingerprint(figureModel(l, pts, { ...CTX, ...ctx }));

describe('図のモデル', () => {
  const data = sampleData();
  const lasora = data.projects[1];
  const m = figureModel(lasora.layout, data.partTypes, CTX);

  it('タイトルの材料・会期・注記・未確認事項・図面サイズ・周辺環境・パーツ・グループ名が入る', () => {
    expect(m.title).toEqual({ kind: 'project', project: 'ikyu', venue: 'ラソラ札幌' });
    expect(m.period).toBe('2026/11/13(金)〜11/17(火)');
    expect(m.caption).toBe(lasora.layout.caption);
    expect(m.notes).toHaveLength(4);
    expect([m.width, m.height]).toEqual([lasora.layout.width, lasora.layout.height]);
    expect(m.env).toHaveLength(lasora.layout.env.length);
    expect(m.items).toHaveLength(lasora.layout.items.length);
    expect(m.groups.map((g) => g.title)).toEqual(['L字①', 'L字②']);
  });
  it('パーツは、図に必要なもの（位置・向きを反映した寸法・区分・椅子の役割・表示名）だけに直す', () => {
    const tables = m.items.filter((i) => i.category === 'table' && i.label.startsWith('①'));
    expect(tables.map((t) => [t.w, t.h, t.label])).toEqual([[150, 60, '①-1'], [150, 60, '①-2'], [60, 150, '①-3']]);   // 3 台目は縦向き
    expect(m.items.filter((i) => i.role === 'work')).toHaveLength(16);
    expect(m.items.filter((i) => i.role === 'other')).toHaveLength(6);
    expect(m.items.filter((i) => i.category !== 'chair').every((i) => i.role === null)).toBe(true);
    expect(m.items.every((i) => i.known)).toBe(true);
    expect(Object.keys(m.items[0]).sort()).toEqual(['category', 'h', 'id', 'known', 'label', 'role', 'w', 'x', 'y']);
  });
  it('マスタから削除された種別のパーツは known: false（破線で描く）', () => {
    const gone = figureModel(lasora.layout, data.partTypes.filter((t) => t.id !== 'pt-table'), CTX);
    expect(gone.items.filter((i) => !i.known)).toHaveLength(6);
  });
  it('雛形（会場マスタ）では、会期を持たず、タイトルは「会場名 雛形」', () => {
    const t = figureModel(data.venues[0].template, data.partTypes, { ...CTX, mode: 'template' });
    expect([t.title, t.period]).toEqual([{ kind: 'template', venue: 'ラソラ札幌' }, '']);
    expect(figureTitle(t, 5)).toBe('ラソラ札幌 雛形');
    expect(figureTitle(figureModel(emptyLayout(), parts, { ...CTX, mode: 'template', venueName: '' }), 1)).toBe('会場 雛形');
  });
  it('タイトルには版番号が入る', () => {
    expect(figureTitle(m, 3)).toBe('ikyu｜ラソラ札幌 イベント配置図 V3');
  });
});

describe('PDF のファイル名（D-22）', () => {
  it('案件名・会場名・開始日・版数が入る', () => {
    expect(pdfFileName(CTX, 1)).toBe('ikyu_ラソラ札幌_20261113_イベント配置図_V1.pdf');
    expect(pdfFileName({ ...CTX, projectName: 'ikyu（デモ）', startDate: '2026-12-05', endDate: '2026-12-06' }, 12)).toBe('ikyu（デモ）_ラソラ札幌_20261205_イベント配置図_V12.pdf');
  });
  it('会期が図に出ないとき（未入力・終了日が前）は、ファイル名にも日付を入れない', () => {
    expect(pdfFileName({ ...CTX, startDate: '', endDate: '' }, 1)).toBe('ikyu_ラソラ札幌_イベント配置図_V1.pdf');
    expect(pdfFileName({ ...CTX, endDate: '' }, 1)).toBe('ikyu_ラソラ札幌_イベント配置図_V1.pdf');
    expect(pdfFileName({ ...CTX, startDate: '2026-11-18' }, 1)).toBe('ikyu_ラソラ札幌_イベント配置図_V1.pdf');
  });
  it('案件名・会場名が空でも壊れない。ファイル名に使えない文字・空白は _ に置き換える', () => {
    expect(pdfFileName({ ...CTX, projectName: '', venueName: '' }, 2)).toBe('20261113_イベント配置図_V2.pdf');
    expect(pdfFileName({ ...CTX, projectName: 'A/B:C*D?"E<F>G|H', venueName: ' 会場 名 ' }, 1)).toBe('A_B_C_D_E_F_G_H_会場_名_20261113_イベント配置図_V1.pdf');
  });
  it('雛形は「会場名_雛形.pdf」', () => {
    expect(pdfFileName({ ...CTX, mode: 'template' }, 1)).toBe('ラソラ札幌_雛形.pdf');
  });
});

describe('指紋（区分ごと）', () => {
  const base = addPart(emptyLayout(), chair);
  it('同じ内容なら同じ指紋。キーの順序や、作り直しただけのオブジェクトでは変わらない', () => {
    expect(fpOf(base)).toEqual(fpOf(JSON.parse(JSON.stringify(base)) as Layout));
    const reordered = { ...base, items: base.items.map((i) => ({ rot: i.rot, y: i.y, x: i.x, partTypeId: i.partTypeId, id: i.id })) };
    expect(fpOf(reordered)).toEqual(fpOf(base));
  });
  it('変わった区分だけが分かる', () => {
    const a = fpOf(base);
    expect(changedSections(a, fpOf(base, { projectName: 'ikyu2' }))).toEqual(['title']);
    expect(changedSections(a, fpOf(base, { venueName: '別会場' }))).toEqual(['title']);
    expect(changedSections(a, fpOf(base, { endDate: '2026-11-18' }))).toEqual(['period']);
    expect(changedSections(a, fpOf({ ...base, caption: '別の注記' }))).toEqual(['caption']);
    expect(changedSections(a, fpOf({ ...base, notes: '電源の位置' }))).toEqual(['notes']);
    expect(changedSections(a, fpOf({ ...base, width: 1500 }))).toEqual(['size']);
    expect(changedSections(a, fpOf(addPart(base, chair)))).toEqual(['items']);
    expect(changedSections(a, fpOf(base, {}, parts.map((p) => (p.id === 'pt-chair' ? { ...p, widthCm: 45 } : p))))).toEqual(['items']);
    expect(changedSections(a, fpOf({ ...base, env: [{ id: 'e', kind: 'wall', x: 0, y: 0, w: 100, h: 8, label: '壁' }] }))).toEqual(['env']);
    expect(changedSections(a, a)).toEqual([]);
    expect(Object.keys(SECTION_LABEL).sort()).toEqual(Object.keys(a).sort());
  });
  it('版番号・出力の記録・内部の ID は指紋に入らない', () => {
    const a = fpOf(base);
    expect(fpOf({ ...base, version: 9, issued: [{ version: 1, issuedAt: '2026-01-01' }] })).toEqual(a);
    expect(fpOf({ ...base, items: base.items.map((i) => ({ ...i, id: 'another-id' })) })).toEqual(a);
  });
});

describe('版の状態（指紋で決める）', () => {
  const start = addPart(emptyLayout(), chair);
  it('出力するまでは「未出力」。出力すると、その版が指紋つきで記録される。出力しただけでは版は上がらない', () => {
    expect(figureState(start, fpOf(start))).toEqual({ version: 1, status: 'draft' });
    const out = issue(start, fpOf(start), '2026-11-13');
    expect(out.version).toBe(1);
    expect(out.issued).toEqual([{ version: 1, issuedAt: '2026-11-13', fp: fpOf(start) }]);
    expect(figureState(out, fpOf(out))).toEqual({ version: 1, status: 'issued', issuedAt: '2026-11-13' });
  });
  it('図が変わっていなければ、何度出力しても同じ版・同じ日付のまま（記録は増えない）', () => {
    const out = issue(start, fpOf(start), '2026-11-13');
    expect(issue(out, fpOf(out), '2026-12-01')).toBe(out);
  });
  it('出力後に案件名を変える（エディタの外の変更）→ 表示は V2（未出力）になり、何が変わったかが分かる。保存されている版番号は、出力するまで変わらない', () => {
    const out = issue(start, fpOf(start), '2026-11-13');
    const renamed = fpOf(out, { projectName: 'ikyu 秋' });
    expect(figureState(out, renamed)).toEqual({ version: 2, status: 'changed', since: { version: 1, changed: ['title'] } });
    expect(out.version).toBe(1);                                        // 見ただけでは、データは書き換わらない
    const v2 = issue(out, renamed, '2026-11-20');
    expect([v2.version, v2.issued.map((v) => [v.version, v.issuedAt])]).toEqual([2, [[1, '2026-11-13'], [2, '2026-11-20']]]);
    expect(figureState(v2, renamed)).toEqual({ version: 2, status: 'issued', issuedAt: '2026-11-20' });
  });
  it('会場名・会期・パーツマスタの寸法や表示名の変更でも、同じように次の版になる', () => {
    const out = issue(start, fpOf(start), '2026-11-13');
    const state = (ctx: Partial<FigureContext>, pts: PartType[] = parts) => figureState(out, fpOf(out, ctx, pts));
    expect(state({ venueName: '別会場' }).since).toEqual({ version: 1, changed: ['title'] });
    expect(state({ startDate: '2026-11-12' }).since).toEqual({ version: 1, changed: ['period'] });
    expect(state({}, parts.map((p) => (p.id === 'pt-chair' ? { ...p, depthCm: 50 } : p))).since).toEqual({ version: 1, changed: ['items'] });
    expect(state({}, parts.map((p) => (p.id === 'pt-chair' ? { ...p, shortName: '席' } : p))).since).toEqual({ version: 1, changed: ['items'] });
    expect(state({}, parts.map((p) => (p.id === 'pt-chair' ? { ...p, seatRole: 'other' as const } : p))).since).toEqual({ version: 1, changed: ['items'] });
  });
  it('図に出ないもの（単価・保有数・パーツ名・使っていないパーツの寸法）を変えても、出力済みのまま', () => {
    const out = issue(start, fpOf(start), '2026-11-13');
    const still = (pts: PartType[]) => figureState(out, fpOf(out, {}, pts)).status;
    expect(still(parts.map((p) => ({ ...p, unitCost: 999, costUnit: 'day' as const, stockQty: 3 })))).toBe('issued');
    expect(still(parts.map((p) => (p.id === 'pt-chair' ? { ...p, name: '別の名前の椅子' } : p)))).toBe('issued');
    expect(still(parts.map((p) => (p.id === 'pt-table' ? { ...p, widthCm: 999 } : p)))).toBe('issued');
  });
  it('変えたものを元に戻せば、出力済みの版に戻る（同じ図なので、同じ版番号でよい）', () => {
    const out = issue(start, fpOf(start), '2026-11-13');
    expect(figureState(out, fpOf(out, { projectName: '一時的な名前' })).status).toBe('changed');
    expect(figureState(out, fpOf(out))).toEqual({ version: 1, status: 'issued', issuedAt: '2026-11-13' });
  });
  it('指紋の無い記録（Version 2 までに出力した版）は「以前の版で出力」として、次の出力で版が上がる', () => {
    const old = markIssued(start, '2026-11-01');                         // Version 2 の出力の記録（指紋なし）
    expect(figureState(old, fpOf(old))).toEqual({ version: 2, status: 'changed', since: { version: 1, changed: null } });
    const v2 = issue(old, fpOf(old), '2026-11-13');
    expect(v2.issued.map((v) => [v.version, !!v.fp])).toEqual([[1, false], [2, true]]);
    expect(figureState(v2, fpOf(v2)).status).toBe('issued');
  });
  it('エディタでの編集は、これまでどおり編集した時点で次の版になる（表示していた版と同じ番号になる）', () => {
    const out = issue(start, fpOf(start), '2026-11-13');
    const edited = bumpIfIssued(addPart(out, chair));
    expect(figureState(edited, fpOf(edited))).toEqual({ version: 2, status: 'draft' });
    // 案件名を変えて V2（未出力）と表示されている状態から、エディタで編集しても V2 のまま（V3 に飛ばない）
    const afterRename = bumpIfIssued(addPart(out, chair));
    expect(figureState(afterRename, fpOf(afterRename, { projectName: '別名' }))).toEqual({ version: 2, status: 'draft' });
  });
  it('出力済みの状態まで「元に戻す」と、図が同じなら出力済みの版に戻る。マスタが変わっていれば次の版になる', () => {
    const out = issue(start, fpOf(start), '2026-11-13');
    const edited = bumpIfIssued(addPart(out, chair));
    const back = undoTo(edited, out);
    expect(figureState(back, fpOf(back))).toEqual({ version: 1, status: 'issued', issuedAt: '2026-11-13' });
    const wider = parts.map((p) => (p.id === 'pt-chair' ? { ...p, widthCm: 60 } : p));
    expect(figureState(back, fpOf(back, {}, wider))).toMatchObject({ version: 2, status: 'changed' });
  });
});

describe('どんな順番で操作しても、同じ版番号で内容の違う PDF は出ない（エディタの外の変更を含む）', () => {
  /** 画面と同じ手順を純関数で再現する: 編集＝bumpIfIssued、出力＝issue、元に戻す＝undoTo、名前変更＝エディタの外の変更 */
  function session() {
    let layout: Layout = emptyLayout();
    let name = 'A';
    let width = 40;
    const history: Layout[] = [];
    const pdfs: { version: number; content: string }[] = [];
    const now = () => {
      const pts = parts.map((p) => (p.id === 'pt-chair' ? { ...p, widthCm: width } : p));
      const model = figureModel(layout, pts, { ...CTX, projectName: name });
      return { fp: fingerprint(model), content: JSON.stringify([model.title, model.period, model.caption, model.notes, model.width, model.height, model.env, model.items.map(({ id: _id, ...i }) => i), model.groups]) };
    };
    return {
      pdfs,
      edit(k: number) { history.push(layout); layout = bumpIfIssued({ ...addPart(layout, chair), notes: `edit-${k}` }); },
      rename() { name = name === 'A' ? 'B' : 'A'; },
      resize() { width = width === 40 ? 50 : 40; },
      undo() { const prev = history.pop(); if (prev) layout = undoTo(layout, prev); },
      exportPdf() {
        const { fp, content } = now();
        pdfs.push({ version: figureState(layout, fp).version, content });
        layout = issue(layout, fp, '2026-11-13');
      },
      conflicts() {
        const seen = new Map<number, string>();
        const bad = new Set<number>();
        for (const p of pdfs) {
          if (seen.has(p.version) && seen.get(p.version) !== p.content) bad.add(p.version);
          seen.set(p.version, p.content);
        }
        return [...bad];
      },
    };
  }
  it('編集・出力・元に戻す・案件名の変更・パーツ寸法の変更 のあらゆる並び（長さ 7 まで）を総当たり', () => {
    const ops = ['edit', 'export', 'undo', 'rename', 'resize'] as const;
    let checked = 0;
    const walk = (seq: number[]) => {
      if (seq.length > 0) {
        const s = session();
        seq.forEach((o, i) => {
          const op = ops[o];
          if (op === 'edit') s.edit(i);
          else if (op === 'export') s.exportPdf();
          else if (op === 'undo') s.undo();
          else if (op === 'rename') s.rename();
          else s.resize();
        });
        s.exportPdf();
        expect(s.conflicts(), seq.map((o) => ops[o]).join('→')).toEqual([]);
        checked += 1;
      }
      if (seq.length < 7) for (let o = 0; o < ops.length; o++) walk([...seq, o]);
    };
    walk([]);
    expect(checked).toBe(5 + 25 + 125 + 625 + 3125 + 15625 + 78125);
  });
});
