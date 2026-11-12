import { describe, expect, it } from 'vitest';
import { MAX_NOTICES, Notice, capNotices } from './notices';

const mk = (n: number, kind: Notice['kind'], from = 0): Notice[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${kind}${from + i}`, kind, text: '', at: from + i }));

describe('お知らせの上限', () => {
  it('上限までは、そのまま残す', () => {
    const list = [...mk(20, 'warn'), ...mk(MAX_NOTICES - 20, 'info')];
    expect(capNotices(list)).toBe(list);
  });
  it('上限を超えたら、古い案内から落とす（警告は残す）', () => {
    const list = [...mk(5, 'info'), ...mk(MAX_NOTICES, 'warn'), ...mk(3, 'info', 100)];
    const out = capNotices(list);
    expect(out).toHaveLength(MAX_NOTICES);
    expect(out.filter((n) => n.kind === 'warn')).toHaveLength(MAX_NOTICES);
  });
  it('案内を落としても、新しい案内は残す', () => {
    const list = [...mk(10, 'info'), ...mk(MAX_NOTICES - 5, 'warn'), ...mk(2, 'info', 100)];
    const out = capNotices(list);
    expect(out).toHaveLength(MAX_NOTICES);
    expect(out.filter((n) => n.kind === 'info').map((n) => n.id)).toEqual(['info7', 'info8', 'info9', 'info100', 'info101']);
  });
  it('警告だけで上限を超えたら、古い警告から落とす', () => {
    const out = capNotices(mk(MAX_NOTICES + 4, 'warn'));
    expect(out).toHaveLength(MAX_NOTICES);
    expect(out[0].id).toBe('warn4');
  });
});
