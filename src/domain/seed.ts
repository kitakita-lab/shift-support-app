// 初期マスタとサンプルデータ。
// 注意: ここにある寸法・単価はすべて「仮の値」。実寸・実単価はマスタ画面で必ず上書きすること。
import {
  AppData, Assignment, Composite, Content, EnvElement, Layout, PartType, PlacedItem, Project, Staff, Venue,
} from '../types';
import { DEFAULT_CAPTION, emptyLayout } from './layout';
import { genId } from './util';

const T = 'pt-table', CH = 'pt-chair', NEG = 'pt-nego', REG = 'pt-reg', WORK = 'pt-work',
  BAN = 'pt-banner', POPL = 'pt-pop-l', POPS = 'pt-pop-s', DISP = 'pt-display', EYE = 'pt-eye';

export function defaultPartTypes(): PartType[] {
  const p = (
    id: string, name: string, shortName: string, category: PartType['category'],
    widthCm: number, depthCm: number, numbered = false,
  ): PartType => ({ id, name, shortName, category, widthCm, depthCm, numbered, unitCost: 0, costUnit: 'event', stockQty: 0 });
  return [
    p(T, 'テーブル 150×60', 'T', 'table', 150, 60, true),
    p(CH, '椅子', '', 'chair', 40, 40),
    p(NEG, '商談席テーブル', '商談席', 'table', 90, 130, true),
    p(WORK, '中央作業台', '中央作業台', 'table', 190, 55),
    p(REG, '登録スペース（パーテーション区画）', '登録スペース', 'partition', 310, 130),
    p(BAN, 'バナースタンド', 'バナー', 'banner', 145, 45),
    p(POPL, 'POPパネル（大）', 'POP', 'pop', 120, 170, true),
    p(POPS, 'POPパネル（小）', '', 'pop', 85, 125),
    p(DISP, '展示台', '展示', 'display', 205, 65),
    p(EYE, 'アイキャッチ台', 'アイキャッチ', 'other', 115, 65),
  ];
}

export function defaultComposites(): Composite[] {
  return [
    {
      id: 'cp-l-a', name: 'L字',
      members: [
        { partTypeId: T, dx: 0, dy: 0, rot: 0 },
        { partTypeId: T, dx: 150, dy: 0, rot: 0 },
        { partTypeId: T, dx: 0, dy: 60, rot: 90 },
      ],
    },
    {
      id: 'cp-l-b', name: 'L字（逆）',
      members: [
        { partTypeId: T, dx: 0, dy: 150, rot: 0 },
        { partTypeId: T, dx: 150, dy: 150, rot: 0 },
        { partTypeId: T, dx: 240, dy: 0, rot: 90 },
      ],
    },
    {
      id: 'cp-row2', name: '横2台連結',
      members: [
        { partTypeId: T, dx: 0, dy: 0, rot: 0 },
        { partTypeId: T, dx: 150, dy: 0, rot: 0 },
      ],
    },
  ];
}

// 参考画像(1200×1040px)の座標を cm に換算する。1px = 1.2cm、上のタイトル帯 85px を除く。
const K = 1.2;
const r5 = (v: number) => Math.round(v / 5) * 5;
const cx = (px: number) => r5(px * K);
const cy = (px: number) => r5((px - 85) * K);

function env(
  kind: EnvElement['kind'], x: number, y: number, w: number, h: number, label: string,
  extra: Partial<EnvElement> = {},
): EnvElement {
  return { id: genId(), kind, x: cx(x), y: cy(y), w: Math.max(8, r5(w * K)), h: Math.max(8, r5(h * K)), label, ...extra };
}

/** サンプル会場「ラソラ札幌」の雛形。参考の配置図を目視でなぞったもので、寸法は実測ではない */
export function sampleTemplate(): Layout {
  return {
    ...emptyLayout(1440, 1150),
    env: [
      env('passage', 145, 110, 835, 790, ''),
      env('booth', 205, 113, 710, 682, ''),
      env('wall', 205, 107, 710, 7, '上辺：壁'),
      env('shop', 15, 110, 120, 125, 'イベント物置', { tone: 'purple', sublabel: 'セカンドストリート／扉あり' }),
      env('shop', 15, 252, 120, 440, 'セカンド\nストリート', { tone: 'gray' }),
      env('wall', 135, 470, 9, 168, '', { tone: 'orange' }),
      env('text', 30, 735, 90, 22, '店舗入口'),
      env('text', 138, 157, 66, 17, '行き止まり', { tone: 'orange' }),
      env('shop', 982, 110, 205, 685, 'DECO HOME', { tone: 'gray', sublabel: 'デコホーム' }),
      env('text', 1030, 703, 100, 22, '店舗入口'),
      env('text', 985, 88, 140, 20, 'ラソラ建物入口側'),
      env('entrance', 975, 520, 10, 175, '入口①', { dir: 'left' }),
      env('entrance', 565, 790, 85, 8, '入口②（下側）', { dir: 'up' }),
      env('text', 915, 378, 65, 22, '縦通路 ↓', { tone: 'orange' }),
      env('text', 470, 845, 160, 26, '左右に続く通路', { tone: 'orange' }),
      env('stairs', 15, 920, 123, 95, '上り階段'),
      env('shop', 1005, 920, 176, 82, 'H&M', { tone: 'purple' }),
    ],
  };
}

