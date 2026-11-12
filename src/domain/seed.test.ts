// サンプルデータの確認。とくに「ラソラ札幌 11/13〜17・フラワーボトル（ikyu）」の土台が、
// 読み込んだ直後から配置と試算の検証に使える状態であること。
// ここにある金額は docs/作業ログ.md の「読み込み直後の期待値」「検証シナリオ」と同じ値。
import { describe, expect, it } from 'vitest';
import { AppData, Project } from '../types';
import { countParts, estimate } from './calc';
import { addComposite, addPart, bbox, buildLabels, findOverlaps, isIssued, itemSize, layoutTitle, removeLastPart } from './layout';
import { defaultPartTypes, emptyData, sampleData } from './seed';
import { listDates } from './util';
import { projectWarnings } from './warnings';

const data = sampleData();
const [demo, lasora] = data.projects;
const venueName = (p: Project) => data.venues.find((v) => v.id === p.venueId)?.name;
const contentNames = (p: Project) => p.contents.map((pc) => data.contents.find((c) => c.id === pc.contentId)?.name);
const summary = (p: Project, d: AppData = data) => {
  const e = estimate(p, d);
  return {
    days: e.days, revenue: e.revenue, laborCost: e.laborCost, materialCost: e.materialCost, venueFee: e.venueFee,
    partsCost: e.partsCost, otherCost: e.otherCost, totalCost: e.totalCost, profit: e.profit, seats: e.seats, totalHours: e.totalHours,
  };
};

