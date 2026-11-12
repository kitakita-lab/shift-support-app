// 配置図の描画。エディタ画面と PDF 出力で同じ SVG を使う（見たままが出力される）。
// 座標の単位は cm。タイトル帯（上）と未確認事項欄（下）は図面領域の外に足す。
//
// 図は「図のモデル」（domain/figure.ts）だけを見て描く。レイアウトやマスタを直接は見ない。
// モデルに無いものは図に出ないので、モデルから取った指紋が同じなら、図も同じになる（版の判定の前提）。
// モデルの外から受け取るのは、版番号・作成日・編集用の表示（選択枠・補助グリッド）だけ。
import { forwardRef, PointerEvent } from 'react';
import { FigureEnv, FigureItem, FigureModel, figureTitle } from '../domain/figure';
import { Dir, PartType, Tone } from '../types';

/** タイトル帯の高さ。会期の行があるときは、その分だけ広げる */
export const headHeight = (hasPeriod: boolean) => (hasPeriod ? 128 : 100);
const FONT = "'Hiragino Sans','Noto Sans JP','Yu Gothic','Meiryo','IPAPGothic',sans-serif";

const TONES: Record<Tone, { fill: string; stroke: string; text: string }> = {
  gray:   { fill: '#e9ecf2', stroke: '#a9b4c4', text: '#22403a' },
  purple: { fill: '#ebe3f3', stroke: '#a48fc4', text: '#5d4a7a' },
  green:  { fill: '#dfeccf', stroke: '#8fb277', text: '#2f4a25' },
  orange: { fill: '#f6dcc8', stroke: '#c9966b', text: '#5a4630' },
};
const INK = '#22403a';
const GREEN = '#1f8a5f';
const BROWN = '#9a7b4f';

/** 制作席以外の椅子（商談席・待合など）。制作席（青）と見分けられるよう、灰色にする */
const CHAIR_OTHER = { fill: '#e6e6e6', stroke: '#9a9a9a', rx: 9, text: '#555555' };
const PART_STYLE: Record<PartType['category'], { fill: string; stroke: string; rx: number; text: string }> = {
  table:     { fill: '#e8c49c', stroke: '#a67c52', rx: 3, text: '#5a4630' },
  chair:     { fill: '#b9d3ec', stroke: '#6b8fb3', rx: 9, text: '#33506e' },
  banner:    { fill: '#ffffff', stroke: '#9a9485', rx: 2, text: '#333333' },
  pop:       { fill: '#ffffff', stroke: '#9a9485', rx: 2, text: '#333333' },
  display:   { fill: '#f6dcc8', stroke: '#c9966b', rx: 7, text: '#22403a' },
  partition: { fill: '#f0e8f6', stroke: '#a48fc4', rx: 4, text: '#22403a' },
  other:     { fill: '#dfeccf', stroke: '#8fb277', rx: 7, text: '#22403a' },
};

function Lines({ x, y, lines, size, weight, fill, sub }: {
  x: number; y: number; lines: string[]; size: number; weight?: number; fill: string; sub?: number;
}) {
  // 複数行を (x, y) を中心に縦に並べる。2行目以降は sub サイズ（未指定なら同じ）
  const sizes = lines.map((_, i) => (i === 0 ? size : sub ?? size));
  const total = sizes.reduce((s, v) => s + v * 1.3, 0);
  let cy = y - total / 2;
  return (
    <text textAnchor="middle" fill={fill} fontFamily={FONT} style={{ pointerEvents: 'none' }}>
      {lines.map((l, i) => {
        const s = sizes[i];
        cy += s * 1.3;
        return <tspan key={i} x={x} y={cy - s * 0.35} fontSize={s} fontWeight={i === 0 ? weight : 400}>{l}</tspan>;
      })}
    </text>
  );
}