function sampleItems(): Pick<Layout, 'items' | 'groups'> {
  const items: PlacedItem[] = [];
  const at = (partTypeId: string, x: number, y: number, extra: Partial<PlacedItem> = {}) =>
    items.push({ id: genId(), partTypeId, x: cx(x), y: cy(y), rot: 0, ...extra });
  // 椅子は中心座標(px)で指定
  const chair = (px: number, py: number) =>
    items.push({ id: genId(), partTypeId: CH, x: cx(px) - 20, y: cy(py) - 20, rot: 0 });

  const g1 = genId(), g2 = genId();
  const comps = defaultComposites();
  const place = (compId: string, groupId: string, px: number, py: number) => {
    const c = comps.find((x) => x.id === compId)!;
    for (const m of c.members) {
      items.push({ id: genId(), partTypeId: m.partTypeId, x: cx(px) + m.dx, y: cy(py) + m.dy, rot: m.rot, groupId });
    }
  };
  place('cp-l-a', g1, 423, 335);
  place('cp-l-b', g2, 533, 453);

  at(REG, 386, 139);
  at(POPL, 696, 137);
  at(POPL, 800, 137);
  at(BAN, 422, 257, { label: 'ブランドバナー' });
  at(BAN, 545, 257, { label: 'フラワーボトル' });
  at(NEG, 236, 307);
  at(NEG, 236, 456);
  at(NEG, 236, 605);
  at(WORK, 512, 485);
  at(DISP, 347, 720, { label: 'ikyuアクセサリー\n展示' });
  at(BAN, 350, 673, { label: 'アトリエバナー' });
  at(POPS, 664, 683);
  at(EYE, 742, 720, { label: '花・フラワーボトル\nアイキャッチ' });
  at(POPS, 843, 683);

  [[458, 312], [518, 312], [583, 312], [643, 312], [497, 405], [608, 405], [401, 422], [401, 472],
    [323, 342], [323, 384], [323, 491], [323, 533], [323, 640], [323, 682],
    [808, 490], [808, 540], [580, 545], [694, 545], [566, 665], [626, 665], [691, 665], [751, 665],
  ].forEach(([x, y]) => chair(x, y));

  return { items, groups: [{ id: g1, name: 'L字' }, { id: g2, name: 'L字' }] };
}

/** 会場雛形から案件用レイアウトを作る（雛形はコピーするので、案件側の変更は雛形に影響しない） */
export function layoutFromTemplate(tpl: Layout): Layout {
  return {
    ...emptyLayout(tpl.width, tpl.height),
    env: tpl.env.map((e) => ({ ...e, id: genId() })),
    caption: DEFAULT_CAPTION,
  };
}

export function newProject(venue?: Venue): Project {
  return {
    id: genId(),
    name: '',
    venueId: venue?.id ?? '',
    startDate: '',
    endDate: '',
    openTime: '10:00',
    closeTime: '18:00',
    status: '計画中',
    memo: '',
    contents: [],
    assignments: [],
    fixedRevenue: 0,
    venueFeeFixed: venue?.feeFixed ?? 0,
    venueFeePerDay: venue?.feePerDay ?? 0,
    venueFeeRatePct: venue?.feeRatePct ?? 0,
    otherCosts: [],
    layout: venue ? layoutFromTemplate(venue.template) : emptyLayout(),
    updatedAt: Date.now(),
  };
}

/** 案件の複製。新しい案件として扱い、配置図は V1・未出力から始める */
export function duplicateProject(p: Project): Project {
  const copy = structuredClone(p);
  return {
    ...copy,
    id: genId(),
    name: `${p.name}（コピー）`,
    status: '計画中',
    layout: { ...copy.layout, version: 1, issued: [] },
  };
}

export function newVenue(): Venue {
  return { id: genId(), name: '', feeFixed: 0, feePerDay: 0, feeRatePct: 0, memo: '', template: emptyLayout() };
}

export function emptyData(): AppData {
  return {
    staff: [], venues: [], contents: [],
    partTypes: defaultPartTypes(), composites: defaultComposites(), projects: [],
  };
}

/** サンプルのスタッフ配置（10:00〜18:00・休憩 60 分＝実働 7 時間） */
function sampleAssignment(staff: Staff, date: string): Assignment {
  return {
    id: genId(), staffId: staff.id, date, startTime: '10:00', endTime: '18:00', breakMinutes: 60,
    rateOverride: null, transportOverride: null, memo: '',
  };
}

/**
 * 動作確認用サンプル。案件は 2 件：
 *   1. ikyu 12/5〜6（2日間）… 最初からあるデモ
 *   2. ikyu 11/13〜17（5日間）… ラソラ札幌・フラワーボトルの実案件の土台。読み込めばそのまま配置と試算の検証を始められる
 * 金額・個数・人員・時間・寸法はすべて「仮置き」で、人名は架空。確定値はマスタと案件の画面で上書きすること。
 * 読み込み直後の試算の期待値は docs/作業ログ.md と seed.test.ts を参照。
 */
