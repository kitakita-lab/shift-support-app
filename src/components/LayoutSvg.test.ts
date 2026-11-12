// 配置図（画面表示と PDF 出力で共通の SVG）に、出力に必要なものが入っていることの確認。
// PDF はこの SVG を画像にしたものなので、ここに描かれていれば PDF にも入る（実際の PDF は e2e/verify.mjs で確認）。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { addComposite, addPart, emptyLayout, layoutTitle, updateItem } from '../domain/layout';
import { defaultComposites, defaultPartTypes, sampleData } from '../domain/seed';
import { Layout } from '../types';
import LayoutSvg from './LayoutSvg';

const parts = defaultPartTypes();
const render = (layout: Layout, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(LayoutSvg, { layout, partTypes: parts, title: 'タイトル', ...props }));
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
    const svg = render(l, { title: layoutTitle('ikyu', 'ラソラ札幌', l.version) });
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
    for (const t of ['L字①', '横2台＋縦1台', '①-1', '受付', '①-3', '商談席1']) expect(svg).toContain(`>${t}<`);
    expect(svg).not.toContain('>①-2<');
  });
  it('選択枠・補助グリッドは「出力しない」印（data-noexport）つきで描かれる', () => {
    const l = addPart(emptyLayout(), parts.find((p) => p.id === 'pt-table')!);
    const plain = render(l);
    expect(plain).not.toContain('data-noexport');
    const editing = render(l, { selectedItemIds: [l.items[0].id], gridCm: 50 });
    expect(editing.match(/data-noexport/g)!.length).toBe(2);       // 選択枠 1 ＋ グリッド 1
  });
  it('サンプルの配置図が丸ごと描ける（全パーツ・全周辺環境）', () => {
    for (const p of sampleData().projects) {
      const svg = render(p.layout, { title: layoutTitle(p.name, 'ラソラ札幌', p.layout.version) });
      expect(svg.match(/<rect/g)!.length).toBeGreaterThan(p.layout.items.length + p.layout.env.length);
      expect(svg).toContain('未確認事項（要確認）');
      expect(svg).not.toContain('NaN');
    }
  });
});
