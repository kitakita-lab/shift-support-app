// 数値の入力欄。
//
// PC（マウス・キーボード）では、表計算のセルのように「クリックして打てば、その数字に置き換わる」ようにする（全選択）。
// スマホ・タブレット（タッチ）では、全選択しない。触れた位置にカーソルが入り、1 桁だけ消して打ち直せる
// （以前はタッチでも全選択していたため、「321 の 1 を消して 0 を打つ」と、見えない全選択のせいで全桁が消えて 0 になった。Issue #87）。
//
// <input type="number"> は使わない。次の入力事故があるため（PC・実機で確認されたもの）:
//   - 0 が入っている欄をクリックして 120 と打つと 1200 になる（カーソルが 0 の前に入り、0 が後ろに残る）
//   - 欄の右端（スピンボタン）のクリック、↑↓ キー、ホイールで、値が勝手に ±1 される
//   - 「-」から打ち始めると符号が消える／1 文字打つごとに値が補正されて打てない欄がある
//   - スマホで、桁の選択・カーソル移動がしにくい／全角で打った数字を受け取れない
// 代わりに type="text" ＋ inputMode="decimal"（スマホでは数字のキーボードが開く）にして、打たれた文字を
// domain/numtext.ts で数値の表記にそろえる。打っている途中の文字列は書き換えない（勝手に確定・補正しない）。
import { InputHTMLAttributes, useRef, useState } from 'react';
import { normalizeNumText, numTextValue } from '../domain/numtext';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  /** 表示する値（文字列）。'' は空欄 */
  value: string;
  /** 入力した値を、数値の表記にそろえた文字列で渡す（数値として読めないときは ''）。既定では 1 文字ごと、commitOnBlur のときは確定時（Enter・フォーカスを外す）に 1 回 */
  onValue: (v: string) => void;
  /** 空欄と 0 が同じ意味の欄。フォーカス中は 0 を空欄で見せ、打った数字の後ろに 0 が残らないようにする */
  blankIsZero?: boolean;
  /** 入力途中の値を反映すると困る欄（図面サイズなど）は、確定したときだけ反映する。何も打たずに離れた場合は何もしない */
  commitOnBlur?: boolean;
};

export default function NumInput({
  value, onValue, blankIsZero, commitOnBlur, onFocus, onBlur, onKeyDown, onPointerDown, onTouchStart, onMouseDown, inputMode, ...rest
}: Props) {
  const [focused, setFocused] = useState(false);
  // 利用者が打った文字列（打つまでは null）。"-" や "1." のような入力途中の状態を壊さないために、そのまま持つ
  const [draft, setDraft] = useState<string | null>(null);
  // 日本語入力の変換中か（変換中の文字列は、確定するまで書き換えない）
  const composing = useRef(false);
  // 直前の押下がタッチ（指・ペン）か。タッチでフォーカスしたときは全選択しない
  const touch = useRef(false);
  // いまのマウスの押下でフォーカスが入ったか（すでにフォーカスのある欄を押したのなら、カーソルを置きたいだけ）
  const pressFocus = useRef(false);

  // 打つまでは元の値を見せる（フォーカス中に他から値が変われば追従する）
  const shown = draft ?? (focused && blankIsZero && value !== '' && Number(value) === 0 ? '' : value);

  const take = (raw: string) => {
    const text = normalizeNumText(raw);
    setDraft(text);
    if (!commitOnBlur) onValue(numTextValue(text));
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode={inputMode ?? 'decimal'}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={shown}
      onPointerDown={(e) => {
        touch.current = e.pointerType === 'touch' || e.pointerType === 'pen';
        onPointerDown?.(e);
      }}
      // ポインターイベントが届かない古いブラウザ向け（タッチであることだけ覚える）
      onTouchStart={(e) => { touch.current = true; onTouchStart?.(e); }}
      onMouseDown={(e) => {
        pressFocus.current = !touch.current && document.activeElement !== e.currentTarget;
        onMouseDown?.(e);
      }}
      onFocus={(e) => {
        setFocused(true);
        if (!touch.current) e.currentTarget.select();
        onFocus?.(e);
      }}
      onMouseUp={(e) => {
        // クリックでフォーカスした直後の mouseup で全選択が外れるブラウザがあるため、そのときだけ選び直す（タッチでは何もしない）
        if (!pressFocus.current) return;
        pressFocus.current = false;
        e.preventDefault();
        e.currentTarget.select();
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => {
        composing.current = false;
        take(e.currentTarget.value);
      }}
      onChange={(e) => {
        // 変換中は、打たれたままを見せる（途中で書き換えると、変換が壊れる）。値は確定したときに渡す
        if (composing.current) { setDraft(e.target.value); return; }
        take(e.target.value);
      }}
      onBlur={(e) => {
        if (commitOnBlur && draft != null) onValue(numTextValue(draft));
        setDraft(null);
        setFocused(false);
        pressFocus.current = false;
        touch.current = false;
        composing.current = false;
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (commitOnBlur && e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) e.currentTarget.blur();
        onKeyDown?.(e);
      }}
    />
  );
}
