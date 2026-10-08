-- ============================================================
-- ivvibill — Skema pusat (data terpusat di Panel Data Server)
-- MySQL 5.7+ / 8.0 / MariaDB 10.4+ , utf8mb4
-- Idempoten: aman dijalankan berulang.
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ------------------------------------------------------------
-- 1. Identitas layanan (data server / ISP) — dipakai semua app
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_server (
  id                INT NOT NULL AUTO_INCREMENT,
  nama_server       VARCHAR(100) NOT NULL,
  nama_pemilik      VARCHAR(100) DEFAULT NULL,
  nomor_whatsapp    VARCHAR(20)  DEFAULT NULL,
  email             VARCHAR(100) DEFAULT NULL,
  alamat            VARCHAR(255) DEFAULT NULL,
  logo              VARCHAR(150) DEFAULT NULL,
  -- gateways (disimpan terenkripsi AES-256-GCM, lihat util/crypto.js)
  wa_gateway_url    VARCHAR(255) DEFAULT NULL,
  wa_gateway_key    TEXT,
  wa_status         VARCHAR(20)  DEFAULT 'Belum',
  pg_active         VARCHAR(30)  DEFAULT 'manual',   -- manual|midtrans|flip
  pg_midtrans_server_key TEXT,
  pg_midtrans_client_key  VARCHAR(255) DEFAULT NULL,
  pg_flip_secret_key      TEXT,
  pg_flip_public_key      VARCHAR(255) DEFAULT NULL,
  -- jadwal tagihan
  jadwal_buat_hari  TINYINT NOT NULL DEFAULT 1,     -- tgl pembuatan tagihan
  jadwal_kirim_hari TINYINT NOT NULL DEFAULT 2,     -- tgl kirim tagihan WA
  jadwal_limit_hari TINYINT NOT NULL DEFAULT 10,    -- tgl jatuh tempo
  jam_kirim         VARCHAR(5)  NOT NULL DEFAULT '07:00',
  ppn_persen        DECIMAL(5,2) NOT NULL DEFAULT 0,
  -- akun master ISP ini (model gratisinaja: login master ada di baris tenant)
  username          VARCHAR(50)  DEFAULT NULL,
  password_hash     VARCHAR(255) DEFAULT NULL,
  prefix_invoice    VARCHAR(10)  NOT NULL DEFAULT 'IVV',
  expaired_date     DATE         DEFAULT NULL,
  status            ENUM('Aktif','Tidak Aktif') NOT NULL DEFAULT 'Aktif',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ds_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 2. Akun (RBAC: superadmin/panel, agen, teknisi/karyawan, pelanggan)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
  id            INT NOT NULL AUTO_INCREMENT,
  username      VARCHAR(50)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nama          VARCHAR(100) NOT NULL,
  role          ENUM('superadmin','agen','teknisi','pelanggan') NOT NULL,
  id_ref        INT DEFAULT NULL,       -- id agen / pelanggan terkait
  id_data_server VARCHAR(100) DEFAULT NULL,  -- CSV id data_server; NULL = semua tenant
  id_group_akses INT DEFAULT NULL,      -- grant menu (lihat group_akses)
  no_hp         VARCHAR(20) DEFAULT NULL,
  status        ENUM('aktif','blokir') NOT NULL DEFAULT 'aktif',
  gagal_login   TINYINT NOT NULL DEFAULT 0,
  last_login    DATETIME DEFAULT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_username (username),
  KEY idx_user_role (role),
  KEY idx_user_server (id_data_server(20)),
  KEY idx_user_group (id_group_akses)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Grup hak akses menu per ISP (meniru group_akses gratisinaja).
-- akses = JSON: {"menu":{"pelanggan":{"halaman":["tambah","hapus"],"sub_menu":[]}}}
-- atau {"menu":"all"} untuk semua menu.
CREATE TABLE IF NOT EXISTS group_akses (
  id             INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  nama           VARCHAR(100) NOT NULL,
  akses          TEXT NOT NULL,
  status         ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_group (id_data_server, nama),
  KEY idx_group_server (id_data_server)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempt (
  id        BIGINT NOT NULL AUTO_INCREMENT,
  username  VARCHAR(50) NOT NULL,
  ip        VARCHAR(45) NOT NULL,
  success   TINYINT NOT NULL DEFAULT 0,
  -- kolom ini baru ada sejak v1.5.0 (ALTER lewat scripts/migrate-v15.js),
  -- karena itu DEFAULT NULL: baris lama tetap NULL.
  alasan    VARCHAR(30) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_attempt_user (username, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  user_id    INT DEFAULT NULL,
  id_data_server INT DEFAULT NULL,
  aksi       VARCHAR(80) NOT NULL,
  detail     TEXT,
  ip         VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_server (id_data_server),
  KEY idx_audit_waktu (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 3. Paket layanan (PPPoE & Hotspot)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paket (
  id            INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  nama_paket    VARCHAR(80) NOT NULL,
  jenis         ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe',
  harga         DECIMAL(15,2) NOT NULL DEFAULT 0,
  kecepatan     VARCHAR(40) DEFAULT NULL,          -- mis. "10M/10M"
  masa_aktif    INT NOT NULL DEFAULT 30,           -- hari
  harga_agen    DECIMAL(15,2) NOT NULL DEFAULT 0,  -- harga jual agen (voucher)
  deskripsi     VARCHAR(255) DEFAULT NULL,
  status        ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_paket_server (id_data_server, jenis)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 4. Pelanggan (PPPoE & Hotspot)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pelanggan (
  id             INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  kode           VARCHAR(20) DEFAULT NULL,
  nama           VARCHAR(100) NOT NULL,
  alamat         VARCHAR(255) DEFAULT NULL,
  nomor_whatsapp VARCHAR(20) DEFAULT NULL,
  email          VARCHAR(100) DEFAULT NULL,
  tipe           ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe',
  id_paket       INT DEFAULT NULL,
  id_agen        INT DEFAULT NULL,               -- pemilik (hotspot via agen)
  username_pppoe VARCHAR(50) DEFAULT NULL,
  password_pppoe VARCHAR(50) DEFAULT NULL,
  ip_address     VARCHAR(40) DEFAULT NULL,
  mac_address    VARCHAR(40) DEFAULT NULL,
  tanggal_masuk  DATE DEFAULT NULL,
  hari_tagihan   TINYINT NOT NULL DEFAULT 1,      -- tanggal jatuh tempo bulanan
  id_master_topologi INT DEFAULT NULL,            -- ODP / topologi (master_topologi)
  id_master_desa     INT DEFAULT NULL,            -- desa (master_desa)
  port_odp           VARCHAR(20) DEFAULT NULL,    -- port ODP yang dipakai pelanggan
  latitude           VARCHAR(30) DEFAULT NULL,    -- koordinat lokasi pelanggan
  longitude          VARCHAR(30) DEFAULT NULL,
  status         ENUM('baru','aktif','isolir','nonaktif') NOT NULL DEFAULT 'baru',
  catatan        TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pelanggan_kode (kode),
  KEY idx_pelanggan_server (id_data_server, status),
  KEY idx_pelanggan_pppoe (username_pppoe),
  KEY idx_pelanggan_agen (id_agen),
  KEY idx_pelanggan_topologi (id_master_topologi),
  KEY idx_pelanggan_desa (id_master_desa)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 5. Tagihan & pembayaran (manual pay + payment gateway)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tagihan (
  id            INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  id_pelanggan  INT NOT NULL,
  nomor_invoice VARCHAR(25) NOT NULL,
  periode       CHAR(7) NOT NULL,             -- YYYY-MM
  keterangan    VARCHAR(120) DEFAULT NULL,
  jumlah        DECIMAL(15,2) NOT NULL DEFAULT 0,
  kode_unik     SMALLINT NOT NULL DEFAULT 0,   -- 100..999, tidak muat di TINYINT
  ppn           DECIMAL(15,2) NOT NULL DEFAULT 0,
  total         DECIMAL(15,2) NOT NULL DEFAULT 0,
  tanggal_buat  DATE NOT NULL,
  jatuh_tempo   DATE NOT NULL,
  status        ENUM('buat','terkirim','menunggu','lunas','jatuh_tempo','batal') NOT NULL DEFAULT 'buat',
  metode_bayar  VARCHAR(30) DEFAULT NULL,
  paid_at       DATETIME DEFAULT NULL,
  img_invoice   VARCHAR(150) DEFAULT NULL,   -- berkas kwitansi PNG (dikirim ke WA)
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tagihan_invoice (nomor_invoice),
  KEY idx_tagihan_pelanggan (id_pelanggan, status),
  KEY idx_tagihan_server_status (id_data_server, status, jatuh_tempo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 6b. Invoice penjualan barang/jasa (modul terpisah dari tagihan
--     langganan — mengikuti invoice + invoice_list gratisinaja).
--     Uraian butir diketik manual, tidak terikat paket maupun stok.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice (
  id            INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  nomor         VARCHAR(25) NOT NULL,             -- INV<yyMM><urut> per data server
  tanggal       DATE NOT NULL,
  jatuh_tempo   DATE DEFAULT NULL,
  id_pelanggan  INT DEFAULT NULL,                 -- boleh kosong: pembeli umum/B2B
  id_agen       INT DEFAULT NULL,
  nama_tujuan   VARCHAR(100) DEFAULT NULL,        -- bila bukan pelanggan terdaftar
  alamat_tujuan VARCHAR(200) DEFAULT NULL,
  whatsapp_tujuan VARCHAR(20) DEFAULT NULL,
  catatan       VARCHAR(255) DEFAULT NULL,        -- mis. catatan pengiriman
  status        ENUM('buat','terkirim','lunas','batal') NOT NULL DEFAULT 'buat',
  metode_bayar  VARCHAR(30) DEFAULT NULL,
  paid_at       DATETIME DEFAULT NULL,
  img_invoice   VARCHAR(150) DEFAULT NULL,
  dibuat_oleh   INT DEFAULT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_nomor (nomor),
  KEY idx_invoice_server (id_data_server, status, tanggal),
  KEY idx_invoice_pelanggan (id_pelanggan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoice_item (
  id         INT NOT NULL AUTO_INCREMENT,
  id_invoice INT NOT NULL,
  tanggal    DATE NOT NULL,
  uraian     VARCHAR(150) NOT NULL,               -- teks bebas, mis. 'ONU ZTE F663 V9'
  quantity   DECIMAL(10,2) NOT NULL DEFAULT 1,
  harga      DECIMAL(15,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_invitem_invoice (id_invoice),
  CONSTRAINT fk_invitem_invoice FOREIGN KEY (id_invoice) REFERENCES invoice (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pembayaran (
  id           INT NOT NULL AUTO_INCREMENT,
  id_tagihan   INT NOT NULL,
  jumlah       DECIMAL(15,2) NOT NULL,
  metode       ENUM('manual','midtrans','flip','saldo_agen') NOT NULL DEFAULT 'manual',
  status       ENUM('menunggu','diterima','ditolak') NOT NULL DEFAULT 'menunggu',
  bukti        VARCHAR(150) DEFAULT NULL,      -- file upload bukti transfer
  ref          VARCHAR(100) DEFAULT NULL,      -- id transaksi gateway
  keterangan   VARCHAR(255) DEFAULT NULL,
  verified_by  INT DEFAULT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bayar_tagihan (id_tagihan, status),
  KEY idx_bayar_ref (ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rekening (
  id         INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  bank       VARCHAR(40) NOT NULL,
  no_rek     VARCHAR(40) NOT NULL,
  atas_nama  VARCHAR(100) NOT NULL,
  status     ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  PRIMARY KEY (id),
  KEY idx_rek_server (id_data_server)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 6. Agen hotspot (saldo & mutasi)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agen (
  id           INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  nama         VARCHAR(100) NOT NULL,
  no_hp        VARCHAR(20) DEFAULT NULL,
  alamat       VARCHAR(255) DEFAULT NULL,
  saldo        DECIMAL(15,2) NOT NULL DEFAULT 0,
  komisi_pct   DECIMAL(5,2) NOT NULL DEFAULT 0,
  status       ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agen_server (id_data_server, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agen_mutasi (
  id          BIGINT NOT NULL AUTO_INCREMENT,
  id_agen     INT NOT NULL,
  tipe        ENUM('topup','penjualan','penarikan','komisi','koreksi') NOT NULL,
  jumlah      DECIMAL(15,2) NOT NULL,
  saldo_sisa  DECIMAL(15,2) NOT NULL,
  keterangan  VARCHAR(255) DEFAULT NULL,
  ref         VARCHAR(60) DEFAULT NULL,
  created_by  INT DEFAULT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mutasi_agen (id_agen, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS voucher (
  id          INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  kode        VARCHAR(30) NOT NULL,
  id_paket    INT NOT NULL,
  id_agen     INT DEFAULT NULL,             -- NULL = stok pusat
  harga_beli  DECIMAL(15,2) NOT NULL DEFAULT 0,
  harga_jual  DECIMAL(15,2) NOT NULL DEFAULT 0,
  status      ENUM('stok','terjual','terpakai','kedaluwarsa','batal') NOT NULL DEFAULT 'stok',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sold_at     DATETIME DEFAULT NULL,
  used_at     DATETIME DEFAULT NULL,
  expired_at  DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_voucher_kode (kode),
  KEY idx_voucher_agen (id_agen, status),
  KEY idx_voucher_server (id_data_server, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 7. Perangkat: MikroTik & OLT (kredensial terenkripsi)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_perangkat (
  id             INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  nama           VARCHAR(100) NOT NULL,
  brand          ENUM('mikrotik','hsgq','vsol','hisfocus','hioso','cdata','zte','huawei','lainnya') NOT NULL DEFAULT 'mikrotik',
  tipe           ENUM('router','olt') NOT NULL DEFAULT 'router',
  alamat         VARCHAR(100) NOT NULL,          -- IP / host
  port           INT DEFAULT NULL,               -- port API/HTTP
  use_https      TINYINT NOT NULL DEFAULT 0,
  username       VARCHAR(60) DEFAULT NULL,
  password_enc   TEXT,                           -- AES-256-GCM
  lokasi         VARCHAR(120) DEFAULT NULL,
  status         ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  last_check     DATETIME DEFAULT NULL,
  last_msg       VARCHAR(255) DEFAULT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_perangkat_server (id_data_server, tipe, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- setting ambang analisa redaman per OLT
CREATE TABLE IF NOT EXISTS setting_olt (
  id              INT NOT NULL AUTO_INCREMENT,
  id_perangkat    INT NOT NULL,
  status          ENUM('aktif','inaktif') NOT NULL DEFAULT 'aktif',
  olt_tx_dbm      DECIMAL(5,2) NOT NULL DEFAULT 4.00,
  rx_min_dbm      DECIMAL(5,2) NOT NULL DEFAULT -27.00,
  att_max_db      DECIMAL(5,2) NOT NULL DEFAULT 28.00,
  interval_menit  SMALLINT NOT NULL DEFAULT 5,
  last_check_at   DATETIME DEFAULT NULL,
  last_check_msg  VARCHAR(255) DEFAULT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_setting_olt (id_perangkat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_onu (
  id             INT NOT NULL AUTO_INCREMENT,
  id_perangkat   INT NOT NULL,
  pon            VARCHAR(30) DEFAULT NULL,
  sn             VARCHAR(60) DEFAULT NULL,
  mac            VARCHAR(40) DEFAULT NULL,
  nama_onu       VARCHAR(120) DEFAULT NULL,
  rx_dbm         DECIMAL(6,2) DEFAULT NULL,
  tx_dbm         DECIMAL(6,2) DEFAULT NULL,
  status_online  TINYINT NOT NULL DEFAULT 0,
  id_pelanggan   INT DEFAULT NULL,
  match_by       VARCHAR(20) DEFAULT NULL,       -- mac|sn|nama
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_onu_perangkat (id_perangkat, pon),
  KEY idx_onu_sn (id_perangkat, sn),
  KEY idx_onu_pelanggan (id_pelanggan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS redaman_log (
  id            BIGINT NOT NULL AUTO_INCREMENT,
  id_perangkat  INT NOT NULL,
  sn            VARCHAR(60) DEFAULT NULL,
  pon           VARCHAR(30) DEFAULT NULL,
  rx_dbm        DECIMAL(6,2) DEFAULT NULL,
  redaman_db    DECIMAL(6,2) DEFAULT NULL,
  status        ENUM('ok','warning','kritis') NOT NULL DEFAULT 'ok',
  cek_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_redaman_perangkat (id_perangkat, cek_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 8. Monitoring router: interface (KECUALI interface pppoe) & resource
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS setting_mikrotik (
  id             INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  id_perangkat   INT NOT NULL,                -- rujukan master_perangkat (brand=mikrotik)
  nama           VARCHAR(60) NOT NULL,
  interval_menit SMALLINT NOT NULL DEFAULT 1,
  last_check     DATETIME DEFAULT NULL,
  cpu_load       VARCHAR(10) DEFAULT NULL,
  memory_usage   VARCHAR(10) DEFAULT NULL,
  uptime         VARCHAR(60) DEFAULT NULL,
  board_name     VARCHAR(80) DEFAULT NULL,
  status         ENUM('active','down') NOT NULL DEFAULT 'active',
  port_remote    SMALLINT DEFAULT NULL,             -- dst-port NAT remote ONU (web ONU pelanggan)
  user_remote    VARCHAR(60) DEFAULT NULL,          -- akun panel yang sedang remote
  last_remote    DATETIME DEFAULT NULL,             -- kunci 180 detik antar teknisi
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mt_perangkat (id_perangkat),
  KEY idx_mt_server (id_data_server, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interface_log (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  id_setting   INT NOT NULL,
  iface        VARCHAR(80) NOT NULL,           -- nama interface (tanpa pppoe)
  tipe         VARCHAR(40) DEFAULT NULL,       -- ether/wlan/bridge/vlan/bond/etc
  status       ENUM('up','down') NOT NULL DEFAULT 'up',
  rx_bps       BIGINT NOT NULL DEFAULT 0,
  tx_bps       BIGINT NOT NULL DEFAULT 0,
  cek_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iface_setting (id_setting, cek_at),
  KEY idx_iface_nama (iface, cek_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS router_resource_log (
  id          BIGINT NOT NULL AUTO_INCREMENT,
  id_setting  INT NOT NULL,
  cpu_load    TINYINT DEFAULT NULL,
  memory_used INT DEFAULT NULL,     -- persen
  disk_used   INT DEFAULT NULL,
  cek_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_res_setting (id_setting, cek_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 9. Peringatan issue pelanggan PPPoE (offline, isolir, redaman)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issue_pelanggan (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  id_pelanggan INT NOT NULL,
  tipe         ENUM('offline','isolir','redaman_kritis','ping_gagal','menunggak') NOT NULL,
  pesan        VARCHAR(255) NOT NULL,
  status       ENUM('open','resolved') NOT NULL DEFAULT 'open',
  resolved_at  DATETIME DEFAULT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_issue_pelanggan (id_pelanggan, status),
  KEY idx_issue_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 10. Tiket gangguan & pekerjaan teknisi/karyawan
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tiket (
  id           INT NOT NULL AUTO_INCREMENT,
  id_pelanggan INT NOT NULL,
  judul        VARCHAR(150) NOT NULL,
  pesan        TEXT,
  prioritas    ENUM('rendah','sedang','tinggi') NOT NULL DEFAULT 'sedang',
  status       ENUM('baru','diproses','selesai','ditutup') NOT NULL DEFAULT 'baru',
  id_teknisi   INT DEFAULT NULL,
  jawaban      TEXT,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tiket_status (status, created_at),
  KEY idx_tiket_teknisi (id_teknisi)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pekerjaan (
  id           INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  jenis        ENUM('pasang','pindah','bongkar','perbaikan','survey') NOT NULL DEFAULT 'pasang',
  id_pelanggan INT DEFAULT NULL,
  nama         VARCHAR(100) DEFAULT NULL,
  alamat       VARCHAR(255) DEFAULT NULL,
  id_teknisi   INT DEFAULT NULL,
  status       ENUM('antrian','dikerjakan','selesai','batal') NOT NULL DEFAULT 'antrian',
  catatan      TEXT,
  tanggal      DATE DEFAULT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_kerja_status (status, tanggal),
  KEY idx_kerja_teknisi (id_teknisi),
  KEY idx_kerja_server (id_data_server)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 10b. Absensi teknisi lapangan (satu baris per orang per hari)
--      koordinat disimpan apa adanya — tidak ada penolakan berdasarkan
--      jarak, hanya rekaman untuk dipantau di panel per data server.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS absen_teknisi (
  id            INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  id_teknisi    INT NOT NULL,                 -- app_user.id (sama seperti pekerjaan.id_teknisi)
  nama_teknisi  VARCHAR(100) NOT NULL,        -- dipatok saat absen: nama user bisa berubah nanti
  tanggal       DATE NOT NULL,
  jam_masuk     DATETIME DEFAULT NULL,
  jam_pulang    DATETIME DEFAULT NULL,
  lat_masuk     DECIMAL(10,7) DEFAULT NULL,
  long_masuk    DECIMAL(10,7) DEFAULT NULL,
  lat_pulang    DECIMAL(10,7) DEFAULT NULL,
  long_pulang   DECIMAL(10,7) DEFAULT NULL,
  akurasi_masuk INT DEFAULT NULL,             -- meter, dari device (geolocation API)
  akurasi_pulang INT DEFAULT NULL,
  jarak_meter   INT DEFAULT NULL,             -- lintasan masuk -> pulang (Haversine)
  catatan       VARCHAR(255) DEFAULT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_absen_hari (id_teknisi, tanggal),
  KEY idx_absen_tanggal (id_data_server, tanggal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 11. WhatsApp gateway: template, antrean, log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pesan_template (
  id           INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  jenis        VARCHAR(40) NOT NULL,       -- registrasi, aktivasi, tagihan, peringatan,
                                           -- lunas, isolir, koneksi_off, tiket
  konten       TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template (id_data_server, jenis)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wa_queue (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  tujuan     VARCHAR(20) NOT NULL,
  jenis      VARCHAR(40) NOT NULL,
  pesan      TEXT NOT NULL,
  media      VARCHAR(255) DEFAULT NULL,      -- URL gambar/PDF dilampirkan (WHAPI sendMediaFromUrl)
  id_ref     INT DEFAULT NULL,
  status     ENUM('pending','terkirim','gagal') NOT NULL DEFAULT 'pending',
  percobaan  TINYINT NOT NULL DEFAULT 0,
  error      VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at    DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_waq_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wa_log (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  id_queue   BIGINT DEFAULT NULL,
  tujuan     VARCHAR(20) NOT NULL,
  pesan      TEXT NOT NULL,
  status     VARCHAR(20) NOT NULL,
  response   VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_walog_waktu (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 12. Pengaturan aplikasi (key/value) + snapshot status pppoe
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS setting_app (
  id_data_server INT NOT NULL DEFAULT 1,
  kunci   VARCHAR(60) NOT NULL,
  nilai   TEXT,
  PRIMARY KEY (id_data_server, kunci)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pppoe_status (
  id_pelanggan INT NOT NULL,
  online       TINYINT NOT NULL DEFAULT 0,
  ip_address   VARCHAR(40) DEFAULT NULL,
  uptime       VARCHAR(60) DEFAULT NULL,
  since_off    DATETIME DEFAULT NULL,
  last_seen    DATETIME DEFAULT NULL,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_pelanggan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Master Topologi ODP & Master Desa (meniru gratisinaja)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_topologi (
  id              INT NOT NULL AUTO_INCREMENT,
  id_data_server  INT NOT NULL DEFAULT 1,
  nama            VARCHAR(100) NOT NULL,
  titik_koordinat VARCHAR(100) DEFAULT NULL,   -- "lat, long" titik ODP
  jumlah_port     SMALLINT NOT NULL DEFAULT 16,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_topologi_nama (id_data_server, nama)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_desa (
  id             INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  nama           VARCHAR(100) NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_desa_nama (id_data_server, nama)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Kas / laporan keuangan (pemasukan & pengeluaran)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kas (
  id             INT NOT NULL AUTO_INCREMENT,
  id_data_server INT NOT NULL DEFAULT 1,
  tipe           ENUM('masuk','keluar') NOT NULL DEFAULT 'masuk',
  kategori       VARCHAR(40) NOT NULL DEFAULT 'umum',  -- pembayaran, topup, gaji, perbaikan, listrik, dll
  jumlah         DECIMAL(15,2) NOT NULL DEFAULT 0,
  keterangan     VARCHAR(255) DEFAULT NULL,
  id_ref         INT DEFAULT NULL,             -- id pembayaran/tagihan bila terkait
  dibuat_oleh    INT DEFAULT NULL,             -- app_user.id
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_kas_server (id_data_server, tipe, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ------------------------------------------------------------
-- Data awal
-- ------------------------------------------------------------
INSERT IGNORE INTO data_server (id, nama_server, nama_pemilik, alamat, status)
VALUES (1, 'IVVI Network', 'Administrator', '', 'Aktif');

INSERT IGNORE INTO setting_app (kunci, nilai) VALUES
  ('app_name', 'ivvibill'),
  ('base_url', ''),
  ('timezone', 'Asia/Jakarta'),
  ('izin_registrasi', '1'),
  ('batas_gagal_login', '5'),
  ('interval_issue_menit', '10'),
  ('batas_offline_menit', '15');

INSERT IGNORE INTO pesan_template (id_data_server, jenis, konten) VALUES
(1,'registrasi','Halo #usr, pendaftaran layanan #lyn diterima. Selamat datang di #srv!'),
(1,'aktivasi','Halo #usr, layanan #lyn sudah AKTIF. Username PPPoE: #ppp. Terima kasih.'),
(1,'tagihan','Halo #usr, tagihan #inv periode #prd sebesar Rp #tot jatuh tempo pada #lmt. Bayar via aplikasi/transfer: #lnk'),
(1,'peringatan','Halo #usr, pengingat: tagihan #inv sebesar Rp #tot jatuh tempo #lmt. Segera bayar agar layanan tidak terisolir.'),
(1,'lunas','Terima kasih #usr, pembayaran Rp #tot untuk tagihan #inv sudah kami terima. Layanan aktif kembali. #srv'),
(1,'isolir','Halo #usr, tagihan #inv belum dibayar sampai #lmt. Layanan #lyn sementara DIISOLIR. Hubungi kami setelah bayar.'),
(1,'koneksi_off','Halo #usr, layanan #lyn terdeteksi OFFLINE sejak #jam. Jika bukan dari Anda, segera lapor tiket. #srv'),
(1,'tiket','Halo #usr, tiket "#judul" kami terima dan sedang diproses. Nomor tiket #inv. #srv');

INSERT IGNORE INTO rekening (bank, no_rek, atas_nama) VALUES
('BCA','0000000000','IVVI Network'),
('DANA','081234567890','IVVI Network');
