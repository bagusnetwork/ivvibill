'use strict';
// ============================================================
// Kanvas RGB minimal + encoder PNG tanpa dependensi.
// Dipakai untuk membuat gambar kwitansi yang dikirim ke
// WhatsApp, meniru kwitansi GD/`imagestring` gratisinaja.
// Sengaja tanpa modul luar: produksi ini tidak selalu bisa
// menjangkau registry npm, jadi tidak ada `npm install` baru.
// ============================================================
const zlib = require('zlib');

// Font 5x7 kolom-major (bit 0 = baris paling atas), ASCII 0x20..0x7E.
const GLIF = Buffer.from(
  '0000000000' + '00005f0000' + '0007000700' + '147f147f14' + '242a7f2a12' + //  !"#$
  '2313086462' + '3649552250' + '0005030000' + '001c224100' + '0041221c00' + // %&'()
  '14083e0814' + '08083e0808' + '0050300000' + '0808080808' + '0060600000' + // *+,-.
  '2010080402' + '3e5149453e' + '00427f4000' + '4261514946' + '2141454b31' + // /0123
  '1814127f10' + '2745454539' + '3c4a4a4930' + '0171090503' + '3649494936' + // 45678
  '064949291e' + '0036360000' + '0056360000' + '0814224100' + '1414141414' + // 9:;<=>
  '0041221408' + '0201510906' + '324979413e' + '7e1111117e' + '7f49494936' + // ?@ABC
  '3e41414122' + '7f4141221c' + '7f49494941' + '7f09090901' + '3e4149497a' + // DEFGH
  '7f0808087f' + '00417f4100' + '2040413f01' + '7f08142241' + '7f40404040' + // IJKLM
  '7f020c027f' + '7f0408107f' + '3e4141413e' + '7f09090906' + '3e4151215e' + // NOPQR
  '7f09192946' + '4649494931' + '01017f0101' + '3f4040403f' + '1f2040201f' + // STUVW
  '3f4038403f' + '6314081463' + '0708700807' + '6151494543' + '007f414100' + // XYZ[
  '0204081020' + '0041417f00' + '0402010204' + '4040404040' + '0001020400' + // \]^_`
  '2054545478' + '7f48444438' + '3844444420' + '384444487f' + '3854545418' + // abcde
  '087e090102' + '0c5252523e' + '7f08040478' + '00447d4000' + '2040443d00' + // fghij
  '7f10284400' + '00417f4000' + '7c04180478' + '7c08040478' + '3844444438' + // klmno
  '7c14141408' + '081414187c' + '7c08040408' + '4854545420' + '043f444020' + // pqrst
  '3c4040207c' + '1c2040201c' + '3c4030403c' + '4428102844' + '0c5050503c' + // uvwxy
  '4464544c44' + '0008364100' + '00007f0000' + '0041360800' + '0804081008', // z{|}~
  'hex'
);

const LEBAR_GLIF = 5;
const TINGGI_GLIF = 7;
const JARAK = 1;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let b = 0; b < 8; b++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function potongan(tipe, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const isi = Buffer.concat([Buffer.from(tipe, 'ascii'), data]);
  const ck = Buffer.alloc(4); ck.writeUInt32BE(crc32(isi));
  return Buffer.concat([len, isi, ck]);
}

class Kanvas {
  constructor(lebar, tinggi, warna = HITAM) {
    this.w = lebar; this.h = tinggi;
    this.buf = Buffer.alloc(lebar * tinggi * 3);
    if (warna) this.isi(warna);
  }

  isi(warna) {
    for (let i = 0; i < this.buf.length; i += 3) {
      this.buf[i] = warna[0]; this.buf[i + 1] = warna[1]; this.buf[i + 2] = warna[2];
    }
  }

  titik(x, y, warna) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.buf[i] = warna[0]; this.buf[i + 1] = warna[1]; this.buf[i + 2] = warna[2];
  }

  kotak(x, y, w, h, warna) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.titik(i, j, warna);
  }

  garis(x0, y0, x1, y1, warna) {
    if (y0 === y1) return this.kotak(Math.min(x0, x1), y0, Math.abs(x1 - x0) + 1, 1, warna);
    if (x0 === x1) return this.kotak(x0, Math.min(y0, y1), 1, Math.abs(y1 - y0) + 1, warna);
    const m = (y1 - y0) / (x1 - x0);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      this.titik(Math.round(x), Math.round(y0 + (x - x0) * m), warna);
    }
  }

  /** Lebar teks dalam piksel pada skala tertentu. */
  static lebar(teks, skala = 1) {
    return String(teks).length * (LEBAR_GLIF + JARAK) * skala;
  }

  /** Cetak teks ASCII. Karakter di luar 0x20..0x7E diganti '?'. */
  teks(x, y, teks, warna = HITAM, skala = 1) {
    let px = x;
    for (const ch of String(teks)) {
      const k = ch.charCodeAt(0);
      const g = (k >= 0x20 && k <= 0x7E) ? k - 0x20 : 31; // 31 = '?'
      for (let c = 0; c < LEBAR_GLIF; c++) {
        const kolom = GLIF[g * LEBAR_GLIF + c];
        for (let r = 0; r < TINGGI_GLIF; r++) {
          if (kolom & (1 << r)) this.kotak(px + c * skala, y + r * skala, skala, skala, warna);
        }
      }
      px += (LEBAR_GLIF + JARAK) * skala;
    }
    return px;
  }

  teksTengah(y, teks, warna, skala) {
    this.teks(Math.round((this.w - Kanvas.lebar(teks, skala)) / 2), y, teks, warna, skala);
  }

  toBuffer() {
    const raw = Buffer.alloc(this.h * (this.w * 3 + 1));
    for (let y = 0; y < this.h; y++) {
      const off = y * (this.w * 3 + 1);
      raw[off] = 0;                                   // filter: None
      this.buf.copy(raw, off + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; ihdr[9] = 2;                          // 8-bit, truecolor
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      potongan('IHDR', ihdr),
      potongan('IDAT', zlib.deflateSync(raw, { level: 9 })),
      potongan('IEND', Buffer.alloc(0))
    ]);
  }
}

const HITAM = [16, 16, 16];
const PUTIH = [255, 255, 255];
const BIRU = [13, 71, 161];
const ABU = [120, 120, 120];
const ORANYE = [230, 126, 34];

module.exports = { Kanvas, HITAM, PUTIH, BIRU, ABU, ORANYE };
