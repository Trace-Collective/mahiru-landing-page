# Masterplan Nightly Stock Screening IDX

Dokumen ini adalah blueprint untuk sistem screening saham harian Bursa Efek Indonesia yang berjalan setiap hari pada `00:05 WIB` dan menghasilkan `next-session watchlist` berkualitas tinggi ke Discord.

Target utamanya bukan menghasilkan ide sebanyak mungkin, tetapi menghasilkan ide yang:

- bisa ditradingkan secara realistis
- cukup robust terhadap kualitas data IDX yang tidak selalu sempurna
- punya expectancy yang masuk akal setelah biaya dan slippage
- lebih memilih `no-trade` daripada memaksakan setup lemah

Prinsip dasarnya sederhana:

- sistem inti harus `deterministik`
- ranking harus dibuat oleh `rule engine`, bukan oleh LLM
- LLM hanya dipakai untuk `menjelaskan`, bukan `menemukan`
- universe harus ketat karena sebagian besar false positive di IDX datang dari `likuiditas`, `corporate action`, dan `governance risk`

---

## Ringkasan Eksekutif

Kalau dipaksa membuat versi paling waras dan murah, saya akan memilih:

- `1` job Python harian yang dijalankan scheduler beneran pada `00:05 WIB`
- data inti dari `official/licensed EOD + disclosure + XBRL + reference data`
- penyimpanan `raw immutable files + DuckDB/Parquet`
- scoring engine deterministik dengan penalty dan hard block
- output ke Discord via webhook
- LLM opsional di tahap terakhir hanya untuk merangkum shortlist final

Saya `tidak` akan mulai dengan:

- Airflow
- agentic workflow yang kompleks
- sentiment model berita publik
- intraday alpha yang butuh tick data mahal
- universe semua saham IDX Composite

Itu semua menambah kompleksitas lebih cepat daripada menambah edge.

---

## 1. Arsitektur Sistem yang Direkomendasikan

### A. Scheduler

Gunakan salah satu:

- `systemd timer` pada VPS kecil
- `cron` pada server yang stabil
- `Cloud Scheduler -> Cloud Run Job`

Jangan pakai scheduler yang bisa drift besar kalau targetnya benar-benar `00:05 WIB`.

Flow utama:

1. ingest data terbaru setelah market close sesi sebelumnya
2. validasi freshness dan kelengkapan feed
3. bangun snapshot point-in-time
4. hitung faktor dan penalty
5. shortlist kandidat
6. generate explanation
7. post ke Discord
8. simpan artifact run

Catatan penting:

- `00:05 WIB` cukup masuk akal, tetapi jangan anggap semua filing sudah pasti lengkap
- kalau feed penting belum lengkap, lebih baik kirim status `watchlist delayed / no publish due to stale data`
- tambahkan retry otomatis setelah itu

### B. Data Ingestion

Pisahkan ingestion menjadi beberapa feed:

- `market data`: OHLCV, traded value, trade frequency, corporate action adjusted price
- `reference data`: ticker, board, sektor, free float, listed age, suspension/watchlist status
- `fundamental data`: financial statement, rasio, auditor opinion
- `event data`: corporate action, material disclosure, rights issue, private placement, merger, litigasi
- `governance data`: ownership/pledge change, special notation, filing delay

Setiap raw file harus disimpan apa adanya dengan:

- source
- timestamp ingest
- trade date
- checksum atau hash
- schema version

### C. Scoring Engine

Scoring engine sebaiknya:

- dibuat sebagai modul Python biasa
- seluruh rule dan threshold disimpan di config yang bisa di-versioning
- output-nya tabel feature lengkap, bukan hanya skor akhir

Jangan sembunyikan logika di prompt.

### D. LLM Layer

LLM sebaiknya opsional dan sangat dibatasi:

- `temperature 0`
- hanya menerima input JSON hasil scoring
- hanya boleh membuat `ringkasan alasan`, `risk note`, dan `watch instructions`
- tidak boleh menambah ticker, mengubah ranking, atau menambah fakta dari luar input

Kalau mau lebih konservatif, versi `v1` bisa tanpa LLM sama sekali dan memakai template teks biasa.

