'use strict';
// ============================================================
// Laporan — satu tempat untuk menulis deretan baris menjadi berkas
// Excel (.xlsx, boleh multi-lembaran) dan PDF A4 horizontal.
//
// Kenapa satu tempat: export Tagihan dan export Kas sebelumnya punya
// susunan kolom masing-masing. Begitu kolomnya ditulis dua kali, laporan
// Excel dan laporan PDF bisa diam-diam berbeda isi — dan operator yang
// memakai keduanya untuk setoran tidak punya cara mengetahuinya.
// Di sini satu definisi kolom (`kolom`) dipakai untuk keduanya; yang
// PDF cuma boleh mengambil subset lewat `kolomPdf`.
//
// pdfkit dimuat MALAS (require di dalam fungsi): halaman lain tetap bisa
// dibuka walaupun modulnya belum terpasang, dan pesan errornya jelas.
// XLSX ikut pola yang sama — export PDF tidak boleh bergantung padanya.
// ============================================================
let _XLSX = null;
function modulXlsx() {
  if (!_XLSX) {
    try { _XLSX = require('xlsx'); }
    catch (e) {
      const err = new Error('Modul Excel belum terpasang di server (xlsx): ' + e.message);
      err.status = 500;
      throw err;
    }
  }
  return _XLSX;
}

let _PDF = null;
function modulPdf() {
  if (!_PDF) {
    try { _PDF = require('pdfkit'); }
    catch (e) {
      // Pesan error sengaja membawa sebab aslinya: tanpa itu "belum terpasang"
      // tidak bisa dibedakan dari modul yang terpasang tapi rusak.
      const err = new Error('Modul PDF belum terpasang di server (pdfkit): ' + e.message
        + '. Pakai Export Excel, atau minta pemasangan pdfkit sekali saja.');
      err.status = 500;
      throw err;
    }
  }
  return _PDF;
}

const RUR_UTUH = n => `Rp ${(Math.round(Number(n) || 0)).toLocaleString('id-ID')}`;
const p2 = n => String(n).padStart(2, '0');

/**
 'YYYY-MM-DD'[THH:MM] / Date → 'DD-MM-YYYY'. Nilai lain dikirim apa adanya.
 */
function tanggalPendek(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${p2(v.getDate())}-${p2(v.getMonth() + 1)}-${v.getFullYear()}`;
  }
  const s = String(v || '');
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s.slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS' / Date → 'DD-MM-YYYY HH:MM' */
function waktuPendek(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${tanggalPendek(v)} ${p2(v.getHours())}:${p2(v.getMinutes())}`;
  }
  const s = String(v || '').replace('T', ' ');
  return s.length >= 16 ? `${tanggalPendek(s.slice(0, 10))} ${s.slice(11, 16)}` : s;
}

/**
 * pdfkit font standar (Helvetica) memakai WinAnsi: karakter di luar itu
 * tidak crash, tapi keluar sebagai tanda aneh. Nama pelanggan kadang
 * mengandung emoji/ karakter CJK dari spreadsheet — diganti '?' supaya
 * laporannya tetap terbaca dan tidak membingungkan.
 */
function amanTeks(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '?');
}

/**
 * Nilai satu sel untuk media tertentu.
 *   tipe: 'teks' (bawaan) | 'num' (angka, rata kanan, diformat Rp di PDF)
 *         | 'tgl' | 'waktu'
 *   media: 'xlsx' → angka mentah + tanggal ISO (biar Excel bisa menjumlah)
 *          'pdf'  → teks rapi
 */
function nilaiSel(kol, baris, indeksBaris, media) {
  const mentah = typeof kol.nilai === 'function' ? kol.nilai(baris, indeksBaris) : baris[kol.k];
  if (mentah === null || mentah === undefined || mentah === '') return '';
  if (kol.tipe === 'num') {
    const n = Number(mentah) || 0;
    if (media === 'xlsx') return n;
    return kol.rp === false ? n.toLocaleString('id-ID') : RUR_UTUH(n);
  }
  if (kol.tipe === 'tgl') return tanggalPendek(mentah);
  if (kol.tipe === 'waktu') return waktuPendek(mentah);
  const s = String(mentah);
  if (media === 'pdf') return amanTeks(s);
  return s;
}

