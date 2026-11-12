// 共有データの同期で使う、端末にもネットワークにも依存しない計算（純関数）。
// Firestore の読み書きは remote.ts、画面との橋渡しは useSharedData.ts。
import { AppData, Project } from '../types';
import { MASTER_COLL, MASTER_KEYS, MasterKey, PROJECT_COLL, BACKUP_COLL } from './paths';

// ── 内容の比較 ───────────────────────────────────────────────
/** 内容を比べるための文字列にする（キーの順序をそろえ、undefined は無いものとして扱う） */
export function canon(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}
export const sameContent = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

export interface IdDiff<T> { added: T[]; changed: T[]; removed: string[] }
/** id で突き合わせて、増えたもの・内容が変わったもの・消えたものを出す */
export function diffById<T extends { id: string }>(prev: T[], next: T[]): IdDiff<T> {
  const before = new Map(prev.map((x) => [x.id, x]));
  const after = new Set(next.map((x) => x.id));
  const out: IdDiff<T> = { added: [], changed: [], removed: prev.filter((x) => !after.has(x.id)).map((x) => x.id) };
  for (const x of next) {
    const p = before.get(x.id);
    if (!p) out.added.push(x);
    else if (p !== x && !sameContent(p, x)) out.changed.push(x);
  }
  return out;
}

/**
 * next のうち、base と内容が違う最上位の項目だけを取り出す（自分が変えた項目だけを送るため）。
 * base にあって next に無い項目は「消した」として undefined を入れる。
 */
export function changedFields(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next)) {
    if (next[k] !== base[k] && !sameContent(next[k], base[k])) out[k] = next[k];
  }
  for (const k of Object.keys(base)) {
    if (base[k] !== undefined && next[k] === undefined) out[k] = undefined;
  }
  return out;
}

// ── 手元の変更の重ね合わせ ─────────────────────────────────────
// 画面の内容 ＝ サーバーから届いた内容 ＋ まだ届いた内容に反映されていない自分の変更。
// 入力中に古い内容が届いても、自分が変えた項目は巻き戻らない。自分が触っていない項目は、他の人の変更がそのまま見える。

export type Body = Record<string, unknown>;
export interface ServerDoc { body: Body; pending: boolean }
export interface Overlay {
  /** 自分が新しく作ったドキュメント（サーバーにまだ無い間の中身） */
  created?: Body;
  /** 編集を始めた時点のサーバーの内容（編集中にサーバー側で消された場合に、画面に残すため） */
  base?: Body;
  /**
   * 前回（この画面を開く前）から引き取った、送信前だった変更。共有側の状態を確かめるまでは送らないが、
   * 画面には重ねて表示する（未送信として数える）。確かめた結果、送る／何もしない／控えに回す、のどれかになる。
   */
  adopted?: Body | null;
  /** 送信済みで、届いた内容にまだ反映されていない変更（送った順） */
  issued: { rev: string; patch: Body }[];
  /** まだ送っていない変更（入力がいったん止まるのを待っている） */
  pending: Body | null;
  /** 自分が削除した */
  deleted: boolean;
}
export const emptyOverlay = (): Overlay => ({ issued: [], pending: null, deleted: false });

/** サーバーの内容に手元の変更を重ねた結果。null は「無い」 */
export function applyOverlay(server: Body | undefined, o: Overlay | undefined): Body | null {
  if (!o) return server ?? null;
  if (o.deleted) return null;
  const base = server ?? o.created ?? o.base;
  if (!base) return null;
  let out: Body = base;
  if (o.adopted) out = { ...out, ...o.adopted };                 // 前回の残りは、今回の変更より古いので先に重ねる
  for (const i of o.issued) out = { ...out, ...i.patch };
  if (o.pending) out = { ...out, ...o.pending };
  return out;
}