function Arrow({ x, y, dir, len = 40 }: { x: number; y: number; dir: Dir; len?: number }) {
  // (x, y) を矢印の中心とし、dir の向きに先端を向ける
  const rot = { right: 0, down: 90, left: 180, up: 270 }[dir];
  const h = len / 2;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`} stroke={GREEN} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={`M${-h} 0 H${h} M${h - 12} -11 L${h} 0 L${h - 12} 11`} />
    </g>
  );
}

function Env({ e, selected, onDown }: { e: FigureEnv; selected: boolean; onDown?: (ev: PointerEvent, id: string) => void }) {
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
  const lines = e.label ? e.label.split('\n') : [];
  let body: JSX.Element;
  switch (e.kind) {
    case 'passage':
      body = <><rect x={e.x} y={e.y} width={e.w} height={e.h} fill="#f4efe4" />
        {lines.length > 0 && <Lines x={cx} y={cy} lines={lines} size={20} weight={700} fill={BROWN} />}</>;
      break;
    case 'booth':
      body = <><rect x={e.x} y={e.y} width={e.w} height={e.h} rx={4} fill="#eef5ee" stroke="#7d9a8c" strokeWidth={2.5} />
        {lines.length > 0 && <Lines x={cx} y={e.y + 24} lines={lines} size={16} fill={INK} />}</>;
      break;
    case 'wall': {
      const fill = e.tone === 'orange' ? '#cc8a45' : '#5d6f6a';
      const horizontal = e.w >= e.h;
      body = <><rect x={e.x} y={e.y} width={e.w} height={e.h} fill={fill} />
        {lines.length > 0 && (horizontal
          ? <Lines x={cx} y={e.y - 13} lines={lines} size={16} fill="#333" />
          : <Lines x={e.x - 14} y={cy} lines={lines} size={16} fill="#333" />)}</>;
      break;
    }
    case 'shop': {
      const t = TONES[e.tone ?? 'gray'];
      const longest = Math.max(1, ...lines.map((l) => l.length));
      const big = Math.min(26, Math.max(12, Math.min((e.w - 12) / (longest * 1.05), e.h / 3)));
      const all = [...lines, ...(e.sublabel ? e.sublabel.split('／') : [])];
      body = <><rect x={e.x} y={e.y} width={e.w} height={e.h} rx={9} fill={t.fill} stroke={t.stroke} strokeWidth={2} />
        <text textAnchor="middle" fontFamily={FONT} fill={t.text} style={{ pointerEvents: 'none' }}>
          {all.map((l, i) => {
            const isMain = i < lines.length;
            const off = (i - (all.length - 1) / 2) * big * 1.25;
            return <tspan key={i} x={cx} y={cy + off + big * 0.35} fontSize={isMain ? big : Math.max(11, big * 0.62)} fontWeight={isMain ? 700 : 400}>{l}</tspan>;
          })}
        </text></>;
      break;
    }
    case 'entrance': {
      const dir = e.dir ?? 'left';
      const gap = 45;
      const a = { left: [e.x - gap, cy], right: [e.x + e.w + gap, cy], up: [cx, e.y - gap], down: [cx, e.y + e.h + gap] }[dir];
      // ラベルは矢印の反対側
      const l = { left: [e.x + e.w + 12, cy, 'start'], right: [e.x - 12, cy, 'end'], up: [cx, e.y + e.h + 30, 'middle'], down: [cx, e.y - 14, 'middle'] }[dir] as [number, number, 'start' | 'end' | 'middle'];
      body = <><rect x={e.x} y={e.y} width={e.w} height={e.h} fill="#cc8a45" />
        <Arrow x={a[0]} y={a[1]} dir={dir} />
        {e.label && <text x={l[0]} y={l[1] + 6} textAnchor={l[2]} fontSize={18} fontWeight={700} fill={GREEN} fontFamily={FONT} style={{ pointerEvents: 'none' }}>{e.label}</text>}</>;
      break;
    }
    case 'stairs': {
      const n = Math.max(3, Math.floor(e.w / 22));
      body = <><rect x={e.x} y={e.y} width={e.w} height={e.h} rx={6} fill="#e3e8f0" stroke="#a9b4c4" strokeWidth={2} />
        {Array.from({ length: n }, (_, i) => {
          const x = e.x + ((i + 1) * e.w) / (n + 1);
          return <line key={i} x1={x} y1={e.y + 12} x2={x} y2={e.y + e.h * 0.55} stroke="#a9b4c4" strokeWidth={1.5} />;
        })}
        {lines.length > 0 && <Lines x={cx} y={e.y + e.h * 0.8} lines={lines} size={16} fill="#333" />}</>;
      break;
    }
    default: {
      const size = Math.min(26, Math.max(12, e.h * 0.72));
      const fill = e.tone === 'orange' ? BROWN : e.tone === 'green' ? GREEN : e.tone === 'purple' ? '#5d4a7a' : '#333';
      body = <><rect x={e.x} y={e.y} width={e.w} height={e.h} fill="transparent" />
        <Lines x={cx} y={cy} lines={lines.length ? lines : ['']} size={size} weight={size >= 20 ? 700 : 400} fill={fill} /></>;
    }
  }
  return (
    <g onPointerDown={onDown ? (ev) => onDown(ev, e.id) : undefined} style={onDown ? { cursor: 'move' } : { pointerEvents: 'none' }}>
      {body}
      {selected && <rect x={e.x - 4} y={e.y - 4} width={e.w + 8} height={e.h + 8} data-noexport="1" fill="none" stroke="#1a73e8" strokeWidth={2.5} strokeDasharray="8 5" />}
    </g>
  );
}

function Item({ it, selected, onDown }: {
  it: FigureItem; selected: boolean;
  onDown?: (ev: PointerEvent, id: string) => void;
}) {
  const s = { w: it.w, h: it.h };
  const cat = it.category;
  const st = cat === 'chair' && it.role === 'other' ? CHAIR_OTHER : PART_STYLE[cat];
  const cx = it.x + s.w / 2, cy = it.y + s.h / 2;
  const lines = it.label ? it.label.split('\n') : [];
  const framed = cat === 'banner' || cat === 'pop';
  // 枠に収まる文字サイズ（最長行の文字数から概算）
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const fit = Math.min(s.w / (longest * 0.95), (s.h * 0.8) / Math.max(1, lines.length) / 1.3);
  const size = Math.max(9, Math.min(cat === 'table' ? 15 : 17, fit));
  const labelAbove = cat === 'pop';
  return (
    <g onPointerDown={onDown ? (ev) => onDown(ev, it.id) : undefined} style={onDown ? { cursor: 'move' } : { pointerEvents: 'none' }}>
      <rect x={it.x} y={it.y} width={s.w} height={s.h} rx={Math.min(st.rx, s.w / 2, s.h / 2)} fill={it.known ? st.fill : '#eee'} stroke={it.known ? st.stroke : '#c00'} strokeWidth={1.8} strokeDasharray={it.known ? undefined : '6 4'} />
      {framed && <rect x={it.x + 5} y={it.y + 5} width={Math.max(0, s.w - 10)} height={Math.max(0, s.h - 10)} fill="#f3f0ea" stroke="#d8d2c4" strokeWidth={1} />}
      {lines.length > 0 && (labelAbove
        ? <Lines x={cx} y={it.y - 11} lines={[lines.join(' ')]} size={13} fill="#333" />
        : <Lines x={cx} y={cy} lines={lines} size={size} sub={Math.max(9, size * 0.8)} weight={cat === 'table' || framed ? 400 : 700} fill={st.text} />)}
      {selected && <rect x={it.x - 4} y={it.y - 4} width={s.w + 8} height={s.h + 8} data-noexport="1" fill="none" stroke="#1a73e8" strokeWidth={2.5} strokeDasharray="8 5" />}
    </g>
  );
}

interface Props {
  /** 図に描く内容（domain/figure.ts の figureModel で作る） */
  model: FigureModel;
  /** タイトルに入れる版番号（雛形では使わない） */
  version?: number;
  /** 右上に小さく入れる情報（例: 作成日） */
  stamp?: string;
  selectedItemIds?: string[];
  selectedEnvId?: string | null;
  onItemDown?: (ev: PointerEvent, id: string) => void;
  onEnvDown?: (ev: PointerEvent, id: string) => void;
  onBackgroundDown?: () => void;
  /** 編集中だけ表示する補助グリッドの間隔（cm）。0 で非表示。出力には含めない */
  gridCm?: number;
}

const LayoutSvg = forwardRef<SVGSVGElement, Props>(function LayoutSvg(
  { model, version = 1, stamp, selectedItemIds = [], selectedEnvId, onItemDown, onEnvDown, onBackgroundDown, gridCm = 0 },
  ref,
) {
  const notes = model.notes;
  const foot = notes.length > 0 ? 50 + notes.length * 24 : 30;
  const sel = new Set(selectedItemIds);
  const W = model.width, H = model.height;
  const HEAD = headHeight(!!model.period);

  return (
    <svg
      ref={ref}
      viewBox={`0 ${-HEAD} ${W} ${H + HEAD + foot}`}
      className="layout-svg"
      fontFamily={FONT}
      style={{ touchAction: 'none', userSelect: 'none' }}
    >
      <rect x={0} y={-HEAD} width={W} height={H + HEAD + foot} fill="#faf9f6" onPointerDown={onBackgroundDown} />
      <text x={W / 2} y={-HEAD + 48} textAnchor="middle" fontSize={36} fontWeight={700} fill={INK}>{figureTitle(model, version)}</text>
      {model.period && <text x={W / 2} y={-HEAD + 80} textAnchor="middle" fontSize={21} fontWeight={700} fill={INK} data-testid="figure-period">会期 {model.period}</text>}
      {model.caption && <text x={W / 2} y={-HEAD + (model.period ? 110 : 82)} textAnchor="middle" fontSize={18} fill="#555">{model.caption}</text>}

      {gridCm > 0 && (
        <g data-noexport="1" stroke="#000" strokeOpacity={0.06} strokeWidth={1} style={{ pointerEvents: 'none' }}>
          {Array.from({ length: Math.floor(W / gridCm) }, (_, i) => <line key={`v${i}`} x1={(i + 1) * gridCm} y1={0} x2={(i + 1) * gridCm} y2={H} />)}
          {Array.from({ length: Math.floor(H / gridCm) }, (_, i) => <line key={`h${i}`} x1={0} y1={(i + 1) * gridCm} x2={W} y2={(i + 1) * gridCm} />)}
        </g>
      )}

      {model.env.map((e) => <Env key={e.id} e={e} selected={selectedEnvId === e.id} onDown={onEnvDown} />)}
      {model.items.map((it) => <Item key={it.id} it={it} selected={sel.has(it.id)} onDown={onItemDown} />)}
      {model.groups.map((g) => (
        <g key={g.groupId} style={{ pointerEvents: 'none' }}>
          <text x={g.x} y={g.y} textAnchor="middle" fontSize={22} fontWeight={700} fill={INK}>{g.title}</text>
          {g.subtitle && <text x={g.x} y={g.y + 22} textAnchor="middle" fontSize={14} fill="#333">{g.subtitle}</text>}
        </g>
      ))}

      {notes.length > 0 && (
        <g>
          <rect x={20} y={H + 8} width={W - 40} height={foot - 16} rx={6} fill="#fffbe6" stroke="#e0c96a" strokeWidth={1.5} />
          <text x={36} y={H + 34} fontSize={17} fontWeight={700} fill="#7a5d00">未確認事項（要確認）</text>
          {notes.map((n, i) => <text key={i} x={44} y={H + 58 + i * 24} fontSize={16} fill="#333">・{n}</text>)}
        </g>
      )}
      {stamp && <text x={W - 16} y={-HEAD + 22} textAnchor="end" fontSize={13} fill="#777">{stamp}</text>}
    </svg>
  );
});

export default LayoutSvg;
