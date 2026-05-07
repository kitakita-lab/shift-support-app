/** 現場表示名を返す。clientName が空・空白のみの場合は括弧を出さない */
export function formatSiteLabel(siteName: string, clientName?: string): string {
  const c = clientName?.trim();
  return c ? `${siteName}（${c}）` : siteName;
}