describe('サンプルデータ全体', () => {
  it('案件は 2 件：デモ（12/5〜6）と、ラソラ札幌 11/13〜17 の土台', () => {
    expect(data.projects.map((p) => [p.name, venueName(p), p.startDate, p.endDate, contentNames(p)])).toEqual([
      ['ikyu（デモ）', 'ラソラ札幌', '2026-12-05', '2026-12-06', ['フラワーボトル']],
      ['ikyu', 'ラソラ札幌', '2026-11-13', '2026-11-17', ['フラワーボトル']],
    ]);
  });
  it('2 つの案件は図のタイトル（＝PDF のファイル名）が重ならない', () => {
    const titles = data.projects.map((p) => layoutTitle(p.name, venueName(p) ?? '', p.layout.version));
    expect(titles).toEqual(['ikyu（デモ）｜ラソラ札幌 イベント配置図 V1', 'ikyu｜ラソラ札幌 イベント配置図 V1']);
    expect(new Set(titles).size).toBe(titles.length);
  });
  it('どちらの案件も、読み込んだ直後は警告・参考とも 0 件（検証で出た警告はすべて自分の操作が原因だと分かる）', () => {
    for (const p of data.projects) expect(projectWarnings(p, data)).toEqual([]);
  });
  it('id はすべて一意で、読み込むたびに新しく振られる', () => {
    const ids = (d: AppData) => [
      ...d.staff, ...d.venues, ...d.contents, ...d.contents.flatMap((c) => c.materials), ...d.projects,
      ...d.projects.flatMap((p) => [...p.contents, ...p.assignments, ...p.otherCosts, ...p.layout.items, ...p.layout.env, ...p.layout.groups]),
      ...d.venues.flatMap((v) => v.template.env),
    ].map((x) => x.id);
    const first = ids(data);
    expect(new Set(first).size).toBe(first.length);
    const second = new Set(ids(sampleData()));
    expect(first.some((id) => second.has(id))).toBe(false);
  });
  it('JSON にして戻しても同じ内容（バックアップ・保存で欠けるものがない）', () => {
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
  it('金額・人名が仮のものだと分かるようになっている', () => {
    expect(data.staff.every((s) => s.name.includes('サンプル') && s.memo.includes('仮置き'))).toBe(true);
    expect(data.contents[0].memo).toContain('仮置き');
    expect(data.venues[0].memo).toContain('仮置き');
  });
  it('初期マスタ（サンプルを読み込まない場合）のパーツ単価は 0 のまま。仮の単価が入るのはサンプルだけ', () => {
    expect(emptyData().partTypes.every((t) => t.unitCost === 0 && t.stockQty === 0)).toBe(true);
    expect(defaultPartTypes().every((t) => t.unitCost === 0)).toBe(true);
    expect(data.partTypes.filter((t) => t.unitCost > 0).map((t) => [t.name, t.unitCost, t.costUnit])).toEqual([
      ['テーブル 150×60', 500, 'day'],
      ['椅子（制作席）', 100, 'day'],
      ['椅子（その他）', 100, 'day'],
      ['登録スペース（パーテーション区画）', 3000, 'event'],
    ]);
    expect(data.partTypes.every((t) => t.stockQty === 0)).toBe(true);   // 保有数は入れない（仮の数字で警告を出さない）
  });
});

describe('ラソラ札幌 2026-11-13〜17・フラワーボトル（ikyu）の土台', () => {
  it('会期は 11/13(金)〜11/17(火) の 5 日間。状態は「計画中」', () => {
    expect(listDates(lasora.startDate, lasora.endDate)).toEqual(['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']);
    expect(lasora.status).toBe('計画中');
    expect([lasora.openTime, lasora.closeTime]).toEqual(['10:00', '18:00']);
  });
  it('数値が仮置きだと案件の中でも分かる（メモ・費目名・未確認事項）', () => {
    expect(lasora.memo).toContain('【仮置き】');
    expect(lasora.otherCosts.every((o) => o.name.includes('仮'))).toBe(true);
    expect(lasora.layout.notes.split('\n')[0]).toContain('仮置き');
  });
  it('スタッフ配置：5 日間とも 2 人ずつ（10:00〜18:00・休憩 60 分）。A 4 日、B 3 日、C 3 日', () => {
    const name = (id: string) => data.staff.find((s) => s.id === id)!.name[4];
    const byDay = listDates(lasora.startDate, lasora.endDate).map((d) => lasora.assignments.filter((a) => a.date === d).map((a) => name(a.staffId)).join(''));
    expect(byDay).toEqual(['AB', 'AC', 'BC', 'AB', 'AC']);
    expect(lasora.assignments.every((a) => a.startTime === '10:00' && a.endTime === '18:00' && a.breakMinutes === 60 && a.rateOverride === null && a.transportOverride === null)).toBe(true);
  });
  it('配置図：L字 2 組（テーブル 6 台）・椅子 22 脚（制作席 16 ＋ その他 6）ほか。全パーツが図面の中にあり、重なりなし・未出力の V1', () => {
    const counts = Object.fromEntries(countParts(lasora.layout));
    expect(counts).toEqual({
      'pt-table': 6, 'pt-chair': 16, 'pt-chair-other': 6, 'pt-nego': 3, 'pt-reg': 1, 'pt-work': 1, 'pt-banner': 3, 'pt-pop-l': 2, 'pt-pop-s': 2, 'pt-display': 1, 'pt-eye': 1,
    });
    const labels = buildLabels(lasora.layout, data.partTypes);
    expect(labels.groups.map((g) => g.title)).toEqual(['L字①', 'L字②']);
    expect(lasora.layout.items.filter((i) => i.groupId).map((i) => labels.items.get(i.id))).toEqual(['①-1', '①-2', '①-3', '②-1', '②-2', '②-3']);
    expect(findOverlaps(lasora.layout, data.partTypes)).toEqual([]);
    const bb = bbox(lasora.layout.items, data.partTypes);
    expect(bb.x >= 0 && bb.y >= 0 && bb.x + bb.w <= lasora.layout.width && bb.y + bb.h <= lasora.layout.height).toBe(true);
    // 全パーツが会場区画（ブース）の中に収まっている
    const booth = lasora.layout.env.find((e) => e.kind === 'booth')!;
    for (const it of lasora.layout.items) {
      const s = itemSize(it, data.partTypes.find((t) => t.id === it.partTypeId));
      expect(it.x >= booth.x && it.y >= booth.y && it.x + s.w <= booth.x + booth.w && it.y + s.h <= booth.y + booth.h, `${it.partTypeId} @${it.x},${it.y}`).toBe(true);
    }
    expect([lasora.layout.version, isIssued(lasora.layout), lasora.layout.issued]).toEqual([1, false, []]);
    expect(lasora.layout.env.length).toBe(data.venues[0].template.env.length);
  });

  it('読み込み直後の試算（手計算と一致）', () => {
    // 売上   : 参加費 0 円 × 300 個 ＋ 固定 400,000                         ＝ 400,000
    // 人件費 : A 4日×(7h×1,200＋800) ＋ B 3日×(7h×1,100＋600) ＋ C 3日×(7h×1,100＋0)
    //          ＝ 36,800 ＋ 24,900 ＋ 23,100                                 ＝  84,800
    // 材料費 : 300 個 × 1.1 ×（120 ＋ 30×5 ＋ 25 ＝ 295）                    ＝  97,350
    // 会場費 : 0 ＋ 20,000 × 5 日 ＋ 0%                                      ＝ 100,000
    // 備品費 : テーブル 6×500×5 ＋ 椅子（制作席 16 ＋ その他 6）×100×5 ＋ 登録スペース 1×3,000 ＝ 29,000
    // その他 : 12,000 ＋ 10,000                                              ＝  22,000
    // 席数   : 制作席 16（Version 2 までは椅子の総数 22 を席数としていた。金額は変わらない）
    expect(summary(lasora)).toEqual({
      days: 5, revenue: 400000, laborCost: 84800, materialCost: 97350, venueFee: 100000,
      partsCost: 29000, otherCost: 22000, totalCost: 333150, profit: 66850, seats: 16, totalHours: 70,
    });
    expect(estimate(lasora, data).marginPct).toBeCloseTo(16.7125, 4);
  });
  it('席数と回転数（D-16）: 制作席 16・その他の椅子 6。必要な回転数は 300 ÷（16 席 × 5 日）＝ 3.75 回。上限回転数 4（仮）では席は足りる', () => {
    const e = estimate(lasora, data);
    expect([e.seats, e.otherSeats, e.requiredTurns]).toEqual([16, 6, 3.75]);
    expect(lasora.contents.map((c) => c.maxTurns)).toEqual([4]);
    expect(projectWarnings(lasora, data)).toEqual([]);            // 必要 75 席・日 ≦ 80 席・日
  });

  describe('検証シナリオ（画面で同じ操作をしたときの期待値）', () => {
    const chair = data.partTypes.find((t) => t.id === 'pt-chair')!;
    const base = summary(lasora);
    const after = (p: Project, d: AppData = data) => summary(p, d);

    it('1. 椅子（制作席）を 1 脚増やす → 備品費 +500（100 円 × 5 日）、制作席 17、利益 −500', () => {
      const p = { ...lasora, layout: addPart(lasora.layout, chair) };
      const e = after(p);
      expect([e.partsCost, e.seats, e.profit]).toEqual([29500, 17, 66350]);
      expect(projectWarnings(p, data)).toEqual([]);   // 追加した椅子は空いている場所に出るので警告なし
    });
    it('2. 椅子（制作席）を 1 脚減らす → 備品費 −500、制作席 15。必要 75 席・日 ＝ 15 席 × 5 日なので、ちょうど足りる（警告なし）', () => {
      const p = { ...lasora, layout: removeLastPart(lasora.layout, 'pt-chair') };
      const e = after(p);
      expect([e.partsCost, e.seats, e.profit]).toEqual([28500, 15, 67350]);
      expect(projectWarnings(p, data)).toEqual([]);
    });
    it('2b. さらに 1 脚減らして制作席 14 → 席が足りない警告（必要 75 席・日 ＞ 14 席 × 5 日 ＝ 70 席・日）', () => {
      const layout = removeLastPart(removeLastPart(lasora.layout, 'pt-chair'), 'pt-chair');
      expect(projectWarnings({ ...lasora, layout }, data).map((w) => [w.target, w.severity])).toEqual([['layout:seats', 'warn']]);
    });
    it('2c. 椅子（その他）を増減しても、制作席・必要な回転数は変わらず、備品費だけ動く', () => {
      const other = data.partTypes.find((t) => t.id === 'pt-chair-other')!;
      const e = estimate({ ...lasora, layout: addPart(lasora.layout, other) }, data);
      expect([e.seats, e.otherSeats, e.requiredTurns, e.partsCost]).toEqual([16, 7, 3.75, 29500]);
    });
    it('3. 組み合わせ配置「L字」を 1 つ追加 → テーブル 9 台、備品費 +7,500（3 台 × 500 円 × 5 日）、番号は ③-1〜③-3', () => {
      const layout = addComposite(lasora.layout, data.composites[0], data.partTypes);
      const e = after({ ...lasora, layout });
      expect([countParts(layout).get('pt-table'), e.partsCost, e.profit]).toEqual([9, 36500, 59350]);
      expect(layout.items.slice(-3).map((i) => buildLabels(layout, data.partTypes).items.get(i.id))).toEqual(['③-1', '③-2', '③-3']);
      // 追加した L字は会場区画の左上付近に出て既存のパーツに重なるので、動かすまで重なり警告が 1 件出る
      expect(projectWarnings({ ...lasora, layout }, data).map((w) => w.target)).toEqual(['layout:overlap']);
    });
    it('4. 予定個数を 300 → 400 → 材料費 129,800（+32,450）、売上は変わらない（参加無料のため）', () => {
      const e = after({ ...lasora, contents: [{ ...lasora.contents[0], plannedCount: 400 }] });
      expect([e.materialCost, e.revenue, e.profit]).toEqual([129800, 400000, 34400]);
    });
    it('5. 参加費/個に 500 を入れる → 参加費売上 150,000、売上 計 550,000、利益 216,850', () => {
      const p = { ...lasora, contents: [{ ...lasora.contents[0], priceOverride: 500 }] };
      expect(estimate(p, data).participationRevenue).toBe(150000);
      expect([after(p).revenue, after(p).profit]).toEqual([550000, 216850]);
    });
    it('6. さらに会場費の歩合を 10% にする → 会場費 115,000（100,000 ＋ 150,000×10%）、利益 201,850', () => {
      const p = { ...lasora, venueFeeRatePct: 10, contents: [{ ...lasora.contents[0], priceOverride: 500 }] };
      expect([after(p).venueFee, after(p).profit]).toEqual([115000, 201850]);
    });
    it('7. 会場費の固定額に 30,000 を入れる → 会場費 130,000、利益 36,850', () => {
      const e = after({ ...lasora, venueFeeFixed: 30000 });
      expect([e.venueFee, e.profit]).toEqual([130000, 36850]);
    });
    it('8. 終了日を 11/18 に延ばす → 6 日間。会場費 120,000、備品費 34,200（日額分が 6 日）。11/18 は誰もいない日として「参考」が 1 件', () => {
      const p = { ...lasora, endDate: '2026-11-18' };
      const e = after(p);
      expect([e.days, e.venueFee, e.partsCost, e.profit]).toEqual([6, 120000, 34200, 41650]);
      expect(projectWarnings(p, data)).toEqual([{ severity: 'info', target: 'day:2026-11-18', message: '11/18(水): スタッフが1人も配置されていません。' }]);
    });
    it('9. 11/13 のスタッフA を外す → 人件費 −9,200、総労働時間 63h。警告は出ない（B が残っている）', () => {
      const a13 = lasora.assignments.find((x) => x.date === '2026-11-13' && data.staff.find((s) => s.id === x.staffId)!.name.includes('A'))!;
      const p = { ...lasora, assignments: lasora.assignments.filter((x) => x.id !== a13.id) };
      expect([after(p).laborCost, after(p).totalHours]).toEqual([75600, 63]);
      expect(projectWarnings(p, data)).toEqual([]);
    });
    it('10. 椅子（制作席）の保有数を 15 にする（パーツマスタ）→ 配置 16 脚が保有数を超えている警告が出る', () => {
      const d = { ...data, partTypes: data.partTypes.map((t) => (t.id === 'pt-chair' ? { ...t, stockQty: 15 } : t)) };
      expect(projectWarnings(lasora, d).map((w) => w.message)).toEqual(['椅子（制作席）: 配置 16 個が保有数 15 個を超えています（追加手配が必要）。']);
    });
    it('11. 予定個数を 300 → 320 にすると必要 80 席・日で、ちょうど足りる。321 にすると席が足りない警告が出る', () => {
      const withCount = (n: number) => ({ ...lasora, contents: lasora.contents.map((c) => ({ ...c, plannedCount: n })) });
      expect(projectWarnings(withCount(320), data)).toEqual([]);
      expect(projectWarnings(withCount(321), data).map((w) => w.target)).toEqual(['layout:seats']);
    });
    it('12. 上限回転数を空欄にすると、席が足りなくても警告しない（任意入力）', () => {
      const p = { ...lasora, contents: lasora.contents.map((c) => ({ ...c, plannedCount: 9999, maxTurns: null })) };
      expect(projectWarnings(p, data)).toEqual([]);
    });
    it('何もしなければ基準値のまま', () => {
      expect(after(lasora)).toEqual(base);
    });
  });
});

describe('デモ案件（12/5〜6）', () => {
  it('読み込み直後の試算。V1 との違いは、サンプルのパーツに仮の単価を入れたことによる備品費 13,400 だけ', () => {
    // 人件費 34,400／材料費 120×1.1×295 = 38,940／会場費 20,000×2 = 40,000／その他 12,000 は V1 と同じ
    // 備品費 : テーブル 6×500×2 ＋ 椅子 22（制作席 16 ＋ その他 6）×100×2 ＋ 登録スペース 3,000 ＝ 13,400（V1 は 0）
    expect(summary(demo)).toEqual({
      days: 2, revenue: 150000, laborCost: 34400, materialCost: 38940, venueFee: 40000,
      partsCost: 13400, otherCost: 12000, totalCost: 138740, profit: 11260, seats: 16, totalHours: 28,
    });
    // 120 個 ÷（16 席 × 2 日）＝ 3.75 回。上限回転数 4（仮）→ 必要 30 席・日 ≦ 32 席・日で、警告なし
    expect(estimate(demo, data).requiredTurns).toBe(3.75);
    expect(projectWarnings(demo, data)).toEqual([]);
  });
  it('2 つの案件は期間が重ならないので、スタッフの掛け持ち警告は出ない', () => {
    const days = (p: Project) => new Set(p.assignments.map((a) => a.date));
    expect([...days(demo)].some((d) => days(lasora).has(d))).toBe(false);
  });
});
