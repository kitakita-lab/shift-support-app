// 表計算風の編集グリッド。セルは常時編集可能で、Enter で下のセルへ移動する。
// 入力チェックは「禁止せず警告」: warn が文字列を返したセルを黄色くし、理由をツールチップと ⚠ で示す。
import { KeyboardEvent, ReactNode } from 'react';
import NumInput from './NumInput';

export interface Option { value: string; label: string }

export interface Col<R> {
  key: string;
  title: string;
  width?: number;
  type?: 'text' | 'number' | 'select' | 'date' | 'time' | 'readonly';
  options?: Option[];
  get: (row: R) => string | number | null | undefined;
  /** 入力値（文字列）から新しい行を作る。未指定なら読み取り専用 */
  set?: (row: R, value: string) => R;
  /** 行によって編集できない場合に false を返す（その行は値の表示だけになる）。未指定なら全行で編集可 */
  editable?: (row: R) => boolean;
  align?: 'left' | 'right' | 'center';
  /** 警告メッセージ（あればセルを黄色表示） */
  warn?: (row: R) => string | undefined;
  placeholder?: (row: R) => string;
}

interface Props<R> {
  rows: R[];
  cols: Col<R>[];
  rowKey: (row: R) => string;
  onChange?: (rows: R[]) => void;
  /** 指定すると「＋行を追加」が出る */
  onAdd?: () => void;
  addLabel?: string;
  /** 行削除を許可 */
  deletable?: boolean;
  /** 行末の追加操作（編集ボタン等） */
  rowActions?: (row: R) => ReactNode;
  /** 合計行など。cols と同じ数のセル内容 */
  footer?: (ReactNode | null)[];
  selectedKey?: string;
  onSelect?: (row: R) => void;
  emptyText?: string;
}

function onKey(e: KeyboardEvent<HTMLElement>) {
  // 日本語入力の変換を確定する Enter ではセルを移動しない
  // （ブラウザによっては確定の Enter も key === 'Enter' で届く。変換中は isComposing が true、または keyCode が 229）
  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  const el = e.currentTarget;
  const r = Number(el.dataset.r), c = el.dataset.c;
  const next = el.closest('table')?.querySelector<HTMLElement>(`[data-r="${r + (e.shiftKey ? -1 : 1)}"][data-c="${c}"]`);
  if (next) { e.preventDefault(); next.focus(); }
}

export default function Grid<R>({
  rows, cols, rowKey, onChange, onAdd, addLabel = '＋ 行を追加', deletable, rowActions, footer,
  selectedKey, onSelect, emptyText,
}: Props<R>) {
  const hasTail = deletable || !!rowActions;
  const setCell = (ri: number, col: Col<R>, v: string) => {
    if (!onChange || !col.set) return;
    onChange(rows.map((row, i) => (i === ri ? col.set!(row, v) : row)));
  };

  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="grid__corner" />
            {cols.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width, minWidth: c.width } : undefined}>{c.title}</th>
            ))}
            {hasTail && <th className="grid__tail" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const k = rowKey(row);
            return (
              <tr key={k} className={selectedKey === k ? 'is-selected' : undefined} onClick={onSelect ? () => onSelect(row) : undefined}>
                <th className="grid__rownum">{ri + 1}</th>
                {cols.map((c) => {
                  const raw = c.get(row);
                  const val = raw == null ? '' : String(raw);
                  const warn = c.warn?.(row);
                  const align = c.align ?? (c.type === 'number' ? 'right' : 'left');
                  const common = {
                    'data-r': ri, 'data-c': c.key, onKeyDown: onKey,
                    style: { textAlign: align } as const,
                  };
                  const editable = !!c.set && !!onChange && c.type !== 'readonly' && (c.editable?.(row) ?? true);
                  return (
                    <td key={c.key} className={`${warn ? 'is-warn' : ''}${editable ? '' : ' is-ro'}`} title={warn}>
                      {!editable ? (
                        <div className="grid__ro" style={{ textAlign: align }}>{val}</div>
                      ) : c.type === 'select' ? (
                        <select {...common} value={val} onChange={(e) => setCell(ri, c, e.target.value)}>
                          <option value="">（選択）</option>
                          {/* マスタから消えた値も消さずに見せる */}
                          {val && !c.options?.some((o) => o.value === val) && <option value={val}>（削除済み）</option>}
                          {c.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : c.type === 'number' ? (
                        <NumInput
                          {...common}
                          value={val}
                          placeholder={c.placeholder?.(row)}
                          // 空欄にすると 0 になる列（＝空欄と 0 が同じ意味）だけ、フォーカス中は 0 を空欄で見せる。
                          // 空欄が「マスタの値を使う」を意味する上書き列（時給・交通費・参加費）は 0 をそのまま見せる
                          blankIsZero={c.get(c.set!(row, '')) === 0}
                          onValue={(v) => setCell(ri, c, v)}
                        />
                      ) : (
                        <input
                          {...common}
                          type={c.type ?? 'text'}
                          value={val}
                          placeholder={c.placeholder?.(row)}
                          onChange={(e) => setCell(ri, c, e.target.value)}
                        />
                      )}
                      {warn && <span className="grid__warnmark" aria-label={warn}>⚠</span>}
                    </td>
                  );
                })}
                {hasTail && (
                  <td className="grid__tail">
                    {rowActions?.(row)}
                    {deletable && onChange && (
                      <button
                        className="cellbtn" title="この行を削除"
                        onClick={(e) => { e.stopPropagation(); onChange(rows.filter((_, i) => i !== ri)); }}
                      >×</button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><th className="grid__rownum" /><td className="grid__empty" colSpan={cols.length + (hasTail ? 1 : 0)}>{emptyText ?? 'データがありません'}</td></tr>
          )}
        </tbody>
        {footer && (
          <tfoot>
            <tr>
              <th className="grid__rownum">計</th>
              {footer.map((f, i) => <td key={i} style={{ textAlign: cols[i]?.align ?? (cols[i]?.type === 'number' ? 'right' : 'left') }}>{f}</td>)}
              {hasTail && <td className="grid__tail" />}
            </tr>
          </tfoot>
        )}
      </table>
      {onAdd && <button className="grid__add" onClick={onAdd}>{addLabel}</button>}
    </div>
  );
}

/** 数値セル用: 空文字は 0 */
export const n0 = (v: string): number => (v === '' ? 0 : Number(v));
/** 上書き値セル用: 空文字は null（マスタの値を使う） */
export const nNull = (v: string): number | null => (v === '' ? null : Number(v));
