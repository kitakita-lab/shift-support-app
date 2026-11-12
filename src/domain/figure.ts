// 配置図に「描かれる内容」の一覧（図のモデル）と、その指紋。
//
// 何のためか（作業ログ D-21）:
//   「同じ版番号の図は 1 種類だけ」を、エディタの外で起きる変更（案件名・会場名・会期・パーツマスタの寸法や表示名）にも広げる。
//   PDF を出力するとき、図のモデルから計算した短い値（指紋）を、版・日付と一緒に記録しておく。
//   いまの図の指紋が、その版を出力したときの指紋と違っていれば、図は「次の版（未出力）」として扱う。
//
// 取りこぼしを防ぐ決まり:
//   図（LayoutSvg）は、このモデルだけを見て描く。モデルに無いものは図に出ない＝指紋に入っていないものが図を変えることはない。
//   例外は 3 つだけで、いずれも指紋に入れない: 版番号（指紋から決まるもの）・作成日（毎日変わるもの）・編集用の表示（選択枠・補助グリッド。出力されない）。
import { Dir, EnvElement, EnvKind, Layout, PartCategory, PartType, SeatRole, Tone } from '../types';
import { GroupLabel, buildLabels, itemSize, layoutTitle, nextVersion, noteLines } from './layout';
import { compactDate, periodText } from './util';

export interface FigureEnv {
  id: string;
  kind: EnvKind;
  x: number; y: number; w: number; h: number;
  label: string;
  /** 以下は、その種別で実際に描画に使う場合だけ入る（使わない種別では入れない＝指紋に影響させない） */
  sublabel?: string;
  tone?: Tone;
  dir?: Dir;
}
export interface FigureItem {
  id: string;
  /** 左上（cm）と、向きを反映した寸法（cm） */
  x: number; y: number; w: number; h: number;
  category: PartCategory;
  /** 椅子の役割（椅子以外は null）。色が変わる */
  role: SeatRole | null;
  /** パーツマスタに種別があるか（無ければ、削除済みを示す破線で描く） */
  known: boolean;
  /** 図に出す表示名（自動の番号、または手入力。空なら出さない） */
  label: string;
}
export interface FigureModel {
  /** タイトルの材料。版番号は含めない */
  title: { kind: 'project'; project: string; venue: string } | { kind: 'template'; venue: string };
  /** 会期（未入力なら ''） */
  period: string;
  caption: string;
  /** 未確認事項（空行を除いた行） */
  notes: string[];
  width: number;
  height: number;
  env: FigureEnv[];
  items: FigureItem[];
  groups: GroupLabel[];
}
export interface FigureContext {
  mode: 'project' | 'template';
  projectName: string;
  venueName: string;
  startDate: string;
  endDate: string;
}

/** 周辺環境 1 つを、その種別が実際に描画に使う項目だけにする */
function envOf(e: EnvElement): FigureEnv {
  const base: FigureEnv = { id: e.id, kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, label: e.label ?? '' };
  switch (e.kind) {
    case 'shop': return { ...base, sublabel: e.sublabel ?? '', tone: e.tone ?? 'gray' };
    case 'wall': return { ...base, tone: e.tone === 'orange' ? 'orange' : 'gray' };       // 橙かそれ以外かだけが色を変える
    case 'entrance': return { ...base, dir: e.dir ?? 'left' };
    case 'text': return { ...base, tone: e.tone ?? 'gray' };
    default: return base;                                                                  // 会場区画・通路・階段は色・補足・矢印を使わない
  }
}

export function figureModel(layout: Layout, partTypes: PartType[], ctx: FigureContext): FigureModel {
  const labels = buildLabels(layout, partTypes);
  return {
    title: ctx.mode === 'project' ? { kind: 'project', project: ctx.projectName, venue: ctx.venueName } : { kind: 'template', venue: ctx.venueName },
    period: ctx.mode === 'project' ? periodText(ctx.startDate, ctx.endDate) : '',
    caption: layout.caption,
    notes: noteLines(layout.notes),
    width: layout.width,
    height: layout.height,
    env: layout.env.map(envOf),
    items: layout.items.map((it) => {
      const pt = partTypes.find((t) => t.id === it.partTypeId);
      const s = itemSize(it, pt);
      const category = pt?.category ?? 'other';
      return {
        id: it.id, x: it.x, y: it.y, w: s.w, h: s.h, category,
        role: pt && category === 'chair' ? (pt.seatRole ?? 'work') : null,
        known: !!pt, label: labels.items.get(it.id) ?? '',
      };
    }),
    groups: labels.groups,
  };
}

