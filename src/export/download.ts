// ファイルの保存（PDF・JSON バックアップ）。ブラウザのダウンロードとして渡す。
//
// 保存用の URL（blob:）は、渡してから十分に長く残す。すぐに破棄すると、ブラウザが実際に読み始める前に無くなって、
// 保存に失敗することがある（iPhone の Safari は「ダウンロードしますか？」と確認してから読み始めるので、
// 利用者が答えるまでの間、URL が生きている必要がある）。メモリ上のデータは数 MB なので、長く残しても問題にならない。
const KEEP_MS = 10 * 60 * 1000;

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  // 画面に置いてから押す（置かないと反応しないブラウザがある）。押したあとも、少しの間は残しておく
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
  setTimeout(() => URL.revokeObjectURL(url), KEEP_MS);
}
