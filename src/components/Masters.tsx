// マスタ画面（スタッフ／会場／コンテンツ／パーツ）。すべて表計算風グリッドで直接編集する。
import { useState } from 'react';
import { unitMaterialCost } from '../domain/calc';
import { newVenue } from '../domain/seed';
import { genId, yen } from '../domain/util';
import { AppData, Composite, CompositeMember, Content, Material, PartType, Staff, Venue } from '../types';
import Grid, { Col, n0 } from './Grid';
import LayoutEditor from './LayoutEditor';

interface Props {
  data: AppData;
  setMaster: <K extends Exclude<keyof AppData, 'projects'>>(key: K, items: AppData[K]) => void;
}

/** 削除で行が減るとき、使用中なら警告して選ばせる（禁止はしない） */
function confirmRemoval<T extends { id: string }>(prev: T[], next: T[], usedBy: (id: string) => number, what: string): boolean {
  const ids = new Set(next.map((x) => x.id));
  const removed = prev.filter((x) => !ids.has(x.id));
  const used = removed.reduce((s, x) => s + usedBy(x.id), 0);
  if (used === 0) return true;
  return window.confirm(`⚠ 削除しようとしている${what}は、案件で ${used} 箇所使われています。\n削除すると該当箇所は「未選択／削除済み」と表示され、試算から外れます。\n\n削除しますか？`);
}

export function StaffMaster({ data, setMaster }: Props) {
  const cols: Col<Staff>[] = [
    { key: 'name', title: '氏名', width: 200, get: (s) => s.name, set: (s, v) => ({ ...s, name: v }), warn: (s) => (!s.name.trim() ? '氏名が未入力です' : undefined) },
    { key: 'hourlyRate', title: '時給(円)', width: 100, type: 'number', get: (s) => s.hourlyRate, set: (s, v) => ({ ...s, hourlyRate: n0(v) }), warn: (s) => (s.hourlyRate <= 0 ? '時給が 0 円以下です（人件費が正しく試算されません）' : undefined) },
    { key: 'transportPerDay', title: '交通費/日(円)', width: 110, type: 'number', get: (s) => s.transportPerDay, set: (s, v) => ({ ...s, transportPerDay: n0(v) }) },
    { key: 'memo', title: 'メモ', width: 320, get: (s) => s.memo, set: (s, v) => ({ ...s, memo: v }) },
  ];
  const used = (id: string) => data.projects.reduce((n, p) => n + p.assignments.filter((a) => a.staffId === id).length, 0);
  return (
    <section>
      <h2>スタッフ<small>案件の「スタッフ配置」で選ぶリストです</small></h2>
      <Grid
        rows={data.staff} cols={cols} rowKey={(s) => s.id} deletable
        onChange={(rows) => { if (confirmRemoval(data.staff, rows, used, 'スタッフ')) setMaster('staff', rows); }}
        onAdd={() => setMaster('staff', [...data.staff, { id: genId(), name: '', hourlyRate: 0, transportPerDay: 0, memo: '' }])}
        addLabel="＋ スタッフを追加"
      />
    </section>
  );
}

