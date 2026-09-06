/**
 * ドット絵スプライトの下ごしらえ。取り込みツール（Node）と
 * アプリの絵の差し替え（ブラウザ）で同じ結果になるよう、ここに置いて共有する。
 */

/**
 * 透明な余白を刈る。刈らないと板の足元が浮き、群れが宙に並ぶ。
 * @param {{w:number,h:number,data:Uint8Array|Uint8ClampedArray}} img
 */
export function trimSprite(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('全部が透明です');
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y + y0) * img.w + (x + x0)) * 4, d = (y * w + x) * 4;
      data[d] = img.data[s]; data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2]; data[d + 3] = img.data[s + 3];
    }
  }
  return { w, h, data };
}

/** 板に使える絵か検める。大きすぎる絵は端末の記憶領域を食うだけで見た目は変わらない */
export function checkSprite(img, max = 192) {
  if (!img || !img.w || !img.h) return '絵を読めませんでした';
  if (img.w > max || img.h > max) return `大きすぎます（${img.w}×${img.h}／${max} まで）`;
  let opaque = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 128) opaque++;
  if (opaque < 4) return '中身がほとんど透明です';
  return null;
}
