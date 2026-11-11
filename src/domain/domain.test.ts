import { describe, expect, it } from 'vitest';
import { buildImagePdf } from '../export/pdf';
import { AppData, Project } from '../types';
import { assignmentHours, countParts, estimate } from './calc';
import {
  addComposite, addPart, buildLabels, bumpIfIssued, emptyLayout, findOverlaps, layoutTitle, markIssued,
  moveItems, removeLastPart, ungroup,
} from './layout';
import { defaultComposites, defaultPartTypes, emptyData, newProject, sampleData } from './seed';
import { listDates } from './util';
import { checkNewAssignment, projectWarnings } from './warnings';

const parts = defaultPartTypes();
const table = parts.find((p) => p.id === 'pt-table')!;
const chair = parts.find((p) => p.id === 'pt-chair')!;

function fixture(): { data: AppData; p: Project } {
  const data: AppData = {
    ...emptyData(),
    staff: [
      { id: 's1', name: 'A', hourlyRate: 1200, transportPerDay: 800, memo: '' },
      { id: 's2', name: 'B', hourlyRate: 1000, transportPerDay: 0, memo: '' },
    ],
    contents: [{
      id: 'c1', name: 'フラワーボトル', price: 500, memo: '',
      materials: [{ id: 'm1', name: 'ボトル', unitCost: 120, qtyPerUnit: 1 }, { id: 'm2', name: '花材', unitCost: 30, qtyPerUnit: 5 }],
    }],
  };
  const p: Project = {
    ...newProject(),
    id: 'p1', name: 'テスト', startDate: '2026-12-05', endDate: '2026-12-06',
    fixedRevenue: 100000, venueFeeFixed: 10000, venueFeePerDay: 20000, venueFeeRatePct: 10,
    contents: [{ id: 'pc1', contentId: 'c1', plannedCount: 100, priceOverride: null, sparePct: 10 }],
    assignments: [
      { id: 'a1', staffId: 's1', date: '2026-12-05', startTime: '10:00', endTime: '18:00', breakMinutes: 60, rateOverride: null, transportOverride: null, memo: '' },
      { id: 'a2', staffId: 's2', date: '2026-12-06', startTime: '10:00', endTime: '15:30', breakMinutes: 0, rateOverride: 1500, transportOverride: 300, memo: '' },
    ],
    otherCosts: [{ id: 'o1', name: '印刷', amount: 5000 }],
  };
  data.projects = [p];
  return { data, p };
}

describe('試算', () => {
  it('期間の日数を両端含めて数える', () => {
    expect(listDates('2026-12-05', '2026-12-06')).toEqual(['2026-12-05', '2026-12-06']);
    expect(listDates('2026-12-06', '2026-12-05')).toEqual([]);
    expect(listDates('', '')).toEqual([]);
  });

  it('実働時間 = (終了 − 開始 − 休憩) / 60。逆転は 0', () => {
    const { p } = fixture();
    expect(assignmentHours(p.assignments[0])).toBe(7);
    expect(assignmentHours({ ...p.assignments[0], endTime: '09:00' })).toBe(0);
  });

  it('設計書の計算式どおりに収支を出す', () => {
    const { data, p } = fixture();
    const e = estimate(p, data);
    expect(e.days).toBe(2);
    // 人件費: 7h×1200+800 = 9200 / 5.5h×1500(上書き)+300(上書き) = 8550
    expect(e.laborCost).toBe(9200 + 8550);
    // 材料費: 100個 × 1.1 × (120 + 30×5 = 270) = 29700
    expect(e.materialCost).toBe(29700);
    // 売上: 100×500 + 100000
    expect(e.participationRevenue).toBe(50000);
    expect(e.revenue).toBe(150000);
    // 会場費: 10000 + 20000×2 + 50000×10%
    expect(e.venueFee).toBe(55000);
    expect(e.otherCost).toBe(5000);
    expect(e.totalCost).toBe(17750 + 29700 + 55000 + 0 + 5000);
    expect(e.profit).toBe(150000 - 107450);
    expect(e.marginPct).toBeCloseTo((42550 / 150000) * 100);
  });

  it('レイアウトのパーツ個数が備品費と席数に連動する', () => {
    const { data, p } = fixture();
    data.partTypes = data.partTypes.map((t) =>
      t.id === 'pt-table' ? { ...t, unitCost: 1000, costUnit: 'day' } : t.id === 'pt-chair' ? { ...t, unitCost: 200 } : t);
    let l = p.layout;
    l = addPart(l, table); l = addPart(l, table); l = addPart(l, chair); l = addPart(l, chair); l = addPart(l, chair);
    const e = estimate({ ...p, layout: l }, data);
    expect(countParts(l).get('pt-table')).toBe(2);
    // テーブル 2台×1000×2日 + 椅子 3脚×200
    expect(e.partsCost).toBe(4000 + 600);
    expect(e.seats).toBe(3);
    expect(estimate({ ...p, layout: removeLastPart(l, 'pt-chair') }, data).partsCost).toBe(4000 + 400);
  });

  it('売上 0 のとき利益率は null', () => {
    const { data, p } = fixture();
    expect(estimate({ ...p, fixedRevenue: 0, contents: [] }, data).marginPct).toBeNull();
  });
});

