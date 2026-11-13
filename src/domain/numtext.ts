// 数値の入力欄（components/NumInput.tsx）に打たれた文字列の扱い（純関数）。
// 入力欄は type="text" にしてある（スマホで桁の選択・削除が素直に効き、全角で打った数字も受け取れるようにするため）。
// その代わり、数字以外の文字が入りうるので、ここで「数値の表記」にそろえる。

/** マイナス記号として打たれることがある文字（全角のマイナス・長音・ダッシュなど）。先頭にあるときだけマイナスとして扱う */
const MINUS_LIKE = /[−ー―‐‑‒–—ｰ]/g;

/**
 * 打たれた文字列を、半角の数値の表記にそろえる。入力の途中の形（"-"・"1."・".5"）は、そのまま残す。
 *   - 全角の数字・小数点・マイナスは半角にする（日本語入力のまま打った数字を受け取る）
 *   - 桁区切りのカンマ・空白は取り除く
 *   - 数字・小数点・先頭のマイナス以外の文字は取り除く。小数点は最初の 1 つだけ残す
 */
export function normalizeNumText(raw: string): string {
  const s = String(raw ?? '')
    .normalize('NFKC')
    .replace(/。/g, '.')
    .replace(MINUS_LIKE, '-');
  let out = '';
  let dot = false;
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '.' && !dot) { out += ch; dot = true; }
    else if (ch === '-' && out === '') out += ch;
  }
  return out;
}

/**
 * 入力欄の文字列から、値として渡す文字列を作る。数値として読めるならそろえた表記（例: "0120"・"1."・"-5"）、
 * 読めない（空・"-" だけ・"." だけ）なら ''（空欄）。受け取る側は Number() で数値にする。
 */
export function numTextValue(raw: string): string {
  const t = normalizeNumText(raw);
  if (!/\d/.test(t)) return '';
  return Number.isFinite(Number(t)) ? t : '';
}