/** Isi lembar Excel: baris kepala + baris data, nomor urut otomatis bila diminta. */
function isiLembar(kolom, baris) {
  const kepala = kolom.map(c => c.label);
  const isi = (baris || []).map((b, i) => kolom.map(c => nilaiSel(c, b, i, 'xlsx')));
  return [kepala, ...isi];
}

/**
 * Tulis workbook ke response download. `lembar` = [{nama, kolom, baris}].
 * Nama lembar dipotong 31 karakter dan dibersihkan dari karakter yang dilarang
 * Excel, karena laporan dari filter panjang pernah membuat nama lembar > 31.
 */
function unduhXlsx(res, { nama, lembar }) {
  const XLSX = modulXlsx();
  const wb = XLSX.utils.book_new();
  for (const l of lembar) {
    const ws = XLSX.utils.aoa_to_sheet(isiLembar(l.kolom, l.baris));
    ws['!cols'] = l.kolom.map(c => ({ wch: c.w || (c.tipe === 'num' ? 15 : 18) }));
    const bersih = String(l.nama || 'Data').replace(/[\\*?:\[\]]/g, ' ').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, bersih);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nama}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(buf);
}

// --------------------------------------------------------------- PDF
const WARNA = {
  kop: '#12233d', sub: '#4b5563', garis: '#c9ced6', zebra: '#f4f6f9',
  kepala: '#1f2a44', teks: '#111827', catatan: '#6b7280'
};
const UKUR_FONT = { kepala: 7.5, baris: 7, kop: 12, judul: 10, kecil: 7 };

/**
 * Lebar kolom. Dulu: lebar = teks terlebar (label vs isi) lalu semuanya
 * diproporsikan turun bila lebih lebar dari kertas. Akibatnya total 12 kolom
 * laporan tagihan (833pt) cuma kepotong 6% tapi tiap lajur ikut menyusut,
 * dan nomor invoice 18 karakter tercetak "UJI-A4-..." — pdfkit memotong pada
 * spasi, jadi nomor tanpa spasi tidak bisa pindah baris dan kehilangan
 * karakter paling penting di laporan.
 *
 * Sekarang label boleh melipat dua baris (kepalanya juga ikut tinggi), jadi
 * yang menentukan lebar adalah ISI: kolom berisi teks panjang dengan banyak
 * spasi (alamat/keterangan) sengaja dibatasi supaya melipat, kolom bertoken
 * pendek (nomor invoice, tanggal, status) dapat lebar utuh. Kalau masih
 * berlebih, barulah semua menyusut bersama.
 */
