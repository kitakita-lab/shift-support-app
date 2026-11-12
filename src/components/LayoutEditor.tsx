// ブースレイアウトエディタ。
// - 左の表の ［−］［＋］ で定型パーツを増減（個数はそのまま試算に連動）
// - 置いたパーツ／周辺環境はドラッグで位置調整。矢印キーで微調整、Delete で削除、Ctrl+Z で元に戻す
// - mode='template' は会場マスタの雛形編集用（周辺環境のみ）
import { KeyboardEvent, PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { countParts } from '../domain/calc';
import {
  addComposite, addEnv, addPart, bumpIfIssued, dragSet, isIssued, itemSize, layoutTitle, markIssued,
  moveEnv, moveItems, nextVersion, removeEnv, removeItems, removeLastPart, rotateItem, undoTo, ungroup, updateItem,
} from '../domain/layout';
import { localDate } from '../domain/util';
import { downloadSvgAsPdf } from '../export/pdf';
import { Composite, EnvElement, EnvKind, Layout, PartType, Warning } from '../types';
import Grid, { Col, n0 } from './Grid';
import LayoutSvg from './LayoutSvg';
import NumInput from './NumInput';

const ENV_KINDS: { kind: EnvKind; label: string }[] = [
  { kind: 'booth', label: '会場区画' },
  { kind: 'passage', label: '通路' },
  { kind: 'shop', label: '周辺店舗' },
  { kind: 'entrance', label: '入口' },
  { kind: 'wall', label: '壁・扉' },
  { kind: 'stairs', label: '階段' },
  { kind: 'text', label: '文字' },
];
const KIND_LABEL = Object.fromEntries(ENV_KINDS.map((k) => [k.kind, k.label]));

interface Props {
  mode: 'project' | 'template';
  layout: Layout;
  onChange: (l: Layout) => void;
  partTypes: PartType[];
  composites: Composite[];
  /** タイトルの材料（project モード） */
  projectName?: string;
  venueName?: string;
  warnings?: Warning[];
  /** 会場雛形の周辺環境を読み込み直す（project モード） */
  onReloadTemplate?: () => void;
  /** いまの周辺環境を会場雛形として保存する（project モード） */
  onSaveAsTemplate?: () => void;
}

type Sel = { type: 'item'; ids: string[]; primary: string } | { type: 'env'; id: string } | null;

export default function LayoutEditor({
  mode, layout, onChange, partTypes, composites, projectName = '', venueName = '', warnings = [],
  onReloadTemplate, onSaveAsTemplate,
}: Props) {
  const [layer, setLayer] = useState<'parts' | 'env'>(mode === 'template' ? 'env' : 'parts');
  const [grid, setGrid] = useState(5);
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    /** 押した位置（画面上） */
    cx: number; cy: number;
    /** 押した位置を図面座標に直したもの・動かす元のレイアウト。どちらも最初に動いた時点で確定する */
    origin: { x: number; y: number } | null; base: Layout | null;
    moved: boolean;
  } | null>(null);
  const history = useRef<Layout[]>([]);

  const shown = draft ?? layout;
  const counts = useMemo(() => countParts(shown), [shown]);

  /** 確定した変更。発行済みの版なら次の版へ繰り上げ、Undo 履歴に積む */
  const commit = (next: Layout) => {
    // PDF 出力の処理中は編集を受け付けない（出力した図と「出力済み」の記録がずれないようにする）
    if (busy || next === layout) return;
    history.current = [...history.current.slice(-49), layout];
    onChange(mode === 'project' ? bumpIfIssued(next) : next);
  };
  const undo = () => {
    if (busy) return;
    const prev = history.current.pop();
    if (!prev) return;
    // 図面の内容だけを戻す。出力の記録は消さず、版番号は undoTo が決める（同じ版番号で違う図を出さないため）
    onChange(mode === 'project' ? undoTo(layout, prev) : prev);
    setSel(null);
  };

  // 選択中のものが消えたら選択を外す
  useEffect(() => {
    if (sel?.type === 'item' && !layout.items.some((i) => i.id === sel.primary)) setSel(null);
    if (sel?.type === 'env' && !layout.env.some((e) => e.id === sel.id)) setSel(null);
  }, [layout, sel]);

  // ── ドラッグ ──
  /** 画面上の点を、いまの図の位置・縮尺で図面座標（cm）に直す */
  const toSvg = (clientX: number, clientY: number) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const startDrag = (ev: PointerEvent, s: Sel) => {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    // ここでは押した位置だけを覚える。図面上の起点と、動かす元のレイアウトは、最初に動いた時点で決める（onMove）。
    // 押した瞬間に決めてしまうと、押したことで起きる変化を取りこぼす:
    //   - 狭い画面では、パーツを選ぶと図の上の「選択中のパーツ」欄が伸びて図が下へ押され、その分だけパーツが飛ぶ
    //   - 図面サイズを打ちかけのまま図を押すと、その入力が確定する前のレイアウトを動かしてしまい、サイズの変更が消える
    drag.current = { cx: ev.clientX, cy: ev.clientY, origin: null, base: null, moved: false };
    setSel(s);
  };
  const onItemDown = (ev: PointerEvent, id: string) => {
    if (layer !== 'parts') return;
    startDrag(ev, { type: 'item', ids: dragSet(layout, id), primary: id });
  };
  const onEnvDown = (ev: PointerEvent, id: string) => {
    if (layer !== 'env') return;
    startDrag(ev, { type: 'env', id });
  };
  const onMove = (ev: PointerEvent) => {
    const d = drag.current;
    if (!d || !sel) return;
    // 起点＝「押した位置」を、表示が落ち着いたいまの図の位置で図面座標に直したもの。
    // 以後は図面座標どうしの差で移動量を出すので、ドラッグ中にページをスクロールしてもパーツはカーソルに付いてくる
    d.origin ??= toSvg(d.cx, d.cy);
    const p = toSvg(ev.clientX, ev.clientY);
    const dx = p.x - d.origin.x, dy = p.y - d.origin.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) { d.moved = true; d.base = layout; }
    const base = d.base ?? layout;
    setDraft(sel.type === 'item'
      ? moveItems(base, sel.ids, dx, dy, partTypes, grid)
      : moveEnv(base, sel.id, dx, dy, grid));
  };
  const onUp = () => {
    if (drag.current?.moved && draft) commit(draft);
    drag.current = null;
    setDraft(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (!sel) return;
    const step = e.shiftKey ? 50 : Math.max(grid, 1);
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (delta[e.key]) {
      e.preventDefault();
      const [dx, dy] = delta[e.key];
      commit(sel.type === 'item' ? moveItems(layout, sel.ids, dx, dy, partTypes, 0) : moveEnv(layout, sel.id, dx, dy, 0));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      commit(sel.type === 'item' ? removeItems(layout, [sel.primary]) : removeEnv(layout, sel.id));
    }
  };

  // ── PDF 出力 ──
  const title = mode === 'project' ? layoutTitle(projectName, venueName, layout.version) : `${venueName || '会場'} 雛形`;
  const exportPdf = async () => {
    if (!svgRef.current) return;
    setBusy(true);
    setSel(null);
    try {
      await downloadSvgAsPdf(svgRef.current, `${title.replace(/[\\/:*?"<>|｜\s]+/g, '_')}.pdf`);
      // 出力した版を「発行済み」にする。以後の編集は自動で次の版（V+1）になる
      if (mode === 'project') onChange(markIssued(layout, localDate()));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'PDF 出力に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  /** 図面サイズの確定（最小 100cm）。空欄は取り消し扱い。値が変わらなければ何もしない（履歴や版を無駄に進めない） */
  const setSize = (key: 'width' | 'height', v: string) => {
    if (v.trim() === '') return;
    const n = Math.max(100, n0(v));
    if (Number.isFinite(n) && n !== layout[key]) commit({ ...layout, [key]: n });
  };

  const selItem = sel?.type === 'item' ? layout.items.find((i) => i.id === sel.primary) : undefined;
  const selGroup = selItem?.groupId ? layout.groups.find((g) => g.id === selItem.groupId) : undefined;
  const partWarn = (id: string) => warnings.find((w) => w.target === `part:${id}`)?.message;
  const layoutWarnings = warnings.filter((w) => /^(part|item|layout):/.test(w.target));

  const envCols: Col<EnvElement>[] = [
    { key: 'kind', title: '種別', width: 80, get: (e) => KIND_LABEL[e.kind] },
    { key: 'label', title: '表示名', width: 150, get: (e) => e.label.replace(/\n/g, '｜'), set: (e, v) => ({ ...e, label: v.replace(/｜/g, '\n') }) },
    { key: 'sublabel', title: '補足', width: 150, get: (e) => e.sublabel ?? '', set: (e, v) => ({ ...e, sublabel: v }) },
    { key: 'x', title: 'X', width: 64, type: 'number', get: (e) => e.x, set: (e, v) => ({ ...e, x: n0(v) }) },
    { key: 'y', title: 'Y', width: 64, type: 'number', get: (e) => e.y, set: (e, v) => ({ ...e, y: n0(v) }) },
    { key: 'w', title: '幅', width: 64, type: 'number', get: (e) => e.w, set: (e, v) => ({ ...e, w: n0(v) }), warn: (e) => (e.w <= 0 ? '幅が 0 以下です' : undefined) },
    { key: 'h', title: '奥行', width: 64, type: 'number', get: (e) => e.h, set: (e, v) => ({ ...e, h: n0(v) }), warn: (e) => (e.h <= 0 ? '奥行が 0 以下です' : undefined) },
    {
      key: 'tone', title: '色', width: 76, type: 'select', get: (e) => e.tone ?? '',
      options: [{ value: 'gray', label: 'グレー' }, { value: 'purple', label: '紫' }, { value: 'green', label: '緑' }, { value: 'orange', label: '橙/茶' }],
      set: (e, v) => ({ ...e, tone: (v || undefined) as EnvElement['tone'] }),
    },
    {
      key: 'dir', title: '矢印', width: 64, type: 'select', get: (e) => (e.kind === 'entrance' ? e.dir ?? 'left' : ''),
      options: [{ value: 'left', label: '←' }, { value: 'right', label: '→' }, { value: 'up', label: '↑' }, { value: 'down', label: '↓' }],
      set: (e, v) => ({ ...e, dir: (v || undefined) as EnvElement['dir'] }),
    },
  ];

  return (
    <div className="editor" tabIndex={0} onKeyDown={onKey}>
      <div className="toolbar">
        {mode === 'project' && (
          <div className="seg">
            <button className={layer === 'parts' ? 'is-on' : ''} onClick={() => { setLayer('parts'); setSel(null); }}>パーツ配置</button>
            <button className={layer === 'env' ? 'is-on' : ''} onClick={() => { setLayer('env'); setSel(null); }}>周辺環境（雛形）</button>
          </div>
        )}
        <label className="toolbar__item">吸着
          <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
            <option value={0}>なし</option><option value={5}>5cm</option><option value={10}>10cm</option><option value={50}>50cm</option>
          </select>
        </label>
        <button onClick={undo} disabled={history.current.length === 0} title="Ctrl+Z">↩ 元に戻す</button>
        <span className="toolbar__spacer" />
        {mode === 'project' && (
          <>
            <span className="toolbar__ver">
              現在の版 <b>V{layout.version}</b>{isIssued(layout) ? '（出力済み・編集すると V' + nextVersion(layout) + ' になります）' : '（未出力）'}
            </span>
            <button className="primary" onClick={exportPdf} disabled={busy}>{busy ? '出力中…' : `PDF ダウンロード（V${layout.version}）`}</button>
          </>
        )}
      </div>

      <div className="editor__body">
        <aside className="editor__side">
          {layer === 'parts' ? (
            <>
              <table className="grid">
                <thead><tr><th className="grid__corner" /><th>定型パーツ</th><th style={{ width: 74 }}>サイズ(cm)</th><th style={{ width: 96 }}>個数</th></tr></thead>
                <tbody>
                  {partTypes.map((pt, i) => {
                    const c = counts.get(pt.id) ?? 0;
                    const warn = partWarn(pt.id);
                    return (
                      <tr key={pt.id}>
                        <th className="grid__rownum">{i + 1}</th>
                        <td className="is-ro"><div className="grid__ro">{pt.name}</div></td>
                        <td className="is-ro"><div className="grid__ro" style={{ textAlign: 'right' }}>{pt.widthCm}×{pt.depthCm}</div></td>
                        <td className={warn ? 'is-warn' : ''} title={warn}>
                          <div className="stepper">
                            <button onClick={() => commit(removeLastPart(layout, pt.id))} disabled={c === 0} aria-label={`${pt.name}を減らす`}>−</button>
                            <span data-testid={`count-${pt.id}`}>{c}</span>
                            <button onClick={() => commit(addPart(layout, pt))} aria-label={`${pt.name}を増やす`}>＋</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <table className="grid" style={{ marginTop: 10 }}>
                <thead><tr><th className="grid__corner" /><th>組み合わせ配置</th><th style={{ width: 74 }}>構成</th><th style={{ width: 96 }} /></tr></thead>
                <tbody>
                  {composites.map((cp, i) => (
                    <tr key={cp.id}>
                      <th className="grid__rownum">{i + 1}</th>
                      <td className="is-ro"><div className="grid__ro">{cp.name}</div></td>
                      <td className="is-ro"><div className="grid__ro" style={{ textAlign: 'right' }}>{cp.members.length}台</div></td>
                      <td><button className="cellbtn cellbtn--wide" onClick={() => commit(addComposite(layout, cp, partTypes))}>＋ 配置</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="panel panel--sel">
                <div className="panel__title">選択中のパーツ</div>
                {selItem ? (
                  <>
                    <div className="panel__row">{partTypes.find((t) => t.id === selItem.partTypeId)?.name ?? '（削除済みの種別）'}
                      {selGroup && <span className="tag">グループ: {selGroup.name}</span>}</div>
                    <label className="panel__row">表示名
                      <input
                        value={(selItem.label ?? '').replace(/\n/g, '｜')} placeholder="空欄＝自動（番号）"
                        onChange={(e) => commit(updateItem(layout, selItem.id, { label: e.target.value.replace(/｜/g, '\n') || undefined }))}
                      />
                    </label>
                    <div className="panel__row">
                      位置 X {Math.round(selItem.x)} / Y {Math.round(selItem.y)}・
                      {(() => { const s = itemSize(selItem, partTypes.find((t) => t.id === selItem.partTypeId)); return `${s.w}×${s.h}cm`; })()}
                    </div>
                    <div className="panel__btns">
                      <button onClick={() => commit(rotateItem(layout, selItem.id, partTypes))}>⟳ 90°回転</button>
                      {selGroup && <button onClick={() => { commit(ungroup(layout, selGroup.id)); setSel(null); }}>グループ解除</button>}
                      <button onClick={() => commit(removeItems(layout, [selItem.id]))}>削除</button>
                      {selGroup && <button onClick={() => commit(removeItems(layout, layout.items.filter((i) => i.groupId === selGroup.id).map((i) => i.id)))}>グループごと削除</button>}
                    </div>
                  </>
                ) : <div className="panel__hint">図面上のパーツをクリックすると選択、ドラッグで移動できます。表示名の改行は「｜」。</div>}
              </div>
            </>
          ) : (
            <div className="panel">
              <div className="panel__title">周辺環境を追加</div>
              <div className="panel__btns">
                {ENV_KINDS.map((k) => <button key={k.kind} onClick={() => commit(addEnv(layout, k.kind))}>＋ {k.label}</button>)}
              </div>
              {/* 1 文字ごとに反映すると途中の値（1→12→120…）で図面が作り直されて打てないため、Enter か欄を離れた時に確定する */}
              <label className="panel__row">図面サイズ(cm) 幅
                <NumInput value={String(layout.width)} commitOnBlur onValue={(v) => setSize('width', v)} />
              </label>
              <label className="panel__row">図面サイズ(cm) 高さ
                <NumInput value={String(layout.height)} commitOnBlur onValue={(v) => setSize('height', v)} />
              </label>
              {mode === 'project' && (
                <div className="panel__btns">
                  {onReloadTemplate && <button onClick={onReloadTemplate}>会場雛形を読み込み直す</button>}
                  {onSaveAsTemplate && <button onClick={onSaveAsTemplate}>この周辺環境を会場雛形として保存</button>}
                </div>
              )}
              <div className="panel__hint">下の表で名称・位置・サイズを編集できます。図面上でドラッグしても動かせます。上にある行ほど奥に描かれます。</div>
            </div>
          )}

          {mode === 'project' && (
            <div className="panel">
              <div className="panel__title">タイトル下の注記</div>
              <input className="full" value={layout.caption} onChange={(e) => commit({ ...layout, caption: e.target.value })} />
              <div className="panel__title" style={{ marginTop: 8 }}>未確認事項（1行に1項目）</div>
              <textarea
                className="full" rows={4} value={layout.notes} placeholder="例: 通路幅の実寸"
                onChange={(e) => commit({ ...layout, notes: e.target.value })}
              />
              {layout.issued.length > 0 && (
                <div className="panel__hint">出力履歴: {layout.issued.map((v) => `V${v.version}（${v.issuedAt}）`).join('、')}</div>
              )}
            </div>
          )}
        </aside>

        <div className="editor__canvas" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {layoutWarnings.length > 0 && (
            <ul className="warnlist">{layoutWarnings.map((w, i) => <li key={i} className={`warnlist__${w.severity}`}>⚠ {w.message}</li>)}</ul>
          )}
          <LayoutSvg
            ref={svgRef} layout={shown} partTypes={partTypes} title={title}
            stamp={mode === 'project' ? `作成日 ${localDate()}` : undefined}
            selectedItemIds={sel?.type === 'item' ? sel.ids : []}
            selectedEnvId={sel?.type === 'env' ? sel.id : null}
            onItemDown={layer === 'parts' ? onItemDown : undefined} onEnvDown={layer === 'env' ? onEnvDown : undefined} onBackgroundDown={() => setSel(null)}
            gridCm={grid >= 50 ? grid : 0}
          />
        </div>
      </div>

      {layer === 'env' && (
        <div className="editor__envgrid">
          <Grid
            rows={layout.env} cols={envCols} rowKey={(e) => e.id} deletable
            onChange={(rows) => commit({ ...layout, env: rows })}
            selectedKey={sel?.type === 'env' ? sel.id : undefined}
            onSelect={(e) => setSel({ type: 'env', id: e.id })}
            emptyText="周辺環境がありません。上の「＋」ボタンで追加してください"
          />
        </div>
      )}
    </div>
  );
}