export function sampleData(): AppData {
  const staff: Staff[] = [
    { id: genId(), name: 'スタッフA（サンプル）', hourlyRate: 1200, transportPerDay: 800, memo: '時給・交通費は仮置き' },
    { id: genId(), name: 'スタッフB（サンプル）', hourlyRate: 1100, transportPerDay: 600, memo: '時給・交通費は仮置き' },
    { id: genId(), name: 'スタッフC（サンプル）', hourlyRate: 1100, transportPerDay: 0, memo: '時給・交通費は仮置き' },
  ];
  const [a, b, c] = staff;
  const content: Content = {
    id: genId(), name: 'フラワーボトル', price: 0, memo: '参加費・材料単価は仮置き（サンプル値）',
    materials: [
      { id: genId(), name: 'ボトル', unitCost: 120, qtyPerUnit: 1 },
      { id: genId(), name: '花材', unitCost: 30, qtyPerUnit: 5 },
      { id: genId(), name: 'ラベル・袋', unitCost: 25, qtyPerUnit: 1 },
    ],
  };
  const venue: Venue = {
    id: genId(), name: 'ラソラ札幌', feeFixed: 0, feePerDay: 20000, feeRatePct: 0,
    memo: '会場費は仮置き。雛形は参考配置図を目視でなぞったサンプルで、寸法は未確認', template: sampleTemplate(),
  };
  // レイアウトと備品費の連動を確かめられるよう、主な什器に仮の単価を入れておく（初期マスタは単価 0 のまま）
  const sampleCost: Record<string, Pick<PartType, 'unitCost' | 'costUnit'>> = {
    [T]: { unitCost: 500, costUnit: 'day' },      // テーブル: 500 円/日（仮）
    [CH]: { unitCost: 100, costUnit: 'day' },     // 椅子: 100 円/日（仮）
    [REG]: { unitCost: 3000, costUnit: 'event' }, // 登録スペース: 3,000 円/案件（仮）
  };
  const partTypes = defaultPartTypes().map((t) => ({ ...t, ...sampleCost[t.id] }));

  const demoBase = newProject(venue);
  const demo: Project = {
    ...demoBase,
    name: 'ikyu',
    startDate: '2026-12-05',
    endDate: '2026-12-06',
    fixedRevenue: 150000,
    contents: [{ id: genId(), contentId: content.id, plannedCount: 120, priceOverride: null, sparePct: 10 }],
    assignments: [sampleAssignment(a, '2026-12-05'), sampleAssignment(b, '2026-12-05'), sampleAssignment(a, '2026-12-06'), sampleAssignment(c, '2026-12-06')],
    otherCosts: [{ id: genId(), name: '印刷費（POP・バナー）', amount: 12000 }],
    layout: { ...demoBase.layout, ...sampleItems(), notes: '実寸（ブース・通路幅）\n防災条件（避難経路・消火設備）\n電源の位置' },
  };

  // ── ラソラ札幌 2026-11-13(金)〜17(火)・フラワーボトル（ikyu）の土台。数値はすべて仮置き ──
  const lasoraBase = newProject(venue);
  const lasora: Project = {
    ...lasoraBase,
    name: 'ikyu',
    startDate: '2026-11-13',
    endDate: '2026-11-17',
    memo: '【仮置き】ラソラ札幌 11/13〜17 の土台。金額・個数・人員・時間・寸法はすべて仮の値。確定値に置き換えて使う',
    fixedRevenue: 400000,                                    // 受託料（仮）
    contents: [{ id: genId(), contentId: content.id, plannedCount: 300, priceOverride: null, sparePct: 10 }],   // 60 個/日 × 5 日（仮）
    // 1 日 2 人（仮）。A: 4 日、B: 3 日、C: 3 日
    assignments: [
      sampleAssignment(a, '2026-11-13'), sampleAssignment(b, '2026-11-13'),
      sampleAssignment(a, '2026-11-14'), sampleAssignment(c, '2026-11-14'),
      sampleAssignment(b, '2026-11-15'), sampleAssignment(c, '2026-11-15'),
      sampleAssignment(a, '2026-11-16'), sampleAssignment(b, '2026-11-16'),
      sampleAssignment(a, '2026-11-17'), sampleAssignment(c, '2026-11-17'),
    ],
    otherCosts: [
      { id: genId(), name: '印刷費（POP・バナー）※仮', amount: 12000 },
      { id: genId(), name: '運搬・送料 ※仮', amount: 10000 },
    ],
    layout: {
      ...lasoraBase.layout, ...sampleItems(),
      notes: '什器（テーブル・椅子など）の台数とサイズは仮置き\n実寸（ブース・通路幅）\n防災条件（避難経路・消火設備）\n電源の位置',
    },
  };

  return {
    staff, venues: [venue], contents: [content],
    partTypes, composites: defaultComposites(), projects: [demo, lasora],
  };
}