function lebarKolom(doc, kolom, baris, lebarTersedia) {
  const MIN = 26, MAKS = 190, LIPAT = 118, FLOOR_LIPAT = 54;
  const labelLebar = (t) => {
    doc.font('Helvetica-Bold').fontSize(UKUR_FONT.kepala);
    return doc.widthOfString(amanTeks(t)) + 8;
  };
  const isiLebar = (t, c) => {
    // Sel dicetak dengan font yang sama seperti di tabel (tebal = Helvetica-Bold,
    // yang lebih lebar ±8%). Diukur dengan font reguler, kolom "Total" dan nomor
    // invoice ber-bold kebagian lajur sempit lalu isinya terpotong "Rp...".
    doc.font(c && c.tebal ? 'Helvetica-Bold' : 'Helvetica').fontSize(UKUR_FONT.baris);
    return doc.widthOfString(String(t).slice(0, 60)) + 8;
  };
  const bolehLipat = (c) => {
    // Kolom "boleh melipat" = isinya kalimat berjeda (alamat, keterangan,
    // nama, rekening). Nomor invoice dan kode lain yang satu token tidak
    // pernah bisa pindah baris — kalau lajur itu ikut dikecilkan, isinya
    // terpotong "...", jadi kolom semacam itu diperlakukan seperti angka:
    // minta lebar utuh.
    if (!c || c.tipe === 'num' || !(c.w >= 20)) return false;
    const contoh = (baris || []).slice(0, 60)
      .map(b => String(nilaiSel(c, b, 0, 'pdf')).trim()).filter(Boolean);
    if (!contoh.length) return true;
    const berjeda = contoh.filter(t => /\s/.test(t)).length;
    return berjeda / contoh.length >= 0.6;
  };
  // ditentukan sekali: dipakai di loop baris dan loop penyusutan
  const lipat = kolom.map(bolehLipat);
  const lebar = kolom.map(c => {
    const l = labelLebar(c.label);
    // label cukup muat separuhnya (dua baris kepala) asalkan tidak di bawah MIN
    return Math.max(MIN, Math.min(l, Math.max(l / 2 + 8, MIN)));
  });
  (baris || []).slice(0, 400).forEach((b, i) => {
    kolom.forEach((c, j) => {
      const mentah = isiLebar(nilaiSel(c, b, i, 'pdf'), c);
      const target = c.tipe === 'num' ? mentah
        // kolom teks panjang: biarkan melipat, jangan minta lebar penuh
        : (lipat[j] ? Math.min(mentah, LIPAT) : Math.min(mentah, MAKS));
      lebar[j] = Math.max(lebar[j], Math.min(MAKS, Math.max(MIN, target)));
    });
  });
  let total = lebar.reduce((a, b) => a + b, 0);
  if (total > lebarTersedia) {
    // (1) + (2) yang mengalah adalah kolom teks panjang — pertama sampai
    //     FLOOR_LIPAT, lalu kalau masih penuh lanjut sampai MIN. Selama kolom
    //     itu masih bisa menyusut, lajur angka dan token pendek (nomor invoice,
    //     tanggal, status) tetap selebar isinya dan tidak terpotong "...".
    let lebih = total - lebarTersedia;
    [FLOOR_LIPAT, MIN].forEach((lantai) => {
      lipat.forEach((boleh, j) => {
        if (!boleh || lebih <= 0) return;
        const bisa = Math.max(0, lebar[j] - Math.max(lantai, MIN));
        const pakai = Math.min(bisa, lebih);
        lebar[j] -= pakai; lebih -= pakai;
      });
    });
    total = lebar.reduce((a, b) => a + b, 0);
    // (3) kertasnya memang tidak cukup: baru semuanya menyusut bersama
    if (total > lebarTersedia) {
      const kali = lebarTersedia / total;
      for (let i = 0; i < lebar.length; i++) lebar[i] = Math.max(MIN, lebar[i] * kali);
    }
  }
  return lebar;
}

/**
 * Tulis satu bagian (bagian = judul + ringkas + tabel) pada dokumen yang sudah
 * berjalan. Dipakai unduhPdf() (satu bagian) dan unduhPdfBertingkat() (rekap
 * tiga kelompok) — jadi tidak ada dua implementasi tabel yang bisa berbeda.
 *
 * o = objek dokumen (kop/subjudul/cetak) yang sama dipakai di setiap halaman.
 * Return y terakhir setelah tabel + catatan kaki.
 */
