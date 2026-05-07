/** 現場表示名を返す。clientName が空・空白のみの場合は括弧を出さない */
export function formatSiteLabel(siteName: string, clientName?: string): string {
  const c = clientName?.trim();
  return c ? `${siteName}（${c}）` : siteName;
}

/**
 * CSV インポート時の一時的な重複判定・集約判定用の複合キー。
 * 永続化しない。trim() で空白差異を吸収し、
 * clientName が空・空白のみの場合は siteName 単独と同等に扱う。
 */
export function siteCompositeKey(siteName: string, clientName?: string): string {
  return `${(clientName ?? '').trim()}\0${siteName.trim()}`;
}