### E. Discord Output

Output sebaiknya dikirim via:

- `Discord webhook` untuk pesan utama
- attachment `CSV` atau `JSON` untuk audit trail

### F. Storage

Rekomendasi paling sederhana dan audit-friendly:

- raw file immutable di object storage atau folder versioned
- snapshot analitik di `DuckDB + Parquet`

Tambahkan `Postgres` hanya kalau nanti benar-benar butuh concurrent access atau dashboard multi-user.

### G. Monitoring

Monitoring minimum:

- freshness check per feed
- row-count drift
- universe size drift
- missing top liquid names
- anomali distribusi faktor
- status delivery Discord

Yang penting: `no-trade` bukan error. Error adalah ketika pipeline rusak atau datanya stale.

---

## 2. Dataset Minimum Viable dan Dataset yang Lebih Berkualitas

### Minimum Viable Dataset

Dataset minimum yang sudah cukup berguna:

- daily `OHLCV`
- `regular-market traded value`
- `trade frequency`
- `shares outstanding`
- `free float`
- `sector / IDX-IC`
- `board` dan `suspension/watchlist status`
- quarterly atau monthly `financial ratios`
- `auditor opinion`
- `disclosure metadata` dengan publication timestamp
- `corporate action flags`

Ini sudah cukup untuk membangun screen yang waras kalau universe-nya ketat.

### Better-Quality Dataset

Kalau budget dan operasionalnya sudah siap, tambahkan:

- official atau licensed `IDX Equity EoD` dan `IDX Data Reference`
- point-in-time history untuk `free float`, `share count`, `board`, `watchlist`, dan `special notation`
- full `XBRL line items`
- parsed text dari filing penting
- ownership dan pledge disclosures
- corporate action calendar yang bersih

Yang `tidak` wajib di v1:

- full order book
- social sentiment
- broker summary
- alternative data yang kualitasnya sulit diaudit

---

## 3. Definisi Universe yang Robust untuk Saham Indonesia

Jangan mulai dari semua saham BEI. Universe terlalu lebar akan merusak expectancy.

### Hard Universe Rules

Mulai dari:

- common shares biasa
- board `Main`, `Main New Economy`, dan `Development`

Keluarkan:

- `Acceleration Board`
- `Watchlist Board / Special Monitoring`
- saham suspend
- saham preferen
- rights, warrant, ETF, DIRE, dan instrumen non-common-equity

Filter tambahan:

- usia listing minimal `12 bulan`
- `free float >= 10%`
- traded pada minimal `95%` dari `60` hari bursa terakhir
- `20-day median regular-market traded value >= Rp20 miliar`
- `close >= Rp200`

### Publish Universe

Untuk nama yang benar-benar layak tampil di watchlist Discord, saya sarankan lebih ketat:

- `20-day median traded value >= Rp50 miliar`
- trade frequency memadai
- tidak ada red flag event/gov

Kalau nama hanya lolos `Rp20-50 miliar`, taruh sebagai cadangan atau extended universe, bukan core watchlist.

### Kenapa Ketat?

Di IDX, saham yang kelihatan bagus di chart sering gagal jadi ide yang benar-benar bisa dieksekusi karena:

- likuiditas palsu
- gap terlalu liar
- crowding di saham harga rendah
- corporate action overhang

Universe yang ketat menyelesaikan lebih banyak masalah daripada model yang lebih pintar.

---

## 4. Factor Model: Fast Daily vs Slow Monthly/Quarterly

### Fast Daily Factors

Fast factor harus memegang bobot terbesar karena horizon output-nya adalah `next session`.

Paket yang saya pilih:

- `relative strength 21d dan 63d`, dibanding sektor, dengan eksklusi `3` hari terakhir
- `trend confirmation`: close di atas `20DMA` dan `60DMA`, slope keduanya positif
- `turnover confirmation`: `5d median traded value / 20d median traded value`
- `trade activity confirmation`: perbaikan frekuensi transaksi
- `volatility containment`: ATR%, gap frequency, dan hit limit behavior

Saya sengaja tidak memasukkan terlalu banyak technical gadget. Di market seperti IDX, lebih baik sedikit faktor yang jelas daripada banyak faktor yang tidak stabil.

