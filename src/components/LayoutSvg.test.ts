// 配置図（画面表示と PDF 出力で共通の SVG）に、出力に必要なものが入っていることの確認。
// PDF はこの SVG を画像にしたものなので、ここに描かれていれば PDF にも入る（実際の PDF は e2e/verify.mjs で確認）。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FigureContext, figureModel, fingerprint } from '../domain/figure';
import { addComposite, addPart, emptyLayout, layoutTitle, updateItem } from '../domain/layout';
import { defaultComposites, defaultPartTypes, sampleData } from '../domain/seed';
import { Layout, PartType } from '../types';
import LayoutSvg from './LayoutSvg';

const parts = defaultPartTypes();
const CTX: FigureContext = { mode: 'project', projectName: 'タイトル', venueName: '', startDate: '', endDate: '' };
/** 画面と同じ手順（レイアウト → 図のモデル → 描画）で SVG の文字列にする */
const render = (layout: Layout, props: Record<string, unknown> = {}, ctx: Partial<FigureContext> = {}, partTypes = parts) =>
  renderToStaticMarkup(createElement(LayoutSvg, { model: figureModel(layout, partTypes, { ...CTX, ...ctx }), ...props }));
const viewBox = (svg: string) => /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg)!.slice(1).map(Number);
/** <text …>文字</text> の y 座標 */
const yOf = (svg: string, text: string) => Number(new RegExp(`<text[^>]* y="(-?[\\d.]+)"[^>]*>${text}</text>`).exec(svg)?.[1]);

describe('未確認事項欄', () => {
  const notes = '実寸（ブース・通路幅）\n防災条件（避難経路・消火設備）\n電源の位置';

  it('未確認事項を入力すると、見出しと全項目が図に入る', () => {
    const svg = render({ ...emptyLayout(), notes });
    expect(svg).toContain('未確認事項（要確認）');
    for (const line of notes.split('\n')) expect(svg).toContain(`>・${line}</text>`);
  });
  it('欄は図面の下に足され、その分だけ図全体が縦に伸びる（図面に重ならない・はみ出して切れない）', () => {
    const l = { ...emptyLayout(1440, 1150), notes };
    const [, top, , height] = viewBox(render(l));
    const bottom = top + height;
    const [, , , heightEmpty] = viewBox(render({ ...l, notes: '' }));
    expect(height).toBe(heightEmpty - 30 + 50 + 3 * 24);          // 項目数に応じて伸びる
    const ys = notes.split('\n').map((line) => yOf(render(l), `・${line}`));
    expect(ys).toHaveLength(3);
    for (const y of [yOf(render(l), '未確認事項（要確認）'), ...ys]) {
      expect(y).toBeGreaterThan(1150);                             // 図面（0〜1150）より下
      expect(y + 6).toBeLessThan(bottom);                          // 図の下端より上（文字の下側ぶんの余裕込み）
    }
  });
  it('項目が増えても全部入る（20 項目）', () => {
    const many = Array.from({ length: 20 }, (_, i) => `確認事項その${i + 1}`).join('\n');
    const svg = render({ ...emptyLayout(), notes: many });
    const [, top, , height] = viewBox(svg);
    for (let i = 1; i <= 20; i++) expect(yOf(svg, `・確認事項その${i}`) + 6).toBeLessThan(top + height);
  });
  it('空・空白だけなら欄そのものを出さない', () => {
    for (const empty of ['', '  \n \n']) {
      expect(render({ ...emptyLayout(), notes: empty })).not.toContain('未確認事項');
    }
  });
  it('空行は項目として数えない', () => {
    const svg = render({ ...emptyLayout(), notes: '\n電源の位置\n\n' });
    expect(svg.match(/>・/g)).toHaveLength(1);
  });
  it('記号（< > &）を含んでいても壊れない', () => {
    const svg = render({ ...emptyLayout(), notes: '通路幅 < 120cm の箇所 & 段差' });
    expect(svg).toContain('・通路幅 &lt; 120cm の箇所 &amp; 段差');
  });
});