/** 図面タイトル（版番号つき） */
export function figureTitle(m: FigureModel, version: number): string {
  if (m.title.kind === 'template') return `${m.title.venue || '会場'} 雛形`;
  return layoutTitle(m.title.project, m.title.venue, version);
}

/**
 * PDF のファイル名。例: ikyu_ラソラ札幌_20261113_イベント配置図_V1.pdf
 * 日付は会期の開始日。会期が図に出ない（未入力・不正）ときは、ファイル名にも入れない。
 */
export function pdfFileName(ctx: FigureContext, version: number): string {
  const clean = (t: string) => t.replace(/[\\/:*?"<>|｜\s]+/g, '_').replace(/^_+|_+$/g, '');
  if (ctx.mode === 'template') return `${clean(`${ctx.venueName || '会場'}_雛形`)}.pdf`;
  const date = periodText(ctx.startDate, ctx.endDate) ? compactDate(ctx.startDate) : '';
  return `${[ctx.projectName, ctx.venueName, date, 'イベント配置図', `V${version}`].map(clean).filter(Boolean).join('_')}.pdf`;
}

// ── 指紋 ─────────────────────────────────────────────────────
/** 何が変わったかを示せるよう、区分ごとに指紋を取る */
export const SECTIONS = ['title', 'period', 'caption', 'notes', 'size', 'env', 'items'] as const;
export type Section = (typeof SECTIONS)[number];
export const SECTION_LABEL: Record<Section, string> = {
  title: '案件名・会場名', period: '会期', caption: 'タイトル下の注記', notes: '未確認事項',
  size: '図面サイズ', env: '周辺環境', items: 'パーツ（位置・寸法・種類・表示名）',
};
export type Fingerprint = Record<string, string>;

/** キーの順序によらない文字列（Firestore を経由するとキーの順序が変わるため） */
function stable(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}
/** 文字列の短い要約値（53 ビット。改ざん対策ではなく、変化の検出用） */
function digest(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
/** 図のモデルを区分ごとに分ける。内部の ID（描画されない）は除く。並び順は重なり順なので残す */
function sections(m: FigureModel): Record<Section, unknown> {
  return {
    title: m.title,
    period: m.period,
    caption: m.caption,
    notes: m.notes,
    size: [m.width, m.height],
    env: m.env.map(({ id: _id, ...e }) => e),
    items: [m.items.map(({ id: _id, ...i }) => i), m.groups.map(({ groupId: _g, ...g }) => g)],
  };
}
export function fingerprint(m: FigureModel): Fingerprint {
  const d = sections(m);
  const out: Fingerprint = {};
  for (const s of SECTIONS) out[s] = digest(stable(d[s]));
  return out;
}
/** 指紋が違う区分（無ければ空＝同じ図） */
export function changedSections(a: Fingerprint, b: Fingerprint): Section[] {
  return SECTIONS.filter((s) => a[s] !== b[s]);
}

// ── 版の状態（指紋で決める） ─────────────────────────────────────
export interface FigureState {
  /** 図に表示する版＝次に出力したときに記録される版 */
  version: number;
  /**
   * issued  … この版は出力済みで、図は出力したときと同じ（再出力しても同じ版・同じ図）
   * draft   … 未出力
   * changed … 作業中の版は出力済みだが、その後に図が変わった（エディタの外での変更）。次の版として未出力
   */
  status: 'issued' | 'draft' | 'changed';
  /** issued のとき: この版を最初に出力した日 */
  issuedAt?: string;
  /** changed のとき: 出力済みだった版と、変わった区分（指紋を記録する前の版で出力した記録なら null） */
  since?: { version: number; changed: Section[] | null };
}
export function figureState(layout: Layout, fp: Fingerprint): FigureState {
  const rec = layout.issued.find((v) => v.version === layout.version);
  if (!rec) return { version: layout.version, status: 'draft' };
  const changed = rec.fp ? changedSections(rec.fp, fp) : null;
  if (changed && changed.length === 0) return { version: layout.version, status: 'issued', issuedAt: rec.issuedAt };
  return { version: nextVersion(layout), status: 'changed', since: { version: layout.version, changed } };
}
/**
 * PDF を出力したことを記録する。図に表示していた版（figureState の version）を、いまの指紋つきで「出力済み」にする。
 * 出力済みで図が変わっていない版の再出力なら、何も変えない（同じ版・同じ日付のまま）。
 */
export function issue(layout: Layout, fp: Fingerprint, issuedAt: string): Layout {
  const st = figureState(layout, fp);
  if (st.status === 'issued') return layout;
  return { ...layout, version: st.version, issued: [...layout.issued, { version: st.version, issuedAt, fp }] };
}