export function VenueMaster({ data, setMaster }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const venue = data.venues.find((v) => v.id === editing);
  const cols: Col<Venue>[] = [
    { key: 'name', title: '会場名', width: 220, get: (v) => v.name, set: (v, x) => ({ ...v, name: x }), warn: (v) => (!v.name.trim() ? '会場名が未入力です' : undefined) },
    { key: 'feeFixed', title: '会場費 固定(円)', width: 120, type: 'number', get: (v) => v.feeFixed, set: (v, x) => ({ ...v, feeFixed: n0(x) }) },
    { key: 'feePerDay', title: '会場費 日額(円)', width: 120, type: 'number', get: (v) => v.feePerDay, set: (v, x) => ({ ...v, feePerDay: n0(x) }) },
    { key: 'feeRatePct', title: '売上歩合(%)', width: 100, type: 'number', get: (v) => v.feeRatePct, set: (v, x) => ({ ...v, feeRatePct: n0(x) }) },
    { key: 'env', title: '雛形の要素数', width: 100, type: 'readonly', align: 'right', get: (v) => v.template.env.length },
    {
      // 日報の同期で、会場名の書き方が違う回答を、この会場のものとして扱うための別名（明示的な対応づけ。あいまい一致はしない）
      key: 'reportNames', title: '日報での会場名（別名。複数は「｜」で区切る）', width: 300,
      get: (v) => (v.reportNames ?? []).join('｜'),
      set: (v, x) => ({ ...v, reportNames: x === '' ? [] : x.split('｜') }),
      placeholder: () => '会場名と同じなら空欄',
    },
    { key: 'memo', title: 'メモ', width: 280, get: (v) => v.memo, set: (v, x) => ({ ...v, memo: x }) },
  ];
  const used = (id: string) => data.projects.filter((p) => p.venueId === id).length;
  return (
    <section>
      <h2>会場<small>会場費の既定値と、レイアウトの雛形（周辺店舗・入口・通路など）を管理します。日報の同期は、会場名（または別名）と会期で照合します</small></h2>
      <Grid
        rows={data.venues} cols={cols} rowKey={(v) => v.id} deletable selectedKey={editing ?? undefined}
        onChange={(rows) => { if (confirmRemoval(data.venues, rows, used, '会場')) setMaster('venues', rows); }}
        onAdd={() => setMaster('venues', [...data.venues, newVenue()])}
        addLabel="＋ 会場を追加"
        rowActions={(v) => <button className="cellbtn cellbtn--wide" onClick={() => setEditing(editing === v.id ? null : v.id)}>{editing === v.id ? '閉じる' : '雛形を編集'}</button>}
      />
      {venue && (
        <>
          <h3>雛形の編集：{venue.name || '（名称未設定）'}<small>ここでの変更は、今後この会場で新しく作る案件に反映されます（既存案件は変わりません）</small></h3>
          {/* key を会場ごとに変える: 「元に戻す」の履歴を会場をまたいで持ち越さない（別の会場の雛形で上書きしてしまうため） */}
          <LayoutEditor
            key={venue.id}
            mode="template" layout={venue.template} partTypes={data.partTypes} composites={data.composites} venueName={venue.name}
            onChange={(template) => setMaster('venues', data.venues.map((v) => (v.id === venue.id ? { ...v, template } : v)))}
          />
        </>
      )}
    </section>
  );
}

export function ContentMaster({ data, setMaster }: Props) {
  const [sel, setSel] = useState<string | null>(data.contents[0]?.id ?? null);
  const content = data.contents.find((c) => c.id === sel);
  const cols: Col<Content>[] = [
    { key: 'name', title: 'コンテンツ名', width: 220, get: (c) => c.name, set: (c, v) => ({ ...c, name: v }), warn: (c) => (!c.name.trim() ? '名称が未入力です' : undefined) },
    { key: 'price', title: '参加費/個(円)', width: 110, type: 'number', get: (c) => c.price, set: (c, v) => ({ ...c, price: n0(v) }) },
    { key: 'unit', title: '材料原価/個', width: 110, type: 'readonly', align: 'right', get: (c) => yen(unitMaterialCost(c)), warn: (c) => (c.materials.length === 0 ? '材料が未登録です（材料費 0 円で試算されます）' : undefined) },
    { key: 'memo', title: 'メモ', width: 320, get: (c) => c.memo, set: (c, v) => ({ ...c, memo: v }) },
  ];
  const matCols: Col<Material>[] = [
    { key: 'name', title: '材料名', width: 220, get: (m) => m.name, set: (m, v) => ({ ...m, name: v }) },
    { key: 'unitCost', title: '単価(円)', width: 100, type: 'number', get: (m) => m.unitCost, set: (m, v) => ({ ...m, unitCost: n0(v) }) },
    { key: 'qtyPerUnit', title: '1個あたり使用数', width: 130, type: 'number', get: (m) => m.qtyPerUnit, set: (m, v) => ({ ...m, qtyPerUnit: n0(v) }) },
    { key: 'sub', title: '小計', width: 100, type: 'readonly', align: 'right', get: (m) => yen(m.unitCost * m.qtyPerUnit) },
  ];
  const used = (id: string) => data.projects.reduce((n, p) => n + p.contents.filter((c) => c.contentId === id).length, 0);
  const setMaterials = (materials: Material[]) =>
    setMaster('contents', data.contents.map((c) => (c.id === sel ? { ...c, materials } : c)));
  return (
    <section>
      <h2>コンテンツ<small>行をクリックすると、下でそのコンテンツの材料を編集できます</small></h2>
      <Grid
        rows={data.contents} cols={cols} rowKey={(c) => c.id} deletable selectedKey={sel ?? undefined} onSelect={(c) => setSel(c.id)}
        onChange={(rows) => { if (confirmRemoval(data.contents, rows, used, 'コンテンツ')) setMaster('contents', rows); }}
        onAdd={() => { const id = genId(); setMaster('contents', [...data.contents, { id, name: '', price: 0, materials: [], memo: '' }]); setSel(id); }}
        addLabel="＋ コンテンツを追加"
      />
      {content && (
        <>
          <h3>材料：{content.name || '（名称未設定）'}<small>1個（参加者1人分）を作るのに必要な材料</small></h3>
          <Grid
            rows={content.materials} cols={matCols} rowKey={(m) => m.id} deletable onChange={setMaterials}
            onAdd={() => setMaterials([...content.materials, { id: genId(), name: '', unitCost: 0, qtyPerUnit: 1 }])}
            addLabel="＋ 材料を追加"
            footer={[null, null, null, yen(unitMaterialCost(content))]}
          />
        </>
      )}
    </section>
  );
}

