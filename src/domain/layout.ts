// レイアウト操作（純関数）。UI からはここだけを呼び、試算側は countParts（calc.ts）で個数を読む。
import { Composite, EnvElement, Layout, PartType, PlacedItem } from '../types';
import { circled, genId } from './util';

export const DEFAULT_CAPTION = '配置確認用・縮尺なし／実寸・通路幅・防災条件は未確認';

export function emptyLayout(width = 1440, height = 1130): Layout {
  return { width, height, env: [], items: [], groups: [], version: 1, issued: [], caption: DEFAULT_CAPTION, notes: '' };
}

/** 旧データ・欠損フィールドを補完する */
export function hydrateLayout(raw: Partial<Layout> | undefined): Layout {
  const base = emptyLayout();
  return {
    width: raw?.width ?? base.width,
    height: raw?.height ?? base.height,
    env: raw?.env ?? [],
    items: raw?.items ?? [],
    groups: raw?.groups ?? [],
    version: raw?.version ?? 1,
    issued: raw?.issued ?? [],
    caption: raw?.caption ?? base.caption,
    notes: raw?.notes ?? '',
  };
}

export interface Size { w: number; h: number }

export function itemSize(item: PlacedItem, pt: PartType | undefined): Size {
  const w = pt?.widthCm ?? 60;
  const h = pt?.depthCm ?? 60;
  return item.rot === 90 ? { w: h, h: w } : { w, h };
}

function booth(layout: Layout): EnvElement | undefined {
  return layout.env.find((e) => e.kind === 'booth');
}

const snapTo = (v: number, grid: number) => (grid > 0 ? Math.round(v / grid) * grid : v);

function clamp(layout: Layout, x: number, y: number, s: Size) {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, layout.width - s.w)),
    y: Math.min(Math.max(0, y), Math.max(0, layout.height - s.h)),
  };
}

/** 新規パーツの初期位置。ブース左上から少しずつずらして重なりを避ける */
function spawnPoint(layout: Layout): { x: number; y: number } {
  const b = booth(layout);
  const ox = (b?.x ?? 0) + 30;
  const oy = (b?.y ?? 0) + 30;
  const n = layout.items.length % 12;
  return { x: ox + n * 20, y: oy + n * 20 };
}

export function addPart(layout: Layout, pt: PartType): Layout {
  const p = spawnPoint(layout);
  const item: PlacedItem = { id: genId(), partTypeId: pt.id, rot: 0, ...p };
  const c = clamp(layout, item.x, item.y, itemSize(item, pt));
  return { ...layout, items: [...layout.items, { ...item, ...c }] };
}

/** 「−」ボタン用。その種別で最後に追加した1個を取り除く（グループ外を優先） */
export function removeLastPart(layout: Layout, partTypeId: string): Layout {
  const ofType = layout.items.filter((i) => i.partTypeId === partTypeId);
  if (ofType.length === 0) return layout;
  const loose = ofType.filter((i) => !i.groupId);
  const target = (loose.length > 0 ? loose : ofType).slice(-1)[0];
  return removeItems(layout, [target.id]);
}

export function removeItems(layout: Layout, ids: string[]): Layout {
  const set = new Set(ids);
  const items = layout.items.filter((i) => !set.has(i.id));
  const alive = new Set(items.map((i) => i.groupId).filter(Boolean));
  return { ...layout, items, groups: layout.groups.filter((g) => alive.has(g.id)) };
}

export function addComposite(layout: Layout, comp: Composite, partTypes: PartType[]): Layout {
  const p = spawnPoint(layout);
  const groupId = genId();
  const items: PlacedItem[] = comp.members
    .filter((m) => partTypes.some((t) => t.id === m.partTypeId))
    .map((m) => ({ id: genId(), partTypeId: m.partTypeId, x: p.x + m.dx, y: p.y + m.dy, rot: m.rot, groupId }));
  if (items.length === 0) return layout;
  return {
    ...layout,
    items: [...layout.items, ...items],
    groups: [...layout.groups, { id: groupId, name: comp.name }],
  };
}