describe('レイアウト', () => {
  it('L字を置くと1グループになり、①-1 形式で番号が付く', () => {
    const comp = defaultComposites()[0];
    let l = addComposite(emptyLayout(), comp, parts);
    l = addComposite(l, comp, parts);
    l = addPart(l, parts.find((p) => p.id === 'pt-nego')!);
    const labels = buildLabels(l, parts);
    expect(l.items.slice(0, 3).map((i) => labels.items.get(i.id))).toEqual(['①-1', '①-2', '①-3']);
    expect(l.items.slice(3, 6).map((i) => labels.items.get(i.id))).toEqual(['②-1', '②-2', '②-3']);
    expect(labels.items.get(l.items[6].id)).toBe('商談席1');
    expect(labels.groups.map((g) => g.title)).toEqual(['L字①', 'L字②']);
    expect(labels.groups[0].subtitle).toBe('横2台＋縦1台');
  });

  it('グループは一緒に動き、解除すると個別に動く', () => {
    let l = addComposite(emptyLayout(), defaultComposites()[0], parts);
    const ids = l.items.map((i) => i.id);
    const before = l.items.map((i) => [i.x, i.y]);
    l = moveItems(l, ids, 100, 50, parts, 5);
    l.items.forEach((i, k) => expect([i.x - before[k][0], i.y - before[k][1]]).toEqual([100, 50]));
    l = ungroup(l, l.groups[0].id);
    expect(l.groups).toHaveLength(0);
    expect(l.items.every((i) => !i.groupId)).toBe(true);
    expect(buildLabels(l, parts).items.get(l.items[0].id)).toBe('T1');
  });

  it('図面の外には出ない', () => {
    let l = addPart(emptyLayout(500, 400), table);
    l = moveItems(l, [l.items[0].id], 9999, 9999, parts);
    expect(l.items[0].x).toBe(500 - 150);
    expect(l.items[0].y).toBe(400 - 60);
  });

  it('重なりを検出する（同一グループ内は対象外）', () => {
    let l = addComposite(emptyLayout(), defaultComposites()[0], parts);
    expect(findOverlaps(l, parts)).toHaveLength(0);
    l = addPart(l, table);
    l = { ...l, items: l.items.map((i, k) => (k === 3 ? { ...i, x: l.items[0].x + 20, y: l.items[0].y + 10 } : i)) };
    expect(findOverlaps(l, parts).length).toBeGreaterThan(0);
  });

  it('版数: 出力済みの版を編集すると自動で次の版になる', () => {
    let l = emptyLayout();
    expect(layoutTitle('ikyu', 'ラソラ札幌', l.version)).toBe('ikyu｜ラソラ札幌 イベント配置図 V1');
    expect(bumpIfIssued(l).version).toBe(1); // 未出力のうちは何度編集しても V1
    l = markIssued(l, '2026-11-11');
    l = bumpIfIssued(l);
    expect(l.version).toBe(2);
    expect(bumpIfIssued(l).version).toBe(2);
    expect(l.issued).toEqual([{ version: 1, issuedAt: '2026-11-11' }]);
  });
});

describe('警告（禁止せず知らせる）', () => {
  it('重複配置・期間外・休憩不足・保有数超過を警告する', () => {
    const { data, p } = fixture();
    data.partTypes = data.partTypes.map((t) => (t.id === 'pt-chair' ? { ...t, stockQty: 1 } : t));
    const q: Project = {
      ...p,
      layout: addPart(addPart(p.layout, chair), chair),
      assignments: [
        ...p.assignments,
        { ...p.assignments[0], id: 'a3', startTime: '12:00', endTime: '20:00', breakMinutes: 0 },
        { ...p.assignments[0], id: 'a4', date: '2026-12-20' },
      ],
    };
    const msgs = projectWarnings(q, { ...data, projects: [q] }).map((w) => w.message).join('\n');
    expect(msgs).toContain('重複して配置');
    expect(msgs).toContain('案件期間の外');
    expect(msgs).toContain('休憩が45分未満');
    expect(msgs).toContain('保有数 1 個を超えています');
  });

  it('別案件との掛け持ちを配置前に知らせる', () => {
    const { data, p } = fixture();
    const other: Project = { ...p, id: 'p2', name: '別案件' };
    const a = { ...p.assignments[0], id: 'new' };
    const ws = checkNewAssignment(a, { ...p, assignments: [] }, { ...data, projects: [p, other] });
    expect(ws.join()).toContain('別案件');
  });

  it('サンプルデータは重なり警告なしで読み込める', () => {
    const d = sampleData();
    const ws = projectWarnings(d.projects[0], d).filter((w) => w.severity === 'warn');
    expect(ws.map((w) => w.message)).toEqual([]);
  });
});

describe('PDF', () => {
  it('JPEG を包んだ PDF の xref オフセットが正しい', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = buildImagePdf(jpeg, 300, 200, 841.89, 595.28);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offs = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
  });
});