/** サーバーから内容が届いたあと、そこに反映済みの変更を手元から落とす。何も残らなければ null */
export function settleOverlay(o: Overlay, server: ServerDoc | undefined): Overlay | null {
  if (o.deleted) return server ? o : null;                     // サーバーから消えたら削除は完了
  let next = o;
  if (server) {
    const at = o.issued.findIndex((i) => i.rev === server.body.rev);
    if (at >= 0) next = { ...next, issued: o.issued.slice(at + 1) };
    if (next.created) next = { ...next, created: undefined };  // サーバー（または送信待ち）に載った
  }
  if (!next.created && next.issued.length === 0 && !next.pending && !next.adopted) return null;
  return next;
}

/** 重ね合わせた結果を、並び順（order → id）にそろえた配列にする */
export function composeDocs(server: Map<string, ServerDoc>, overlays: Map<string, Overlay>): { id: string; body: Body }[] {
  const ids = new Set([...server.keys(), ...overlays.keys()]);
  const out: { id: string; body: Body }[] = [];
  for (const id of ids) {
    const body = applyOverlay(server.get(id)?.body, overlays.get(id));
    if (body) out.push({ id, body });
  }
  const ord = (b: Body) => (typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER);
  return out.sort((a, b) => ord(a.body) - ord(b.body) || a.id.localeCompare(b.id));
}
export function nextOrder(docs: { body: Body }[]): number {
  return docs.reduce((m, d) => Math.max(m, typeof d.body.order === 'number' ? d.body.order : -1), -1) + 1;
}

/**
 * ドキュメントのうち、中身（案件・スタッフなど）そのものではない管理用の項目。
 *   order … 並び順 ／ rev … どの書き込みの結果かを見分ける印 ／ updatedBy … 最後に書いた人
 * 中身の項目名と重ならないこと（sharedLogic.test.ts で確認）。
 */
export const DOC_META_KEYS = ['order', 'rev', 'updatedBy'];
export function stripMeta(body: Body): Body {
  const out: Body = { ...body };
  for (const k of DOC_META_KEYS) delete out[k];
  return out;
}

// ── 前回の残り（送る前に画面が閉じられた変更）を送ってよいか ──────────────
/** 中身の比較から除く、付随的な項目（並び順・更新時刻・印・最後に書いた人） */
export const BOOKKEEPING_KEYS = ['order', 'updatedAt', 'rev', 'updatedBy'];
/**
 * gone    … 共有側に無い（削除された・保存されていなかった）
 * same    … 既に届いていた（内容が同じ）
 * send    … 共有側の印が safe のどれか＝この残りを始めてから、誰も触っていない
 * changed … それ以外（ほかの人が変更していた）
 */
export type RecoveryVerdict = 'gone' | 'same' | 'changed' | 'send';
/**
 * 前回の残り（patch＝変えた項目と値）を、共有側のいまの内容（server）に対して送ってよいかを決める。
 * safe は、その残り自身の履歴（変更を始めたときの印・その残りが送った印）。
 * 副作用は無い（トランザクションの中で、やり直しのたびに呼ばれる）。
 */
export function judgeRecovery(patch: Body, safe: string[], server: Body | null): RecoveryVerdict {
  if (!server) return 'gone';
  const differs = Object.keys(patch).some((f) => !BOOKKEEPING_KEYS.includes(f) && !sameContent(server[f], patch[f]));
  if (!differs) return 'same';
  const rev = typeof server.rev === 'string' ? server.rev : '';
  return safe.includes(rev) ? 'send' : 'changed';
}

// ── メンバー名簿 ─────────────────────────────────────────────
/** 名簿のキーにするメールアドレス（前後の空白を除き、小文字にそろえる） */
export const normalizeEmail = (s: string): string => s.trim().toLowerCase();
export function isValidMemberEmail(s: string): boolean {
  const e = normalizeEmail(s);
  return e.length <= 254 && /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(e);
}