/** グループ解除。パーツは残り、個別に動かせるようになる */
export function ungroup(layout: Layout, groupId: string): Layout {
  return {
    ...layout,
    items: layout.items.map((i) => (i.groupId === groupId ? { ...i, groupId: undefined } : i)),
    groups: layout.groups.filter((g) => g.id !== groupId),
  };
}

/** ドラッグ対象の id 一覧（グループ所属なら全員） */
export function dragSet(layout: Layout, itemId: string): string[] {
  const it = layout.items.find((i) => i.id === itemId);
  if (!it) return [];
  if (!it.groupId) return [it.id];
  return layout.items.filter((i) => i.groupId === it.groupId).map((i) => i.id);
}

/**
 * ids を (dx, dy) 移動する。先頭要素を grid にスナップし、残りは同じ量だけ動かす（相対位置を保つ）。
 * 図面の外には出さない（全体の外接矩形でクランプ）。
 */
export function moveItems(
  layout: Layout, ids: string[], dx: number, dy: number, partTypes: PartType[], grid = 0,
): Layout {
  const set = new Set(ids);
  const moving = layout.items.filter((i) => set.has(i.id));
  if (moving.length === 0) return layout;
  const lead = moving[0];
  let ddx = snapTo(lead.x + dx, grid) - lead.x;
  let ddy = snapTo(lead.y + dy, grid) - lead.y;
  const bb = bbox(moving, partTypes);
  ddx = Math.min(Math.max(ddx, -bb.x), layout.width - (bb.x + bb.w));
  ddy = Math.min(Math.max(ddy, -bb.y), layout.height - (bb.y + bb.h));
  if (ddx === 0 && ddy === 0) return layout;
  return { ...layout, items: layout.items.map((i) => (set.has(i.id) ? { ...i, x: i.x + ddx, y: i.y + ddy } : i)) };
}

/** 中心を保ったまま 90° 回転（単体） */
export function rotateItem(layout: Layout, itemId: string, partTypes: PartType[]): Layout {
  return {
    ...layout,
    items: layout.items.map((i) => {
      if (i.id !== itemId) return i;
      const pt = partTypes.find((t) => t.id === i.partTypeId);
      const s = itemSize(i, pt);
      const next: PlacedItem = { ...i, rot: i.rot === 0 ? 90 : 0 };
      const ns = itemSize(next, pt);
      const c = clamp(layout, i.x + (s.w - ns.w) / 2, i.y + (s.h - ns.h) / 2, ns);
      return { ...next, ...c };
    }),
  };
}

export function updateItem(layout: Layout, itemId: string, patch: Partial<PlacedItem>): Layout {
  return { ...layout, items: layout.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) };
}