describe('タイトル・版数・注記・作成日', () => {
  it('タイトル（案件名｜会場名 イベント配置図 V版数）と注記が入る', () => {
    const l = { ...emptyLayout(), version: 3, caption: '配置確認用・縮尺なし' };
    const svg = render(l, { version: l.version }, { projectName: 'ikyu', venueName: 'ラソラ札幌' });
    expect(svg).toContain(`>${layoutTitle('ikyu', 'ラソラ札幌', 3)}</text>`);
    expect(svg).toContain('>ikyu｜ラソラ札幌 イベント配置図 V3</text>');
    expect(svg).toContain('>配置確認用・縮尺なし</text>');
  });
  it('作成日などのスタンプは渡したときだけ入る', () => {
    expect(render(emptyLayout(), { stamp: '作成日 2026-11-13' })).toContain('>作成日 2026-11-13</text>');
    expect(render(emptyLayout())).not.toContain('作成日');
  });
  it('タイトル帯（上 100）は図面の外に確保される', () => {
    const [x, y, w] = viewBox(render(emptyLayout(1440, 1150)));
    expect([x, y, w]).toEqual([0, -100, 1440]);
  });
});

describe('パーツと番号', () => {
  it('L字のグループ名・テーブル番号・手動の表示名がそのまま図に入る', () => {
    let l = addComposite(emptyLayout(), defaultComposites()[0], parts);
    l = addPart(l, parts.find((p) => p.id === 'pt-nego')!);
    l = updateItem(l, l.items[1].id, { label: '受付' });
    const svg = render(l);
    for (const t of ['L字①', '横2台＋縦1台', '①-1', '受付', '①-2', '商談席1']) expect(svg).toContain(`>${t}<`);
    expect(svg).not.toContain('>①-3<');                             // 上書きした台は連番を使わない（D-18）
  });
  it('選択枠・補助グリッドは「出力しない」印（data-noexport）つきで描かれる', () => {
    const l = addPart(emptyLayout(), parts.find((p) => p.id === 'pt-table')!);
    const plain = render(l);
    expect(plain).not.toContain('data-noexport');
    const editing = render(l, { selectedItemIds: [l.items[0].id], gridCm: 50 });
    expect(editing.match(/data-noexport/g)!.length).toBe(2);       // 選択枠 1 ＋ グリッド 1
  });
  it('サンプルの配置図が丸ごと描ける（全パーツ・全周辺環境）', () => {
    const d = sampleData();
    for (const p of d.projects) {
      const svg = render(p.layout, { version: p.layout.version }, { projectName: p.name, venueName: 'ラソラ札幌', startDate: p.startDate, endDate: p.endDate }, d.partTypes);
      expect(svg.match(/<rect/g)!.length).toBeGreaterThan(p.layout.items.length + p.layout.env.length);
      expect(svg).toContain('未確認事項（要確認）');
      expect(svg).not.toContain('NaN');
    }
  });
});

describe('会期（作業ログ D-22）', () => {
  it('会期が入力されていれば、タイトルの下に 1 行入る。その分だけタイトル帯が広がり、注記は会期の下に下がる', () => {
    const l = { ...emptyLayout(1440, 1150), caption: '配置確認用' };
    const svg = render(l, {}, { startDate: '2026-11-13', endDate: '2026-11-17' });
    expect(svg).toContain('>会期 2026/11/13(金)〜11/17(火)</text>');
    const [, top] = viewBox(svg);
    expect(top).toBe(-128);
    const title = yOf(svg, 'タイトル イベント配置図 V1'), period = yOf(svg, '会期 2026/11/13\\(金\\)〜11/17\\(火\\)'), caption = yOf(svg, '配置確認用');
    expect(title).toBeLessThan(period);
    expect(period).toBeLessThan(caption);
    expect(caption).toBeLessThan(0);                                // 図面（0〜）より上に収まる
  });
  it('会期が未入力・不正なら行を出さず、タイトル帯は 100 のまま（Version 2 までと同じ見た目）', () => {
    for (const ctx of [{}, { startDate: '2026-11-13' }, { startDate: '2026-11-18', endDate: '2026-11-17' }]) {
      const svg = render(emptyLayout(), {}, ctx);
      expect(svg).not.toContain('会期');
      expect(viewBox(svg)[1]).toBe(-100);
    }
  });
  it('雛形（会場マスタ）には会期を出さない', () => {
    const svg = render(emptyLayout(), {}, { mode: 'template', venueName: 'ラソラ札幌', startDate: '2026-11-13', endDate: '2026-11-17' });
    expect(svg).toContain('>ラソラ札幌 雛形</text>');
    expect(svg).not.toContain('会期');
  });
});

