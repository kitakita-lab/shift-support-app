// 数値の入力欄。表計算のセルのように「クリックして打てば、その数字に置き換わる」ようにする。
// <input type="number"> をそのまま使うと、次のような入力事故が起きるため塞いである（実機確認前の検証で再現）:
//   - 0 が入っている欄をクリックして 120 と打つと 1200 になる（カーソルが 0 の前に入り、0 が後ろに残る）
//   - 欄の右端（スピンボタン）のクリック、↑↓ キー、ホイールで、値が勝手に ±1 される
//   - 「-」から打ち始めると符号が消える／1 文字打つごとに値が補正されて打てない欄がある
import { InputHTMLAttributes, useRef, useState } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  /** 表示する値（文字列）。'' は空欄 */
  value: string;
  /** 入力した文字列を渡す。既定では 1 文字ごと、commitOnBlur のときは確定時（Enter・フォーカスを外す）に 1 回 */
  onValue: (v: string) => void;
  /** 空欄と 0 が同じ意味の欄。フォーカス中は 0 を空欄で見せ、打った数字の後ろに 0 が残らないようにする */
  blankIsZero?: boolean;
  /** 入力途中の値を反映すると困る欄（図面サイズなど）は、確定したときだけ反映する。何も打たずに離れた場合は何もしない */
  commitOnBlur?: boolean;
};

export default function NumInput({
  value, onValue, blankIsZero, commitOnBlur, onFocus, onBlur, onKeyDown, onMouseDown, ...rest
}: Props) {
  const [focused, setFocused] = useState(false);
  // 利用者が打った文字列（打つまでは null）。"-" や "1." のような入力途中の状態を壊さないために、そのまま持つ
  const [draft, setDraft] = useState<string | null>(null);
  // いまのマウスの押下でフォーカスが入ったか（すでにフォーカスのある欄を押したのなら、カーソルを置きたいだけ）
  const pressFocus = useRef(false);

  // 打つまでは元の値を見せる（フォーカス中に他から値が変われば追従する）
  const shown = draft ?? (focused && blankIsZero && value !== '' && Number(value) === 0 ? '' : value);

  return (
    <input
      {...rest}
      type="number"
      value={shown}
      onMouseDown={(e) => {
        pressFocus.current = document.activeElement !== e.currentTarget;
        onMouseDown?.(e);
      }}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
        onFocus?.(e);
      }}
      onMouseUp={(e) => {
        // クリックでフォーカスした直後の mouseup で全選択が外れるブラウザがあるため、そのときだけ選び直す
        if (!pressFocus.current) return;
        pressFocus.current = false;
        e.preventDefault();
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        if (!commitOnBlur) onValue(e.target.value);
      }}
      onBlur={(e) => {
        if (commitOnBlur && draft != null) onValue(draft);
        setDraft(null);
        setFocused(false);
        pressFocus.current = false;
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        // ↑↓ で値が ±1 されるのを止める（表計算のつもりで押すと、気づかないうちに数字が変わるため）
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
        if (commitOnBlur && e.key === 'Enter') e.currentTarget.blur();
        onKeyDown?.(e);
      }}
      // フォーカス中にホイールを回すと値が変わるブラウザがあるため、フォーカスを外してページのスクロールに任せる
      onWheel={(e) => e.currentTarget.blur()}
    />
  );
}