function tulisBagian(doc, o, bagian, kiri, tersedia, bawah, opts) {
  const maksimum = Number(o.maksimum) || 5000;
  const barisSemua = bagian.baris || [];
  const baris = barisSemua.slice(0, maksimum);
  const dipotong = barisSemua.length - baris.length;
  const kolom = bagian.kolom || [];
  const lebar = lebarKolom(doc, kolom, baris, tersedia);

  const judulBagian = bagian.judul || o.judul || '';
  const subjudulBagian = [bagian.subjudul, o.subjudul].filter(Boolean).join('  ·  ');

  /** Kepala di atas halaman pertama bagian ini: nama ISP + judul + meta. */
  const cetakKepala = () => {
    let y = doc.page.margins.top;
    doc.font('Helvetica-Bold').fontSize(UKUR_FONT.kop).fillColor(WARNA.kop)
      .text(amanTeks((o.kop && o.kop.server) || 'ivvibill'), kiri, y, { width: tersedia * 0.6 });
    doc.font('Helvetica-Bold').fontSize(UKUR_FONT.judul).fillColor(WARNA.kop)
      .text(amanTeks(judulBagian), kiri, y + 17, { width: tersedia });
    doc.font('Helvetica').fontSize(UKUR_FONT.kecil).fillColor(WARNA.sub)
      .text(amanTeks([subjudulBagian, `Dicetak ${waktuPendek(new Date())}`
        + ((o.kop && o.kop.zona) ? ` (${o.kop.zona})` : ''),
        `${barisSemua.length} baris`].filter(Boolean).join('  ·  ')), kiri, y + 33, { width: tersedia });
    return y + 46;
  };

  /** Ringkasan angka-angka (total masuk/keluar, nominal belum lunas, dsb). */
  const cetakRingkas = (y) => {
    const r = (bagian.ringkas || []).filter(x => x && x.label !== undefined);
    if (!r.length) return y;
    const teks = r.map(x => `${x.label}: ${x.nilai}`).join('     ·     ');
    doc.font('Helvetica-Bold').fontSize(UKUR_FONT.kecil).fillColor(WARNA.kop)
      .text(amanTeks(teks), kiri, y, { width: tersedia });
    return doc.y + 5;
  };

  /** Baris judul tabel; labelnya boleh melipat jadi tingginya ikut isi. */
  const cetakBarisKepala = (y) => {
    const GARIS = UKUR_FONT.kepala * 1.25;
    doc.font('Helvetica-Bold').fontSize(UKUR_FONT.kepala);
    let barisLabel = 1;
    kolom.forEach((c, i) => {
      const perlu = doc.heightOfString(amanTeks(c.label), { width: Math.max(10, lebar[i] - 6) });
      barisLabel = Math.max(barisLabel, Math.min(3, Math.ceil(perlu / GARIS)));
    });
    const tinggi = 7 + barisLabel * GARIS;
    doc.rect(kiri, y, tersedia, tinggi).fillAndStroke(WARNA.kepala, WARNA.kepala);
    let x = kiri;
    kolom.forEach((c, i) => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(UKUR_FONT.kepala)
        .text(amanTeks(c.label), x + 3, y + 4, {
          width: lebar[i] - 6, align: c.tipe === 'num' ? 'right' : 'left',
          height: tinggi - 7, lineBreak: true, ellipsis: true
        });
      x += lebar[i];
    });
    return y + tinggi;
  };

  let y = opts.baruHalaman ? (doc.addPage(), doc.page.margins.top) : doc.y;
  y = cetakKepala();
  y = cetakRingkas(y);
  y = cetakBarisKepala(y);

  doc.font('Helvetica').fontSize(UKUR_FONT.baris);
  baris.forEach((b, i) => {
    // tinggi baris = teks paling tinggi pada baris itu (maksimal 3 lajur)
    let tinggi = 11;
    kolom.forEach((c, j) => {
      const t = String(nilaiSel(c, b, i, 'pdf'));
      // tinggi baris diukur dengan font sel itu sendiri (kolom tebal dicetak
      // Helvetica-Bold yang lebih lebar, jadi jumlah lajur lipatannya bisa beda)
      doc.font(c.tebal ? 'Helvetica-Bold' : 'Helvetica').fontSize(UKUR_FONT.baris);
      // kolom angka satu baris saja (lihat lineBreak di bawah), jadi tingginya
      // tidak ikut menghitung lipatan yang memang tidak akan terjadi
      const h = (c.tipe === 'num' ? UKUR_FONT.baris * 1.4
        : doc.heightOfString(t, { width: lebar[j] - 6 })) + 6;
      tinggi = Math.max(tinggi, Math.min(h, 34));
    });
    if (y + tinggi > bawah - 16) {
      doc.addPage();
      y = doc.page.margins.top;
      // halaman sambungan: sebut judulnya dulu supaya kertas yang terpisah
      // masih bisa dikenali, baru kepala tabel
      if (judulBagian) {
        doc.font('Helvetica-Bold').fontSize(UKUR_FONT.kecil).fillColor(WARNA.sub)
          .text(amanTeks(judulBagian), kiri, y, { width: tersedia, lineBreak: false });
        y = doc.y + 3;
      }
      y = cetakBarisKepala(y);
      doc.font('Helvetica').fontSize(UKUR_FONT.baris);
    }
    doc.rect(kiri, y, tersedia, tinggi)
      .fillAndStroke(i % 2 ? WARNA.zebra : '#ffffff', WARNA.garis);
    let x = kiri;
    kolom.forEach((c, j) => {
      const t = String(nilaiSel(c, b, i, 'pdf'));
      doc.fillColor(WARNA.teks)
        .font(c.tebal ? 'Helvetica-Bold' : 'Helvetica').fontSize(UKUR_FONT.baris)
        .text(t, x + 3, y + 3, {
          width: lebar[j] - 6, align: c.tipe === 'num' ? 'right' : 'left',
          height: tinggi - 6, ellipsis: true,
          // angka tidak boleh melipat jadi "Rp" / "160.000" dua baris
          lineBreak: c.tipe !== 'num'
        });
      x += lebar[j];
    });
    y += tinggi;
  });

  // Catatan kaki (mis. "retur tidak dihitung sebagai pengeluaran")
  const catatan = (bagian.catatan || []).filter(Boolean);
  if (dipotong > 0) {
    catatan.push(`Baris ke-${(maksimum + 1).toLocaleString('id-ID')} dan seterusnya tidak masuk PDF `
      + `(${dipotong.toLocaleString('id-ID')} baris) — pakai Export Excel untuk laporan lengkap.`);
  }
  if (catatan.length) {
    if (y + 8 * catatan.length + 20 > bawah) { doc.addPage(); y = doc.page.margins.top; }
    doc.font('Helvetica-Oblique').fontSize(UKUR_FONT.kecil).fillColor(WARNA.catatan)
      .text(catatan.map(amanTeks).join('\n'), kiri, y + 8, { width: tersedia });
    y = doc.y + 6;
  }
  return y;
}