### Slow Monthly/Quarterly Factors

Slow factor dipakai untuk menyaring sampah, bukan untuk mendominasi ranking harian.

Paket yang masuk akal:

- profitability dan quality
- balance-sheet strength
- fundamental trend improvement
- valuation sanity secara sector-relative

Contoh proksi:

- `ROE`, `ROA`, margin, `CFO/NI`, interest coverage
- perubahan penjualan, laba, atau margin secara `YoY` dan `QoQ`
- leverage atau equity trend

### Faktor yang Sebaiknya Tidak Jadi Inti

Saya tidak akan menjadikan faktor berikut sebagai core alpha di v1:

- generic news sentiment
- social media buzz
- insider heuristics yang tidak konsisten
- faktor mikrostruktur yang butuh intraday feed mahal

---

## 5. Rules Sektoral: Bank/Financials vs Non-Financials

Ini bagian yang sering dirusak model generik.

### Bank

Untuk bank, pakai:

- `P/B`
- `ROA` dan `ROE`
- `NIM`
- `NPL` atau biaya kredit
- coverage
- capital strength
- kualitas pertumbuhan kredit

Jangan pakai untuk bank:

- `EV/EBITDA`
- `net debt/EBITDA`
- current ratio

### Other Financials

Untuk sekuritas, asuransi, multifinance, data sering tidak serapi bank. Jadi:

- gunakan metrik yang memang relevan dan tersedia
- kalau coverage datanya lemah, turunkan bobot slow factor
- naikkan bobot tradability dan price confirmation

### Non-Financials

Untuk non-financials, pakai:

- `ROA/ROIC`
- EBITDA margin atau operating margin
- `CFO/NI`
- `net debt/EBITDA`
- interest coverage
- `PE`, `EV/EBITDA`, atau `P/B` secara sector-relative

### Prinsip Normalisasi

Normalisasi harus dilakukan minimal per:

- `sector`
- atau `subindustry`

Jangan bandingkan valuation bank langsung dengan emiten consumer atau mining lalu menganggap skor itu bermakna.

---

## 6. Framework Penalty

Sebelum bicara skor, selalu pisahkan:

- `hard block`
- `soft penalty`

### Hard Block

Hard block untuk kondisi seperti:

- suspended
- masuk watchlist board
- negative equity
- adverse atau disclaimer audit opinion
- kondisi restrukturisasi ekstrem seperti `PKPU` atau risiko going concern yang jelas
- likuiditas terlalu buruk untuk ditradingkan

### Soft Penalties

#### A. Illiquidity Penalty

Potongan sampai `-20` untuk:

- median traded value rendah
- trade frequency rendah
- rasio illiquidity sangat buruk
- volume hanya muncul sesekali

#### B. Dilution Penalty

Potongan `-8` sampai `-20` untuk:

- share count naik `>5%` dalam `90 hari`
- share count naik `>10%` dalam `12 bulan`
- rights issue
- private placement
- warrant overhang

#### C. Extreme Volatility Penalty

Potongan `-5` sampai `-15` untuk:

- ATR terlalu besar
- gap terlalu sering
- perilaku mirip saham limit-up/limit-down crowding

#### D. Governance Penalty

Potongan `-8` sampai `-20` untuk:

- keterlambatan filing
- auditor/event yang aneh
- adverse special notation
- pledge activity yang memburuk
- tanda governance deterioration

#### E. Event Risk Penalty

Potongan `-5` sampai `-20` untuk:

- corporate action material
- litigasi
- restrukturisasi
- management shock
- filing material yang unresolved

Kalau total penalty terlalu besar, nama itu tidak boleh muncul di watchlist meskipun skornya tinggi.

---

## 7. Formula Scoring yang Saya Rekomendasikan

Semua sub-score sebaiknya dibuat dalam skala `0-100`, lalu di-winsorize dan dinormalisasi secara sector-relative.