// ── 旧形式（V1・V2）からの移行 ─────────────────────────────────
export interface LegacyData {
  /** workshopData/{種別} の中身。無ければ null */
  masters: Record<MasterKey, Body | null>;
  /** workshopProjects の全ドキュメント */
  projects: { id: string; doc: Body }[];
}
export interface PlannedDoc { coll: string; id: string; body: Body }
export interface MigrationPlan {
  docs: PlannedDoc[];
  backups: PlannedDoc[];
  /** 移行元の件数（種別ごと・案件） */
  counts: Record<string, number>;
  notes: string[];
}
export const MASTER_LABEL: Record<MasterKey, string> = {
  staff: 'スタッフ', venues: '会場', contents: 'コンテンツ', partTypes: 'パーツ', composites: '組み合わせ配置',
};

/** Firestore のドキュメント名に使える ID か（空・「/」を含む・「.」「..」・「__…__」・長すぎるものは使えない） */
export function usableDocId(id: string): boolean {
  return id.length > 0 && id.length <= 500 && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id);
}

export function legacyHasData(l: LegacyData): boolean {
  return l.projects.length > 0 || MASTER_KEYS.some((k) => l.masters[k] !== null);
}

/**
 * 移行の計画を立てる（何をどこへ書くか）。旧形式のデータは読むだけで、ここでも実行時にも書き換えない。
 * - マスタ: かたまり（items の配列）を、1 件＝1 ドキュメントにばらす。ドキュメント名は元の id（何度実行しても同じ場所＝重複しない）
 * - 案件: 同じ id のまま新しい場所へ写す
 * - バックアップ: 旧形式のドキュメントを、そのままの形で別の場所へ写す
 */
export function planMigration(
  legacy: LegacyData, backupId: string, defaults: Pick<AppData, 'partTypes' | 'composites'>,
): MigrationPlan {
  const docs: PlannedDoc[] = [];
  const backups: PlannedDoc[] = [];
  const counts: Record<string, number> = {};
  const notes: string[] = [];

  for (const key of MASTER_KEYS) {
    const raw = legacy.masters[key];
    let items = Array.isArray(raw?.items) ? (raw!.items as Body[]) : [];
    if (raw === null && (key === 'partTypes' || key === 'composites')) {
      // 旧形式に保存されていなかった場合は、アプリの初期値を入れる（V1・V2 も、無ければ初期値で動いていた）
      items = defaults[key] as unknown as Body[];
      notes.push(`${MASTER_LABEL[key]}: 以前の形式には保存されていなかったため、初期値を入れました。`);
    }
    if (raw !== null) backups.push({ coll: BACKUP_COLL, id: `${backupId}__data__${key}`, body: { kind: 'data', key, doc: raw } });
    const seen = new Set<string>();
    let n = 0;
    items.forEach((item, i) => {
      let id = typeof item?.id === 'string' ? item.id : '';
      if (!usableDocId(id)) {
        const was = id;
        id = `legacy-${key}-${i}`;
        notes.push(was
          ? `${MASTER_LABEL[key]}: ${i + 1} 件目の ID「${was}」は保存先の名前に使えないため、「${id}」に付け替えました。`
          : `${MASTER_LABEL[key]}: ${i + 1} 件目に ID が無かったため、「${id}」を付けました。`);
      }
      if (seen.has(id)) {
        notes.push(`${MASTER_LABEL[key]}: ID「${id}」が重複していたため、2 つ目以降は移行していません。`);
        return;
      }
      seen.add(id);
      docs.push({ coll: MASTER_COLL[key], id, body: { ...item, id, order: n } });
      n += 1;
    });
    counts[key] = n;
  }

  legacy.projects.forEach((p, i) => {
    docs.push({ coll: PROJECT_COLL, id: p.id, body: { ...p.doc, id: p.id, order: i } });
    backups.push({ coll: BACKUP_COLL, id: `${backupId}__project__${p.id}`, body: { kind: 'project', id: p.id, doc: p.doc } });
  });
  counts.projects = legacy.projects.length;

  backups.unshift({
    coll: BACKUP_COLL, id: `${backupId}__manifest`,
    body: { kind: 'manifest', backupId, counts, files: backups.map((b) => b.id) },
  });
  return { docs, backups, counts, notes };
}

