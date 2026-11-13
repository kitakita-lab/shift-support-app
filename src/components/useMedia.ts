// 画面の幅などの条件（メディアクエリ）に合っているかを返す。合う・合わないが変わったら描き直す。
import { useEffect, useState } from 'react';

/** スマホ幅（案件一覧をカード表示にする、など） */
export const PHONE = '(max-width: 700px)';

export function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(query);
    const update = () => setOn(m.matches);
    update();
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, [query]);
  return on;
}
