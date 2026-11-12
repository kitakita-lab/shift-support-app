// PDF の組み立て（純関数部分）の確認。実際のブラウザでのダウンロードは e2e/verify.mjs で確認する。
import { describe, expect, it } from 'vitest';
import { buildImagePdf } from './pdf';

const A4L: [number, number] = [841.89, 595.28];
const A4P: [number, number] = [595.28, 841.89];
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
/** ダミーの JPEG（中身は任意のバイト列。PDF 側は解釈せずそのまま包む） */
const fakeJpeg = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);

function parse(pdf: Uint8Array) {
  const text = latin1(pdf);
  const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  const cm = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/.exec(text)!.slice(1).map(Number);
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)!.slice(1).map(Number);
  return { text, xref, offsets, draw: { w: cm[0], h: cm[1], x: cm[2], y: cm[3] }, page: { w: box[0], h: box[1] } };
}

describe('PDF（JPEG 1 枚を貼った 1 ページ）', () => {
  it('ヘッダー・相互参照表・トレーラーが正しく、どのオブジェクトの位置も表と一致する', () => {
    const pdf = buildImagePdf(fakeJpeg(5000), 3000, 2858, ...A4L);
    const { text, xref, offsets } = parse(pdf);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text.slice(xref, xref + 9)).toBe('xref\n0 6\n');
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
    expect(text).toContain('trailer\n<< /Size 6 /Root 1 0 R >>');
  });
  it('1 ページだけで、ページサイズは指定どおり（A4 横）', () => {
    const { text, page } = parse(buildImagePdf(fakeJpeg(100), 3000, 2858, ...A4L));
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(1);
    expect(page).toEqual({ w: 841.89, h: 595.28 });
  });
  it('画像は JPEG のまま（1 バイトも変えずに）入り、長さ・ピクセル寸法の宣言が一致する', () => {
    const jpeg = fakeJpeg(12345);
    const pdf = buildImagePdf(jpeg, 3000, 2858, ...A4L);
    const { text, offsets } = parse(pdf);
    const head = text.slice(offsets[3], offsets[3] + 200);
    expect(head).toContain('/Subtype /Image /Width 3000 /Height 2858 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 12345');
    const start = offsets[3] + head.indexOf('stream\n') + 'stream\n'.length;
    expect(pdf.slice(start, start + jpeg.length)).toEqual(jpeg);
    expect(latin1(pdf.slice(start + jpeg.length, start + jpeg.length + 17))).toBe('\nendstream\nendobj');
  });
  it('描画命令の長さの宣言が実際の長さと一致する', () => {
    const { text, offsets } = parse(buildImagePdf(fakeJpeg(10), 3000, 2858, ...A4L));
    const obj5 = text.slice(offsets[4], text.indexOf('endobj', offsets[4]));
    const len = Number(/\/Length (\d+)/.exec(obj5)![1]);
    const body = obj5.slice(obj5.indexOf('stream\n') + 7, obj5.indexOf('\nendstream'));
    expect(body.length).toBe(len);
  });
  it.each([
    ['横長の図 → A4 横', 3000, 2858, A4L],
    ['とても横長の図', 3000, 900, A4L],
    ['縦長の図 → A4 縦', 3000, 5200, A4P],
    ['正方形の図', 3000, 3000, A4L],
  ] as const)('%s：縦横比を保ち、余白（18pt）の内側で中央に収まる', (_name, w, h, [pw, ph]) => {
    const { draw } = parse(buildImagePdf(fakeJpeg(10), w, h, pw, ph));
    expect(draw.w / draw.h).toBeCloseTo(w / h, 2);                 // 縦横比
    expect(draw.x).toBeGreaterThanOrEqual(18 - 0.01);              // 余白
    expect(draw.y).toBeGreaterThanOrEqual(18 - 0.01);
    expect(draw.x + draw.w).toBeLessThanOrEqual(pw - 18 + 0.01);
    expect(draw.y + draw.h).toBeLessThanOrEqual(ph - 18 + 0.01);
    expect(draw.x * 2 + draw.w).toBeCloseTo(pw, 1);                // 左右中央
    expect(draw.y * 2 + draw.h).toBeCloseTo(ph, 1);                // 上下中央
    // どちらかの辺は余白いっぱいまで使う（小さく出力されない）
    expect(Math.max(draw.w / (pw - 36), draw.h / (ph - 36))).toBeCloseTo(1, 2);
  });
  it('余白 0 を指定すればページいっぱいに貼る', () => {
    const { draw } = parse(buildImagePdf(fakeJpeg(10), 841.89, 595.28, ...A4L, 0));
    expect([draw.x, draw.y, draw.w, draw.h]).toEqual([0, 0, 841.89, 595.28]);
  });
});