```text
HardBlock =
  suspended OR watchlist OR acceleration OR listed_age < 252d OR
  free_float < 10% OR mdvt20 < 20e9 OR close < 200 OR
  negative_equity OR adverse_or_disclaimer_audit

Fast =
  0.45*RelStrength +
  0.25*TrendQuality +
  0.20*TurnoverConfirmation +
  0.10*VolatilityContainment

Slow =
  0.40*ProfitabilityQuality +
  0.30*BalanceSheet +
  0.20*FundamentalTrend +
  0.10*ValuationSanity

Tradability =
  0.50*MDVT20 +
  0.25*TradeFrequency +
  0.25*FreeFloat

FinalScore = 0 if HardBlock else 0.55*Fast + 0.25*Slow + 0.20*Tradability - Penalty
```

Rule publish:

- publish hanya jika `FinalScore >= 75`
- publish hanya jika `Penalty <= 15`
- `Tier A` jika `FinalScore >= 82`
- maksimal `5` nama

### Kenapa Weighting Ini Saya Anggap Robust

- edge jangka `next-session` di IDX paling banyak datang dari `price persistence + turnover confirmation`
- slow factor lebih cocok jadi `quality control`, bukan mesin alpha utama
- tradability harus berdiri sendiri karena ide yang tidak bisa dieksekusi adalah ide palsu
- valuation sengaja dibikin kecil karena noisy, terutama lintas sektor

---

## 8. Format Output Watchlist ke Discord

Pesan utama harus pendek, tapi actionable.

Contoh struktur:

```text
IDX Nightly Watchlist | Run 00:05 WIB | As-of 2026-03-27 close
Eligible universe: 116 | Published: 3 | Regime: neutral-risk-on

A1 | BBRI | Financials | Score 84
Why now: 63d sector RS kuat, turnover confirm, quality bank bersih, tidak ada capital-action flag aktif
Only watch if: break/hold di atas 5,550 setelah 15 menit pertama
Do not chase: gap >1.8%
Invalidate: kembali lemah di bawah 5,430
Liquidity: MDVT20 Rp1.4tn | FF 46%
Risks: standard event risk only
```

Tambahkan attachment `CSV` atau `JSON` berisi:

- semua kandidat yang lolos gate
- semua sub-score
- semua penalty reason
- source timestamp
- config version
- run id

Kalau tidak ada nama yang layak, kirim:

```text
No-trade night. Tidak ada nama yang lolos threshold kualitas dan penalty.
```

Itu hasil yang valid, bukan kegagalan sistem.

---

## 9. Rencana Backtesting dan Validasi

### A. Start Date

Kalau memungkinkan, mulai dari `2016` ke depan supaya fundamental lebih konsisten setelah adopsi `XBRL`.

### B. Point-in-Time Discipline

Ini wajib:

- gunakan publication timestamp asli untuk filing
- jangan pakai period-end date sebagai proxy availability
- board status, free float, dan share count harus point-in-time
- corporate action adjustment hanya aktif sejak tanggal efektifnya

### C. Dua Layer Validasi

#### 1. Rank Validation

Uji apakah skor yang lebih tinggi memang punya distribusi return berikutnya yang lebih baik untuk:

- `1D`
- `3D`
- `5D`

#### 2. Watchlist Simulation

Karena output-nya watchlist, bukan auto-execution, simulasi harus realistis:

- entry hanya kalau guardrail opening terpenuhi
- pakai `VWAP 15-30 menit pertama` atau aturan eksekusi yang konservatif
- batasi participation terhadap liquidity

### D. Slippage dan Biaya

Gunakan asumsi biaya konservatif.

Prinsip saya:

- saham paling likuid tetap kena biaya round-trip yang nyata
- saham mid-liquid harus dihukum lebih keras
- jangan pakai cost assumption yang terlalu optimistis

Contoh baseline:

- core universe liquid: `45-60 bps`
- mid liquidity: `70-90 bps`
- extended liquidity: `120+ bps`

### E. Metrik Evaluasi

Yang perlu dilihat:

- hit rate
- expectancy sesudah biaya
- median `MFE` dan `MAE`
- turnover
- no-trade rate
- sector concentration
- slippage per liquidity bucket

Kalau model hanya bagus sebelum biaya, berarti model itu belum layak dipakai.

---