describe('椅子の役割と色（作業ログ D-16）', () => {
  it('制作席（青）と、その他の椅子（灰色）は色が違う', () => {
    const fillOf = (id: string) => /<rect[^>]* fill="(#[0-9a-f]+)"[^>]* stroke-width="1.8"/.exec(render(addPart(emptyLayout(), parts.find((p) => p.id === id)!)))![1];
    expect(fillOf('pt-chair')).toBe('#b9d3ec');
    expect(fillOf('pt-chair-other')).toBe('#e6e6e6');
  });
});

// ── 指紋と図の突き合わせ（作業ログ D-21） ──
// 版は「図の内容の指紋」で決める。その前提「図が変われば指紋も変わる／図が同じなら指紋も同じ」を、
// 実際に描いた図（SVG の文字列）と突き合わせて確かめる。版番号と作成日は指紋の対象外なので、同じ値を渡して比べる。
describe('指紋と図の突き合わせ', () => {
  interface Scene { layout: Layout; parts: PartType[]; ctx: FigureContext }
  const data = sampleData();
  const lasora = data.projects[1];
  const base: Scene = {
    layout: lasora.layout, parts: data.partTypes,
    ctx: { mode: 'project', projectName: lasora.name, venueName: 'ラソラ札幌', startDate: lasora.startDate, endDate: lasora.endDate },
  };
  const draw = (s: Scene) => renderToStaticMarkup(createElement(LayoutSvg, { model: figureModel(s.layout, s.parts, s.ctx), version: 1, stamp: '作成日 2026-11-13' }));
  const fp = (s: Scene) => JSON.stringify(fingerprint(figureModel(s.layout, s.parts, s.ctx)));
  const L = (fn: (l: Layout) => Layout) => (s: Scene): Scene => ({ ...s, layout: fn(s.layout) });
  const P = (id: string, patch: Partial<PartType>) => (s: Scene): Scene => ({ ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const C = (patch: Partial<FigureContext>) => (s: Scene): Scene => ({ ...s, ctx: { ...s.ctx, ...patch } });
  const env = (kind: string, patch: Record<string, unknown>) => L((l) => {
    const i = l.env.findIndex((e) => e.kind === kind);
    return { ...l, env: l.env.map((e, k) => (k === i ? { ...e, ...patch } : e)) };
  });
  const itemOf = (id: string, patch: Record<string, unknown>) => L((l) => {
    const i = l.items.findIndex((x) => x.partTypeId === id);
    return { ...l, items: l.items.map((x, k) => (k === i ? { ...x, ...patch } : x)) };
  });

  /** 図が変わる変更 */
  const drawn: [string, (s: Scene) => Scene][] = [
    ['案件名', C({ projectName: 'ikyu 秋' })],
    ['会場名', C({ venueName: 'ラソラ札幌 1F' })],
    ['会期（開始日）', C({ startDate: '2026-11-12' })],
    ['会期（終了日）', C({ endDate: '2026-11-18' })],
    ['会期を消す', C({ endDate: '' })],
    ['タイトル下の注記', L((l) => ({ ...l, caption: '別の注記' }))],
    ['未確認事項を 1 行足す', L((l) => ({ ...l, notes: `${l.notes}\n搬入口` }))],
    ['未確認事項の文言', L((l) => ({ ...l, notes: l.notes.replace('電源', 'コンセント') }))],
    ['図面の幅', L((l) => ({ ...l, width: l.width + 100 }))],
    ['図面の高さ', L((l) => ({ ...l, height: l.height + 100 }))],
    ['周辺環境: 位置', env('shop', { x: 5 })],
    ['周辺環境: 大きさ', env('booth', { w: 700 })],
    ['周辺環境: 表示名', env('shop', { label: '別の店' })],
    ['周辺環境: 店舗の補足', env('shop', { sublabel: '補足を変更' })],
    ['周辺環境: 店舗の色', env('shop', { tone: 'green' })],
    ['周辺環境: 入口の矢印の向き', env('entrance', { dir: 'up' })],
    ['周辺環境: 壁の色（橙）', env('wall', { tone: 'orange' })],
    ['周辺環境: 文字の色', env('text', { tone: 'purple' })],
    ['周辺環境: 1 つ削除', L((l) => ({ ...l, env: l.env.slice(1) }))],
    ['周辺環境: 重なり順の入れ替え', L((l) => ({ ...l, env: [l.env[1], l.env[0], ...l.env.slice(2)] }))],
    ['パーツ: 移動', itemOf('pt-table', { x: 333 })],
    ['パーツ: 回転', itemOf('pt-nego', { rot: 90 })],
    ['パーツ: 表示名の上書き', itemOf('pt-table', { label: '受付' })],
    ['パーツ: 追加', L((l) => addPart(l, data.partTypes.find((p) => p.id === 'pt-chair')!))],
    ['パーツ: 削除', L((l) => ({ ...l, items: l.items.slice(0, -1) }))],
    ['パーツ: 重なり順の入れ替え', L((l) => ({ ...l, items: [...l.items.slice(1), l.items[0]] }))],
    ['パーツ: 椅子を「その他」の種別に変える', itemOf('pt-chair', { partTypeId: 'pt-chair-other' })],
    ['グループ名', L((l) => ({ ...l, groups: l.groups.map((g, i) => (i === 0 ? { ...g, name: 'コの字' } : g)) }))],
    ['グループ解除', L((l) => ({ ...l, groups: l.groups.slice(1), items: l.items.map((i) => (i.groupId === l.groups[0].id ? { ...i, groupId: undefined } : i)) }))],
    ['マスタ: 使っているパーツの幅', P('pt-table', { widthCm: 180 })],
    ['マスタ: 使っているパーツの奥行', P('pt-chair', { depthCm: 50 })],
    ['マスタ: 図面上の表示名', P('pt-nego', { shortName: '相談席' })],
    ['マスタ: 番号を付ける／付けない', P('pt-table', { numbered: false })],
    ['マスタ: 区分（色・形が変わる）', P('pt-work', { category: 'display' })],
    ['マスタ: 椅子の役割（色が変わる）', P('pt-chair', { seatRole: 'other' })],
    ['マスタ: 使っているパーツの種別を削除（破線になる）', (s) => ({ ...s, parts: s.parts.filter((p) => p.id !== 'pt-banner') })],
  ];
  /** 図が変わらない変更 */
  const notDrawn: [string, (s: Scene) => Scene][] = [
    ['マスタ: 単価・単価の単位・保有数', (s) => ({ ...s, parts: s.parts.map((p) => ({ ...p, unitCost: p.unitCost + 123, costUnit: 'event' as const, stockQty: 7 })) })],
    ['マスタ: パーツ名（図には表示名だけが出る）', P('pt-table', { name: '長机' })],
    ['マスタ: 配置していないパーツの寸法', (s) => ({ ...s, parts: [...s.parts, { ...s.parts[0], id: 'pt-unused', widthCm: 999 }] })],
    ['マスタ: 椅子以外に椅子の役割が付いている', P('pt-table', { seatRole: 'other' })],
    ['マスタ: 椅子の役割 未設定 → 制作席（同じ意味）', (s) => ({ ...s, parts: s.parts.map((p) => (p.id === 'pt-chair' ? { ...p, seatRole: undefined } : p)) })],
    ['マスタ: 番号なしのパーツの「番号」以外は同じ', P('pt-chair', { stockQty: 99 })],
    ['版番号・出力の記録（指紋の対象外）', L((l) => ({ ...l, version: 7, issued: [{ version: 3, issuedAt: '2026-01-01' }] }))],
    ['内部の ID の振り直し', L((l) => {
      const g = new Map(l.groups.map((x, i) => [x.id, `g${i}`]));
      return { ...l, env: l.env.map((e, i) => ({ ...e, id: `e${i}` })), groups: l.groups.map((x) => ({ ...x, id: g.get(x.id)! })), items: l.items.map((x, i) => ({ ...x, id: `i${i}`, groupId: x.groupId ? g.get(x.groupId) : undefined })) };
    })],
    ['未確認事項の空行・行末の空白', L((l) => ({ ...l, notes: `\n${l.notes.split('\n').join('  \n\n')}\n  ` }))],
    ['周辺環境: 通路に補足・矢印・色（通路では描かない項目）', env('passage', { sublabel: '使わない', dir: 'up', tone: 'green' })],
    ['周辺環境: 会場区画の色（描かない項目）', env('booth', { tone: 'purple', sublabel: 'x' })],
    ['周辺環境: 階段の色・矢印（描かない項目）', env('stairs', { tone: 'orange', dir: 'down' })],
    ['周辺環境: 店舗の矢印（描かない項目）', env('shop', { dir: 'right' })],
    ['周辺環境: 入口の色・補足（描かない項目）', env('entrance', { tone: 'purple', sublabel: 'x' })],
    ['周辺環境: 壁の色が橙以外どうし（同じ色で描く）', env('wall', { tone: 'green' })],
    ['会期が出ていないときの開始日だけの変更', (s) => C({ startDate: '2026-01-01' })(C({ endDate: '' })(s))],
  ];

  it('図が変わる変更では、図も指紋も必ず変わる', () => {
    const svg0 = draw(base), fp0 = fp(base);
    for (const [name, change] of drawn) {
      const s = change(base);
      expect(draw(s) !== svg0, `「${name}」で図が変わること（テストの前提）`).toBe(true);
      expect(fp(s) !== fp0, `「${name}」で指紋が変わること`).toBe(true);
    }
  });
  it('図が変わらない変更では、図も指紋も変わらない（不要に版が上がらない）', () => {
    const svg0 = draw(base), fp0 = fp(base);
    // 「会期が出ていないとき」の比較相手は、会期を消した状態
    const noPeriod = C({ endDate: '' })(base);
    for (const [name, change] of notDrawn) {
      const ref = name.startsWith('会期が出ていない') ? noPeriod : base;
      const s = change(base);
      expect(draw(s) === (ref === base ? svg0 : draw(ref)), `「${name}」で図が変わらないこと（テストの前提）`).toBe(true);
      expect(fp(s) === (ref === base ? fp0 : fp(ref)), `「${name}」で指紋が変わらないこと`).toBe(true);
    }
  });
  it('POP の表示名は、改行を入れても 1 行で描かれる。改行の有無だけでは、図も指紋も変わらない', () => {
    // 独立レビューの指摘: 図は同じなのに指紋だけが変わり、不要に版が上がる組み合わせがあった
    const one = itemOf('pt-pop-l', { label: '秋の新作 入荷' })(base), two = itemOf('pt-pop-l', { label: '秋の新作\n入荷' })(base);
    expect(draw(two)).toBe(draw(one));
    expect(fp(two)).toBe(fp(one));
    expect(fp(one)).not.toBe(fp(base));
  });
  it('2 つの変更を重ねても、「図が同じ ⇔ 指紋が同じ」が崩れない（全組み合わせ）', () => {
    const all = [...drawn, ...notDrawn];
    const seen = new Map<string, string>();                       // 指紋 → 図
    const bySvg = new Map<string, string>();                      // 図 → 指紋
    let n = 0;
    for (const [, a] of all) {
      for (const [, b] of all) {
        const s = b(a(base));
        const svg = draw(s), f = fp(s);
        if (seen.has(f)) expect(seen.get(f) === svg, '指紋が同じなのに図が違う').toBe(true); else seen.set(f, svg);
        if (bySvg.has(svg)) expect(bySvg.get(svg) === f, '図が同じなのに指紋が違う').toBe(true); else bySvg.set(svg, f);
        n += 1;
      }
    }
    expect(n).toBe(all.length * all.length);
  }, 120000);
});