const CATEGORIES: { value: PartType['category']; label: string }[] = [
  { value: 'table', label: 'テーブル' }, { value: 'chair', label: '椅子' }, { value: 'banner', label: 'バナー' },
  { value: 'pop', label: 'POP' }, { value: 'display', label: '展示' }, { value: 'partition', label: '区画' }, { value: 'other', label: 'その他' },
];

export function PartMaster({ data, setMaster }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const comp = data.composites.find((c) => c.id === sel);
  const cols: Col<PartType>[] = [
    { key: 'name', title: 'パーツ名', width: 230, get: (p) => p.name, set: (p, v) => ({ ...p, name: v }) },
    { key: 'shortName', title: '図面上の表示名(空=非表示)', width: 170, get: (p) => p.shortName, set: (p, v) => ({ ...p, shortName: v }) },
    { key: 'category', title: '区分', width: 90, type: 'select', options: CATEGORIES, get: (p) => p.category, set: (p, v) => ({ ...p, category: (v || 'other') as PartType['category'] }) },
    {
      // 椅子だけに意味がある。制作席＝参加者が座って作る席（試算の席数に数える）／その他＝商談席・待合など（数えない。図では灰色）
      key: 'seatRole', title: '椅子の役割', width: 96, type: 'select', options: [{ value: 'work', label: '制作席' }, { value: 'other', label: 'その他' }],
      get: (p) => (p.category === 'chair' ? p.seatRole ?? 'work' : '—'),
      set: (p, v) => (p.category === 'chair' ? { ...p, seatRole: v === 'other' ? 'other' : 'work' } : p),
      editable: (p) => p.category === 'chair',
    },
    { key: 'widthCm', title: '幅(cm)', width: 76, type: 'number', get: (p) => p.widthCm, set: (p, v) => ({ ...p, widthCm: n0(v) }), warn: (p) => (p.widthCm <= 0 ? '幅が 0 以下です' : undefined) },
    { key: 'depthCm', title: '奥行(cm)', width: 76, type: 'number', get: (p) => p.depthCm, set: (p, v) => ({ ...p, depthCm: n0(v) }), warn: (p) => (p.depthCm <= 0 ? '奥行が 0 以下です' : undefined) },
    { key: 'numbered', title: '番号', width: 70, type: 'select', options: [{ value: '1', label: '付ける' }, { value: '0', label: 'なし' }], get: (p) => (p.numbered ? '1' : '0'), set: (p, v) => ({ ...p, numbered: v === '1' }) },
    { key: 'unitCost', title: '単価(円)', width: 90, type: 'number', get: (p) => p.unitCost, set: (p, v) => ({ ...p, unitCost: n0(v) }) },
    { key: 'costUnit', title: '単価の単位', width: 100, type: 'select', options: [{ value: 'event', label: '1案件' }, { value: 'day', label: '1日' }], get: (p) => p.costUnit, set: (p, v) => ({ ...p, costUnit: v === 'day' ? 'day' : 'event' }) },
    { key: 'stockQty', title: '保有数(0=管理なし)', width: 130, type: 'number', get: (p) => p.stockQty, set: (p, v) => ({ ...p, stockQty: n0(v) }) },
  ];
  const used = (id: string) => data.projects.reduce((n, p) => n + p.layout.items.filter((i) => i.partTypeId === id).length, 0);
  const partOptions = data.partTypes.map((p) => ({ value: p.id, label: p.name }));
  const memCols: Col<CompositeMember & { _i: number }>[] = [
    { key: 'partTypeId', title: 'パーツ', width: 230, type: 'select', options: partOptions, get: (m) => m.partTypeId, set: (m, v) => ({ ...m, partTypeId: v }) },
    { key: 'dx', title: '横位置(cm)', width: 100, type: 'number', get: (m) => m.dx, set: (m, v) => ({ ...m, dx: n0(v) }) },
    { key: 'dy', title: '縦位置(cm)', width: 100, type: 'number', get: (m) => m.dy, set: (m, v) => ({ ...m, dy: n0(v) }) },
    { key: 'rot', title: '向き', width: 90, type: 'select', options: [{ value: '0', label: '横' }, { value: '90', label: '縦(90°)' }], get: (m) => String(m.rot), set: (m, v) => ({ ...m, rot: v === '90' ? 90 : 0 }) },
  ];
  const setMembers = (rows: (CompositeMember & { _i: number })[]) =>
    setMaster('composites', data.composites.map((c) => (c.id === sel ? { ...c, members: rows.map(({ _i, ...m }) => m) } : c)));
  return (
    <section>
      <h2>定型パーツ<small>サイズが決まった部品。レイアウトの ［−］［＋］ で増減でき、個数×単価が試算の「備品費」に入ります。区分が「椅子」のものは、役割（制作席／その他）を選べます</small></h2>
      <Grid
        rows={data.partTypes} cols={cols} rowKey={(p) => p.id} deletable
        onChange={(rows) => { if (confirmRemoval(data.partTypes, rows, used, 'パーツ')) setMaster('partTypes', rows); }}
        onAdd={() => setMaster('partTypes', [...data.partTypes, { id: genId(), name: '', shortName: '', category: 'other', widthCm: 60, depthCm: 60, numbered: false, unitCost: 0, costUnit: 'event', stockQty: 0 }])}
        addLabel="＋ パーツを追加"
      />
      <h3>組み合わせ配置（L字など）<small>複数台をひとまとまりの部品として登録。行をクリックすると構成を編集できます</small></h3>
      <Grid<Composite>
        rows={data.composites} rowKey={(c) => c.id} deletable selectedKey={sel ?? undefined} onSelect={(c) => setSel(c.id)}
        cols={[
          { key: 'name', title: '名称（図面では「名称①」と表示）', width: 260, get: (c) => c.name, set: (c, v) => ({ ...c, name: v }) },
          { key: 'n', title: '構成数', width: 80, type: 'readonly', align: 'right', get: (c) => c.members.length },
        ]}
        onChange={(rows) => setMaster('composites', rows)}
        onAdd={() => { const id = genId(); setMaster('composites', [...data.composites, { id, name: '', members: [] }]); setSel(id); }}
        addLabel="＋ 組み合わせを追加"
      />
      {comp && (
        <>
          <h3>構成：{comp.name || '（名称未設定）'}<small>位置は組み合わせの左上を (0, 0) とした各パーツの左上座標</small></h3>
          <Grid
            rows={comp.members.map((m, i) => ({ ...m, _i: i }))} cols={memCols} rowKey={(m) => String(m._i)} deletable onChange={setMembers}
            onAdd={() => setMembers([...comp.members.map((m, i) => ({ ...m, _i: i })), { partTypeId: data.partTypes[0]?.id ?? '', dx: 0, dy: 0, rot: 0, _i: comp.members.length }])}
            addLabel="＋ パーツを追加"
          />
        </>
      )}
    </section>
  );
}