/**
 * Tulis PDF ke response download (attachment).
 *   o = { nama, kop: {server, zona}, judul, subjudul, kolom, baris,
 *         ringkas: [{label, nilai}], catatan: [str...], maksimum }
 * Kertas A4 horizontal supaya 10+ kolom laporan tetap terbaca.
 */
function unduhPdf(res, o) {
  // Satu bagian saja: judul & subjudul cukup di tingkat dokumen (o), jangan
  // ditulis dua kali supaya baris meta tidak mengulang teks yang sama.
  return unduhPdfBertingkat(res, {
    ...o,
    bagian: [{ kolom: o.kolom, baris: o.baris, ringkas: o.ringkas, catatan: o.catatan }]
  });
}

/**
 * Satu PDF, beberapa tabel berturut-turut — dipakai rekap tagihan
 * (berjalan / lunas / isolir) yang kolomnya tidak sama antar bagian.
 *   o.bagian = [{ judul, subjudul, kolom, baris, ringkas, catatan }]
 * Mulai bagian ke-2 selalu di halaman baru: tiap kelompok boleh dicetak dan
 * diserahkan terpisah tanpa memotong tabel di tengah.
 */
function unduhPdfBertingkat(res, o) {
  const PDFDocument = modulPdf();
  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 30, bufferPages: true,
    info: {
      Title: o.judul || 'Laporan',
      Author: (o.kop && o.kop.server) || 'ivvibill',
      Creator: 'ivvibill'
    }
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${o.nama}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  doc.pipe(res);

  const kiri = doc.page.margins.left;
  const kanan = doc.page.width - doc.page.margins.right;
  const bawah = doc.page.height - doc.page.margins.bottom;
  const tersedia = kanan - kiri;

  const daftar = o.bagian || [];
  let y = doc.page.margins.top;
  daftar.forEach((bagian, i) => {
    y = tulisBagian(doc, o, bagian, kiri, tersedia, bawah, {
      // bagian pertama boleh melanjutkan posisi halaman berjalan; sisanya
      // sengaja ganti halaman supaya tiap kelompok berdiri sendiri
      baruHalaman: i > 0
    });
  });

  // Nomor halaman di setiap halaman (butuh bufferPages).
  // Margin bawah sementara dinolkan: pdfkit memeriksa "y + tinggi baris vs
  // margin bawah" SEBELUM menggambar, jadi teks yang placement-nya di luar
  // kotak isi tidak ditulis di tempatnya — malah membuat halaman baru yang
  // isinya cuma nomor halaman itu (satu halaman kosong terbuang per laporan).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bawahSementara = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(UKUR_FONT.kecil).fillColor(WARNA.catatan)
      .text(`Halaman ${i - range.start + 1} dari ${range.count}`, kiri,
        doc.page.height - bawahSementara + 8,
        { width: tersedia, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bawahSementara;
  }
  doc.flushPages();
  return doc.end();
}

/** CSV untuk yang masih terbiasa (sama kolomnya dengan Excel). */
function unduhCsv(res, { nama, kolom, baris }) {
  const isi = isiLembar(kolom, baris);
  const csv = isi.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nama}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send('﻿' + csv.join('\r\n'));
}

module.exports = {
  RUR_UTUH, tanggalPendek, waktuPendek, amanTeks, nilaiSel, isiLembar,
  unduhXlsx, unduhCsv, unduhPdf, unduhPdfBertingkat
};