export function bbox(items: PlacedItem[], partTypes: PartType[]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const i of items) {
    const s = itemSize(i, partTypes.find((t) => t.id === i.partTypeId));
    x1 = Math.min(x1, i.x); y1 = Math.min(y1, i.y);
    x2 = Math.max(x2, i.x + s.w); y2 = Math.max(y2, i.y + s.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ── 周辺環境 ────────────────────────────────────────────────

const ENV_DEFAULTS: Record<EnvElement['kind'], Partial<EnvElement>> = {
  booth:    { w: 800, h: 700, label: '' },
  passage:  { w: 600, h: 120, label: '通路' },
  shop:     { w: 240, h: 300, label: '店舗名', tone: 'gray' },
  wall:     { w: 600, h: 8, label: '壁' },
  entrance: { w: 12, h: 180, label: '入口', dir: 'left' },
  stairs:   { w: 150, h: 110, label: '階段' },
  text:     { w: 160, h: 30, label: 'テキスト' },
};

export function addEnv(layout: Layout, kind: EnvElement['kind']): Layout {
  const d = ENV_DEFAULTS[kind];
  const n = layout.env.length % 10;
  const el: EnvElement = { id: genId(), kind, x: 40 + n * 20, y: 40 + n * 20, w: 100, h: 100, label: '', ...d };
  return { ...layout, env: [...layout.env, el] };
}

export function updateEnv(layout: Layout, id: string, patch: Partial<EnvElement>): Layout {
  return { ...layout, env: layout.env.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

export function removeEnv(layout: Layout, id: string): Layout {
  return { ...layout, env: layout.env.filter((e) => e.id !== id) };
}

export function moveEnv(layout: Layout, id: string, dx: number, dy: number, grid = 0): Layout {
  return {
    ...layout,
    env: layout.env.map((e) => {
      if (e.id !== id) return e;
      const c = clamp(layout, snapTo(e.x + dx, grid), snapTo(e.y + dy, grid), { w: e.w, h: e.h });
      return { ...e, ...c };
    }),
  };
}

// ── 番号・ラベル ────────────────────────────────────────────

export interface GroupLabel { groupId: string; title: string; subtitle: string; x: number; y: number }

export interface Labels {
  /** itemId → 図面に表示するラベル（空文字は非表示） */
  items: Map<string, string>;
  groups: GroupLabel[];
}

/**
 * 表示ラベルを導出する（保存しない＝増減しても常に連番が保たれる）。
 * - グループ: 作成順に ①②… を振り、番号つきパーツは「①-1」形式
 * - グループ外の番号つきパーツ: 種別ごとに「表示名＋連番」（例: 商談席1）
 * - 番号なしパーツ: 表示名のみ（表示名が空なら非表示。椅子など）
 * - item.label が入力されていればそれを優先
 */
export function buildLabels(layout: Layout, partTypes: PartType[]): Labels {
  const ptOf = (id: string) => partTypes.find((t) => t.id === id);
  const items = new Map<string, string>();
  const groups: GroupLabel[] = [];
  const perType = new Map<string, number>();
  const obstacles: Rect[] = layout.items.map((i) => ({ x: i.x, y: i.y, ...itemSize(i, ptOf(i.partTypeId)) }));

  layout.groups.forEach((g, gi) => {
    const mark = circled(gi + 1);
    const members = layout.items.filter((i) => i.groupId === g.id);
    let k = 0;
    const tally = new Map<string, number>();
    for (const m of members) {
      const pt = ptOf(m.partTypeId);
      if (pt?.numbered) {
        k += 1;
        items.set(m.id, `${mark}-${k}`);
        const key = m.rot === 90 ? '縦' : '横';
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    if (members.length === 0) return;
    const pos = groupLabelPoint(members, obstacles, partTypes);
    // 次のグループ名が同じ場所に重ならないよう、置いた名前も障害物に加える
    obstacles.push({ x: pos.x - 70, y: pos.y - 30, w: 140, h: 65 });
    const parts = ['横', '縦'].filter((d) => tally.has(d)).map((d) => `${d}${tally.get(d)}台`);
    groups.push({ groupId: g.id, title: `${g.name}${mark}`, subtitle: parts.join('＋'), ...pos });
  });

  for (const it of layout.items) {
    const pt = ptOf(it.partTypeId);
    if (!items.has(it.id)) {
      if (pt?.numbered && !it.groupId) {
        const n = (perType.get(it.partTypeId) ?? 0) + 1;
        perType.set(it.partTypeId, n);
        items.set(it.id, `${pt.shortName}${n}`);
      } else {
        items.set(it.id, pt?.shortName ?? '');
      }
    }
    if (it.label) items.set(it.id, it.label);
  }
  return { items, groups };
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * グループ名を置く位置。外接矩形の内側を格子状に探し、図面上のどのパーツ・既出のグループ名からも
 * 最も離れた点を選ぶ（L字の内側の空きに入る）。
 */
function groupLabelPoint(members: PlacedItem[], obstacles: Rect[], partTypes: PartType[]): { x: number; y: number } {
  const bb = bbox(members, partTypes);
  const fr = [0.15, 0.3, 0.5, 0.7, 0.85];
  let best = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  let bestD = -1;
  for (const fy of fr) {
    for (const fx of fr) {
      const c = { x: bb.x + bb.w * fx, y: bb.y + bb.h * fy };
      const d = Math.min(Infinity, ...obstacles.map((r) => {
        const dx = Math.max(r.x - c.x, 0, c.x - (r.x + r.w));
        const dy = Math.max(r.y - c.y, 0, c.y - (r.y + r.h));
        // 名前は横長なので、横方向の空きを厳しめ（1/2.2）に評価する
        return Math.hypot(dx / 2.2, dy);
      }));
      if (d > bestD) { bestD = d; best = c; }
    }
  }
  return best;
}

// ── 版管理 ──────────────────────────────────────────────────
// 守ること：「同じ版番号の図は 1 種類だけ」。出力（発行）した版の内容を変えたら、必ず新しい版番号にする。

export function isIssued(layout: Layout): boolean {
  return layout.issued.some((v) => v.version === layout.version);
}

/** これまでに使ったどの版（作業中の版・出力済みの版）よりも新しい版番号 */
export function nextVersion(layout: Layout): number {
  return Math.max(layout.version, ...layout.issued.map((v) => v.version)) + 1;
}

/** 発行済みの版に手を入れたら、次の版に自動で繰り上げる */
export function bumpIfIssued(layout: Layout): Layout {
  return isIssued(layout) ? { ...layout, version: nextVersion(layout) } : layout;
}

/** PDF 出力時に現在の版を「発行済み」として記録する */
export function markIssued(layout: Layout, issuedAt: string): Layout {
  if (isIssued(layout)) return layout;
  return { ...layout, issued: [...layout.issued, { version: layout.version, issuedAt }] };
}

/**
 * 「元に戻す」。図面の内容は prev（履歴に積んであった状態）に戻すが、出力の記録は事実なので消さない。
 * - prev が「出力した時点の状態そのもの」なら、その版に戻る（内容が出力済みの図と一致するので版番号も同じでよい）
 * - それ以外で、いまの版が出力済みなら次の版にする（出力済みの版と違う内容を、同じ版番号で出さない）
 * - それ以外は、いまの作業中の版番号のまま
 */
export function undoTo(current: Layout, prev: Layout): Layout {
  const restored: Layout = { ...prev, issued: current.issued };
  // 出力済みの版は編集した時点で次の版に上がるので、「出力記録つきで履歴に残っている状態」＝出力した内容そのもの
  if (prev.issued.some((v) => v.version === prev.version)) return restored;
  return { ...restored, version: isIssued(current) ? nextVersion(current) : current.version };
}

/**
 * 周辺環境を会場雛形のもので置き換える（配置済みパーツ・注記・版の記録は残す）。
 * 雛形はコピーして使う（id を振り直す）。出力済みの版なら、図が変わるので次の版にする。
 */
export function applyTemplate(layout: Layout, template: Layout): Layout {
  return bumpIfIssued({
    ...layout,
    width: template.width,
    height: template.height,
    env: template.env.map((e) => ({ ...e, id: genId() })),
  });
}

export function layoutTitle(projectName: string, venueName: string, version: number): string {
  const head = [projectName, venueName].filter(Boolean).join('｜');
  return `${head} イベント配置図 V${version}`;
}

/** 未確認事項を行ごとの配列にする（空行は除く） */
export function noteLines(notes: string): string[] {
  return notes.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 重なっているパーツの組（警告用）。同一グループ内（L字の継ぎ目など）は対象外。5cm 以下の重なりは許容 */
export function findOverlaps(layout: Layout, partTypes: PartType[]): [PlacedItem, PlacedItem][] {
  const out: [PlacedItem, PlacedItem][] = [];
  const rs = layout.items.map((i) => ({ i, pt: partTypes.find((t) => t.id === i.partTypeId) }))
    .map(({ i, pt }) => ({ i, pt, ...itemSize(i, pt) }));
  for (let a = 0; a < rs.length; a++) {
    for (let b = a + 1; b < rs.length; b++) {
      const A = rs[a], B = rs[b];
      if (A.i.groupId && A.i.groupId === B.i.groupId) continue;
      const ox = Math.min(A.i.x + A.w, B.i.x + B.w) - Math.max(A.i.x, B.i.x);
      const oy = Math.min(A.i.y + A.h, B.i.y + B.h) - Math.max(A.i.y, B.i.y);
      // 接しているだけ・わずかな重なり(5cm以下)は許容
      if (ox > 5 && oy > 5) out.push([A.i, B.i]);
    }
  }
  return out;
}
