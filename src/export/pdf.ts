// 配置図の PDF 出力。
// 画面と同じ SVG をブラウザで高解像度の JPEG に描画し、それを 1 ページの PDF に包む。
// 日本語フォントを PDF に埋め込む必要がなく、追加ライブラリなしでダウンロードできる。
// （文字は画像になるため PDF 上でテキスト選択はできない。docs/作業ログ.md 判断 D-06 参照）

const enc = new TextEncoder();

/**
 * JPEG 1枚を全面に貼った 1 ページの PDF を組み立てる（純関数）。
 * @param jpeg     JPEG バイト列（RGB）
 * @param imgW/H   JPEG のピクセル寸法
 * @param pageW/H  ページ寸法（pt。A4 横 = 841.89 × 595.28）
 * @param margin   余白（pt）。画像は縦横比を保って中央に収める
 */
export function buildImagePdf(
  jpeg: Uint8Array, imgW: number, imgH: number, pageW: number, pageH: number, margin = 18,
): Uint8Array {
  const scale = Math.min((pageW - margin * 2) / imgW, (pageH - margin * 2) / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  const x = (pageW - w) / 2;
  const y = (pageH - h) / 2;
  const f = (n: number) => n.toFixed(2);
  const content = `q ${f(w)} 0 0 ${f(h)} ${f(x)} ${f(y)} cm /Im0 Do Q`;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (d: string | Uint8Array) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(b);
    pos += b.length;
  };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pageW)} ${f(pageH)}] ` +
         '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB ` +
         `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  obj(5, `<< /Length ${content.length} >>`, enc.encode(content));

  const xref = pos;
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** SVG 要素を JPEG に描画する（ブラウザ専用） */
export async function svgToJpeg(svg: SVGSVGElement, pixelWidth = 3000): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const vb = svg.viewBox.baseVal;
  const w = Math.round(pixelWidth);
  const h = Math.round((pixelWidth * vb.height) / vb.width);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // 選択枠・補助グリッドなど編集用の表示は出力しない
  clone.querySelectorAll('[data-noexport]').forEach((n) => n.remove());
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('配置図の画像化に失敗しました'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('JPEG 変換に失敗しました'))), 'image/jpeg', 0.93));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadSvgAsPdf(svg: SVGSVGElement, fileName: string): Promise<void> {
  const { bytes, w, h } = await svgToJpeg(svg);
  // 図が横長なら A4 横、縦長なら A4 縦
  const [pw, ph] = w >= h ? [841.89, 595.28] : [595.28, 841.89];
  const pdf = buildImagePdf(bytes, w, h, pw, ph);
  const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