export interface MigrationReportRow { label: string; source: number; target: number; match: boolean }
export interface MigrationReport {
  ok: boolean;
  rows: MigrationReportRow[];
  /** 内容が一致しなかったドキュメント（場所/名前） */
  mismatches: string[];
  notes: string[];
}

/**
 * 書き込んだあとにサーバーから読み直した内容を、計画（＝移行元）と 1 件ずつ照合する。
 * readBack: 「場所/名前」→ 読み直した中身（無ければ null）
 */
export function verifyMigration(plan: MigrationPlan, readBack: Map<string, Body | null>): MigrationReport {
  const mismatches: string[] = [];
  const matched: Record<string, number> = {};
  for (const d of [...plan.docs, ...plan.backups]) {
    const got = readBack.get(`${d.coll}/${d.id}`);
    if (got && sameContent(got, d.body)) matched[d.coll] = (matched[d.coll] ?? 0) + 1;
    else mismatches.push(`${d.coll}/${d.id}`);
  }
  const rows: MigrationReportRow[] = MASTER_KEYS.map((k) => {
    const planned = plan.docs.filter((d) => d.coll === MASTER_COLL[k]).length;
    return { label: MASTER_LABEL[k], source: planned, target: matched[MASTER_COLL[k]] ?? 0, match: planned === (matched[MASTER_COLL[k]] ?? 0) };
  });
  rows.push({ label: '案件', source: plan.counts.projects, target: matched[PROJECT_COLL] ?? 0, match: plan.counts.projects === (matched[PROJECT_COLL] ?? 0) });
  rows.push({ label: 'バックアップ', source: plan.backups.length, target: matched[BACKUP_COLL] ?? 0, match: plan.backups.length === (matched[BACKUP_COLL] ?? 0) });
  return { ok: mismatches.length === 0 && rows.every((r) => r.match), rows, mismatches, notes: plan.notes };
}

// ── 置き場所をまたぐ案件のコピー ───────────────────────────────
export interface ProjectCopy {
  project: Project;
  /** コピー先に無かったので一緒に足すマスタ */
  add: { [K in MasterKey]?: AppData[K] };
  notes: string[];
}

/**
 * 案件を別の置き場所（この端末だけ ⇔ 共有）へコピーするときの計画。
 * 案件が参照している会場・コンテンツ・スタッフ・パーツも、コピー先に無ければ一緒に足す。
 * コピー先に同じ id のものが既にあれば、**コピー先のものを使い、上書きしない**。
 */
export function planProjectCopy(
  source: AppData, projectId: string, target: AppData, newId: string, nameSuffix = '',
): ProjectCopy | null {
  const p = source.projects.find((x) => x.id === projectId);
  if (!p) return null;
  const notes: string[] = [];
  const add: ProjectCopy['add'] = {};
  const need = <K extends MasterKey>(key: K, ids: string[]) => {
    const want = [...new Set(ids.filter(Boolean))];
    const have = new Map((target[key] as { id: string }[]).map((x) => [x.id, x]));
    const toAdd: { id: string }[] = [];
    for (const id of want) {
      const src = (source[key] as { id: string }[]).find((x) => x.id === id);
      if (!src) continue;                                      // 元から参照切れ（そのまま持っていく）
      const dst = have.get(id);
      if (!dst) toAdd.push(structuredClone(src));
      else if (!sameContent(src, dst)) notes.push(`${MASTER_LABEL[key]}「${(src as { name?: string }).name ?? id}」は、コピー先にある内容をそのまま使います（上書きしていません）。`);
    }
    if (toAdd.length) (add as Record<string, unknown>)[key] = toAdd;
  };
  need('venues', [p.venueId]);
  need('contents', p.contents.map((c) => c.contentId));
  need('staff', p.assignments.map((a) => a.staffId));
  need('partTypes', p.layout.items.map((i) => i.partTypeId));
  return { project: { ...structuredClone(p), id: newId, name: `${p.name}${nameSuffix}` }, add, notes };
}