## 10. Failure Modes Utama dan Cara Menurunkan False Positives

### A. Stale Data atau Filing Telat

Masalah:

- run jam `00:05 WIB` bisa kena data yang belum lengkap

Solusi:

- freshness gate
- retry
- suppress output kalau feed penting belum lengkap

### B. Likuiditas Palsu

Masalah:

- saham tampak likuid karena print besar sesekali

Solusi:

- pakai `median`, bukan `mean`
- pakai `regular-market value`, bukan total yang terpolusi
- cek trade frequency

### C. Saham Harga Rendah dan Crowd Behavior

Masalah:

- banyak false breakout dan slippage buruk di bucket harga bawah

Solusi:

- `close >= Rp200`
- atau kalau tetap dipakai, masukkan ke extended universe dengan penalty berat

### D. Metric Mixing antara Bank dan Non-Bank

Masalah:

- model kelihatan rapi tapi logikanya salah total

Solusi:

- pisahkan scoring bank dan non-bank

### E. Corporate Action Contamination

Masalah:

- histori harga dan share count rusak oleh adjustment yang tidak point-in-time

Solusi:

- corporate action table yang bersih
- share history point-in-time

### F. LLM Hallucination

Masalah:

- narasi terlihat meyakinkan tetapi tidak sesuai data

Solusi:

- LLM hanya pakai structured input
- LLM tidak boleh memilih saham
- ranking tetap rule-based

### G. Overfitting

Masalah:

- terlalu banyak parameter dan threshold kecil

Solusi:

- faktor sedikit
- weight tetap
- validasi out-of-sample
- dokumentasi semua perubahan config

---

## 11. Rekomendasi Implementasi Bertahap

### Fase 1: MVP yang Waras

Bangun dulu:

- ingestion market/reference/fundamental/event data
- universe filters
- scoring engine
- penalty engine
- Discord webhook
- artifact storage

Tanpa LLM pun sistem ini sudah bisa jalan.

### Fase 2: Audit dan Stabilitas

Tambahkan:

- run metadata
- schema checks
- anomaly alerts
- report perbandingan antar-hari

### Fase 3: Explain Layer

Baru setelah sistem stabil, tambahkan:

- LLM summarizer terbatas
- templated rationale
- risk note otomatis

Urutannya penting. Jangan membangun explainability sebelum ranking dasarnya benar.

---

## 12. Kesimpulan Praktis

Kalau tujuan Anda adalah `watchlist IDX yang bisa dipakai besok pagi`, maka desain terbaik bukan desain yang paling canggih. Desain terbaik adalah desain yang:

- universe-nya ketat
- datanya point-in-time
- scoring-nya sederhana
- penalty-nya kejam
- dan tidak takut menghasilkan `no-trade`

Kalau harus diringkas jadi satu kalimat:

> di IDX, kualitas universe dan penalty framework biasanya lebih menentukan hasil daripada kecanggihan model penjelas

---

## Referensi

Referensi resmi yang saya pakai untuk membentuk blueprint ini:

- [IDX Trading Hours and Mechanism](https://www.idx.id/en/products-services/trading-hours-and-mechanism/)
- [IDX Stocks: board, IDX-IC, Watchlist Board](https://www.idx.id/en/products/stocks/)
- [IDX80, LQ45, IDX30 Methodology](https://www.idx.id/media/i2sd4vsk/appendix-index-guide-methodology-idx80-lq45-and-idx30.pdf)
- [IDX Cyclical Economy 30 Methodology](https://www.idx.id/media/vrxl0lt2/appendix-index-guide-methodology-economic30.pdf)
- [IDX Data Services](https://www.idx.id/en/products/idx-data-services/)
- [IDX XBRL](https://www.idx.id/en/listed-companies/xbrl/)
- [IDX Disclosure](https://www.idx.id/en/listed-companies/disclosure/)
- [OJK regulation update on share ownership and pledging reports](https://www.ojk.go.id/en/berita-dan-kegiatan/siaran-pers/Pages/OJK-Issues-Regulation-Concerning-The-Reporting-of-Share-Ownership-and-Share-Pledging-Activities-In-Public-Companies.aspx)
