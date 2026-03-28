# Bond Vigilante Liquidity Sweep

Strategi ini dirancang untuk `Degen Claw` dengan target utama `Composite Score`, bukan sekadar PnL mentah. Artinya fokus utamanya adalah:

- jaga downside kecil agar `Sortino` tetap tinggi
- ambil trade sedikit tapi berkualitas agar `Profit Factor` tinggi
- hanya agresif saat narasi makro, likuiditas, dan struktur harga searah

## Kenapa strategi ini cocok untuk Degen Claw

Pada snapshot leaderboard `28 Maret 2026`, agent peringkat 1 hanya punya `5` closed trades, `80%` win rate, dan `Profit Factor 18.17`. Ini saya baca sebagai sinyal bahwa season awal lebih menghargai:

- selektivitas
- loss yang cepat dipotong
- menang besar saat setup matang
- menghindari overtrading

Pada snapshot yang sama, `Sortino` di leaderboard teratas terlihat sama-sama tinggi, jadi pembeda yang paling terasa di fase awal season ini cenderung `profit factor` dan `return`, bukan frekuensi trade.

Karena itu strategi ini sengaja bukan high-frequency. Targetnya `3-8 trade per minggu`, bukan puluhan trade.

## Ekstraksi Referensi

### 1. Degen Claw / dgclaw-skill

Hal yang paling penting dari kompetisi ini:

- ranking ditentukan oleh `Sortino Ratio (40%) + Return % (35%) + Profit Factor (25%)`
- agent trade live di `Hyperliquid perps`
- pair universe cukup luas, termasuk crypto besar dan beberapa macro proxies seperti `xyz:SP500`, `xyz:GOLD`, `xyz:BRENTOIL`, `xyz:JPY`

Implikasinya:

- strategi terbaik bukan `max leverage`
- strategi terbaik adalah `high quality asymmetric entries`
- satu hari tanpa trade itu lebih baik daripada memaksa setup jelek

### 2. SSRN: *151 Trading Strategies*

Paper aslinya sekarang sudah saya baca secara lokal. Bagian yang paling relevan untuk bot ini adalah:

- `Introduction and Summary`
- `Stocks`: momentum, low-volatility, multifactor, moving averages, support/resistance, channel
- `ETFs`: sector rotation, MA filter, dual momentum, multi-asset trend following
- `Indexes`: volatility targeting
- `Futures`: contrarian mean-reversion, trend following
- `Cryptocurrencies`: ANN dan sentiment
- `Global Macro`: macro momentum dan trading on economic announcements
- `Appendix`: out-of-sample backtesting dan trading-cost treatment

Prinsip yang saya ambil:

- market itu adaptif; strategi bisa mati, jadi rule harus cukup simpel untuk dipantau dan cukup disiplin untuk diubah hanya bila perlu
- gabungkan `trend following` dan `mean reversion`, jangan berdiri di satu mode terus
- `relative momentum` lebih kuat bila dipadukan dengan `absolute trend filter`
- ukuran posisi harus ditekan pada market yang lebih volatile
- setup reversal lebih kuat ketika ada `volume shock` tetapi `open interest` tidak ikut mengembang
- crypto tidak punya fundamental yang jelas seperti saham, jadi edge utamanya datang dari `momentum`, `volatility`, `sentiment`, dan `liquidity`
- risk management harus jadi inti strategi, bukan tambahan
- parameter harus sedikit, stabil, dan masuk akal `out-of-sample`
- edge kecil yang tidak lolos biaya, slippage, funding, dan noise lebih baik dibuang

### 3. Thread Kutekians

Inti thread-nya kuat dan bisa dipakai sebagai filter narasi global:

- area `UST 10Y 4.3% - 4.5%` diperlakukan sebagai zona stres fiskal AS
- saat yield masuk area itu, Trump cenderung mengeluarkan `good news` untuk meredakan tekanan pasar
- artinya headline sering bukan penyebab utama, tetapi respons terhadap tekanan di bond market

Implikasinya:

- jangan trade headline secara buta
- baca dulu apakah pasar sedang `risk-on`, `risk-off`, atau `relief rally`
- saat yield / bond stress tinggi, short bias lebih valid, tetapi siap menghadapi squeeze tajam jika ada pivot headline

### 4. CoinGlass Liquidity Maps

Dari dokumentasi dan artikel CoinGlass:

- liquidation heatmap menunjukkan area konsentrasi likuidasi
- area terang berfungsi sebagai `magnetic zone`, harga sering tertarik ke sana
- heatmap paling berguna bila digabung dengan `open interest`, `funding`, dan struktur harga

Implikasinya:

- jangan entry tepat di tengah cluster likuiditas
- lebih baik tunggu `sweep` ke cluster, lalu entry setelah ada konfirmasi reversal / continuation
- target terbaik biasanya cluster berikutnya, bukan target acak

### 5. ICT

ICT berguna, tapi menurut saya harus jadi `execution layer`, bukan edge utama.

Bagian ICT yang relevan untuk agent ini:

- liquidity sweep
- market structure shift
- displacement
- fair value gap / retest

Bagian yang tidak saya jadikan inti:

- narasi yang terlalu discretionary
- label-level yang terlalu banyak sampai agent jadi overfit

## Inti Strategi

Nama kerjanya: `Bond Vigilante Liquidity Sweep`

Edge dibangun dari tiga lapisan:

1. `Macro regime`
2. `Liquidity positioning`
3. `ICT-style execution`

Trade hanya diambil kalau tiga lapisan ini searah.

## Translasi Paper ke Bot

Hasil baca paper saya ubah menjadi aturan operasional berikut:

- `Cross-asset confirmation`: jangan trade dari satu chart saja; konfirmasi dengan `BTC/ETH/SOL` dan proxy makro seperti `SP500`, `GOLD`, `JPY`, `DXY` jika tersedia
- `Dual momentum`: pair dipilih berdasarkan relative momentum, tetapi trade trend hanya boleh jika absolute trend juga mendukung
- `Inverse-vol thinking`: pair yang lebih liar harus dapat size lebih kecil, bukan sama besar
- `Volume + OI exhaustion`: reversal hanya diambil bila volume melonjak namun open interest tidak ikut naik sehat
- `Announcement discipline`: event makro besar dan headline kebijakan tidak dikejar pre-event; lebih aman tunggu reaksi lalu masuk setelah sweep / reclaim / reject
- `Out-of-sample discipline`: jangan menambah rule baru setiap kali 1-2 trade kalah; tetap pakai stack fitur yang sama dan evaluasi setelah sampel cukup

## Asset Universe

### Fokus utama

- `BTC`
- `ETH`
- `SOL`

### Fokus sekunder

- `XRP`
- `SUI`

### Macro proxies untuk filter, bukan wajib ditrade

- `xyz:SP500`
- `xyz:GOLD`
- `xyz:BRENTOIL`
- `xyz:JPY`
- `xyz:DXY` jika tersedia

Alasan:

- market ini paling likuid
- slippage lebih kecil
- lebih mudah dibaca dengan heatmap dan crowding data
- lebih cocok untuk strategi win rate tinggi daripada alt kecil

### Aturan ranking fokus

Sebelum entry, ranking `BTC/ETH/SOL/XRP/SUI` berdasarkan momentum relatif terbaru dan fokus hanya pada `1-2` pair terkuat atau terlemah. Jangan menyebar perhatian ke terlalu banyak pair sekaligus.

## Regime Filter

### Mode 1: Risk-On Trend

Kondisi:

- `BTC/ETH` di atas struktur `4H`
- `SP500` stabil atau menguat
- `GOLD` dan `JPY` tidak breakout kuat
- funding tidak terlalu ekstrem
- open interest naik sehat, bukan euforia satu arah

Aksi:

- cari `long continuation`
- hindari short melawan trend kecuali ada crowding ekstrem

### Mode 2: Risk-Off Pressure

Kondisi:

- `SP500` lemah
- `GOLD`, `BRENTOIL`, atau `JPY` menguat
- crypto gagal reclaim struktur intraday
- funding / OI menunjukkan longs terlalu crowded
- jika data eksternal tersedia: `UST 10Y >= 4.3%` memperkuat bias ini

Aksi:

- cari `short on relief rally`
- ambil profit lebih cepat pada breakdown
- jangan memburu pantulan lemah

### Mode 3: Relief Rally

Kondisi:

- sebelumnya risk-off
- muncul `good news`, policy pivot, atau headline yang meredakan tekanan
- price melakukan sweep low lalu reclaim cepat
- shorts crowded, funding negatif, dan ada potensi squeeze

Aksi:

- boleh ambil `counter-trend long`, tapi taktiknya cepat
- target lebih konservatif
- durasi posisi lebih pendek daripada Mode 1

### Mode 4: Mixed / No-Trade

Kondisi:

- macro proxies saling bertabrakan
- price berada di tengah range
- tidak ada cluster likuiditas jelas
- funding netral tetapi price action kotor

Aksi:

- `no trade`

## Setup Entry

### Setup A: Sweep and Go With Trend

Pakai saat regime jelas bullish atau bearish.

Syarat:

- arah `4H` dan `1H` sejalan
- harga menyapu liquidity pool terdekat
- setelah sweep muncul displacement kuat
- ada `market structure shift` pada TF entry
- entry di retest / fair value gap

Entry:

- `long` setelah sweep low dan reclaim
- `short` setelah sweep high dan reject

Stop:

- di luar swing hasil sweep

Take profit:

- cluster likuiditas berikutnya
- atau `2R+`, mana yang tercapai dulu

Ini setup utama. Secara statistik biasanya paling bersih.

### Setup B: Crowded Reversal

Pakai saat crowding ekstrem.

Syarat long:

- funding sangat negatif
- open interest naik saat price turun atau datar
- ada short-side liquidity pool besar di atas
- price sweep low lalu reclaim cepat
- lebih kuat lagi bila volume melonjak tetapi open interest lalu melemah / flat, menandakan overreaction

Syarat short:

- funding sangat positif
- open interest naik saat price naik atau datar
- ada long-side liquidity pool besar di bawah
- price sweep high lalu gagal lanjut
- lebih kuat lagi bila volume melonjak tetapi open interest lalu melemah / flat, menandakan dorongan terakhir mulai kehabisan tenaga

Catatan:

- jangan entry hanya karena funding ekstrem
- harus ada reversal structure yang nyata

### Setup C: Breakout Expansion

Pakai lebih jarang.

Syarat:

- konsolidasi rapi
- liquidation cluster besar berada di luar range
- funding netral sampai sedikit mendukung arah breakout
- volume / taker aggression naik saat breakout
- kalau bisa, anggap range ini sebagai `channel` / `Donchian-style box` dan hanya ambil break yang benar-benar bersih

Catatan:

- hindari breakout saat market sudah terlalu jauh dari basis
- breakout tanpa liquidity objective biasanya jelek untuk win rate

## Rule Eksekusi

- maksimal `1` posisi aktif untuk pair yang berkorelasi tinggi
- boleh `2` posisi hanya jika satu crypto dan satu macro proxy, dan korelasinya tidak sama
- entry hanya setelah candle konfirmasi close, jangan antisipasi sweep terlalu awal
- kalau price sudah bergerak `> 1.5 ATR` dari basis, skip
- kalau reward ke cluster berikutnya kurang dari `1.8R`, skip
- kalau setup bagus tapi regime tidak jelas, size dipotong `50%` atau tidak trade sama sekali

## Risk Management

### Risk per trade

- target risk `0.35% - 0.60%` dari equity
- default `0.50%`

### Leverage

- `BTC/ETH`: `2x - 4x`
- `SOL/XRP/SUI`: `2x - 3x`
- jangan pakai leverage maksimum exchange

### Volatility targeting

- saat realized volatility naik tajam, size harus otomatis turun
- bila risk yang dibutuhkan berubah besar, baru rebalance size; jangan ubah size setiap noise kecil
- tujuan utamanya adalah menjaga `equity curve` halus, bukan memaksimalkan ukuran posisi di semua kondisi

### Daily stop

- stop trading setelah `-1.25%` dalam 1 hari
- stop trading setelah `2` loss beruntun
- resume hanya setelah ada regime yang jelas lagi

### Management saat posisi profit

- ambil partial `30% - 50%` di `1.5R`
- geser stop ke `breakeven` setelah struktur mengizinkan
- sisakan runner ke cluster berikutnya

### Hard no

- martingale
- averaging loser
- tambah size di trade yang thesis-nya rusak
- revenge trade setelah liquidation atau stop out

## Pair Selection Rule

Pilih pair hanya jika memenuhi minimal `3` dari `4` syarat ini:

1. volume notional tinggi
2. open interest tinggi
3. spread / midprice normal
4. struktur harga bersih di `1H` dan `4H`

Kalau pair ramai tapi bentuk chart jelek, tetap skip.

## Jam Trading

Prioritaskan jam dengan likuiditas tertinggi:

- overlap `Eropa - US`
- awal sesi US

Kurangi agresivitas saat:

- market sangat sepi
- weekend drift tanpa catalyst
- menjelang event makro besar bila agent bisa membaca kalender
- hari FOMC, CPI, NFP, tariff headline besar, atau policy pivot; tunggu reaksi awal lalu cari setup `post-event`, bukan tebak arah mentah

## Framework Decision Tree

1. Tentukan regime: `risk-on`, `risk-off`, `relief`, atau `no-trade`
2. Pilih hanya pair paling likuid dan paling bersih
3. Tandai liquidity cluster terdekat dari heatmap
4. Cek apakah funding dan open interest mendukung continuation atau reversal
5. Tunggu sweep + displacement + structure shift
6. Hanya entry kalau minimum `1.8R`
7. Ambil partial dan lindungi downside secepat mungkin

## Hal yang Sengaja Tidak Dilakukan

- tidak scalp noise kecil
- tidak trade semua headline
- tidak trade pair midcap aneh hanya karena terlihat murah
- tidak mengejar win rate 90% dengan target terlalu kecil

Strategi ini mengejar `win rate 55% - 70%` dengan `profit factor > 1.8`. Itu lebih sehat untuk leaderboard daripada win rate besar tapi RR jelek.

## Prompt Agent Siap Pakai

Bagian ini sengaja ditulis dalam English supaya lebih stabil kalau dipakai sebagai base prompt untuk agent.

```text
You are a live trading agent competing on Degen Claw / Hyperliquid perps.

Your objective is not to maximize trade count. Your objective is to maximize competition score by prioritizing:
1. downside protection and smooth equity curve
2. high profit factor
3. selective asymmetric trades

Trade only when macro regime, liquidity positioning, and price structure align.

Core trading style:
- low-frequency, high-conviction swing / intraday trading
- primary markets: BTC, ETH, SOL
- secondary markets: XRP, SUI
- optional macro proxies for filtering or occasional trading: xyz:SP500, xyz:GOLD, xyz:BRENTOIL, xyz:JPY

Regime logic:
- Risk-On: prefer longs when BTC/ETH higher-timeframe structure is bullish, equities are stable/firm, and defensive assets are not breaking out.
- Risk-Off: prefer shorts on relief rallies when equities are weak, defensive assets are bid, and crypto fails to reclaim structure.
- Relief Rally: after strong downside pressure, if price sweeps lows and reclaims quickly while short positioning is crowded, allow faster tactical longs.
- Mixed regime: do not trade.
- Use cross-asset confirmation whenever possible instead of relying on a single chart.
- Use dual momentum logic: first identify the strongest or weakest market by relative momentum, then require an absolute trend filter before trend continuation trades.

Execution logic:
- Use liquidity sweeps, market structure shifts, displacement, and fair value gap / retest entries.
- Never enter in the middle of a dirty range.
- Prefer entries after price attacks a liquidation cluster, then confirms reversal or continuation.
- Use liquidation maps as objectives, not as standalone signals.
- Funding and open interest should confirm the trade:
  - continuation: crowding should not be extreme
  - reversal: crowding should be extreme and price must confirm the turn
  - highest-quality reversal: volume shock with open interest weakening or failing to expand
- Prefer simple, repeatable features over too many custom parameters. Do not overfit.

Approved setups:
1. Sweep-and-go trend continuation
2. Crowded reversal after one-sided positioning
3. Clean breakout expansion from tight consolidation

Risk rules:
- default risk per trade: 0.5% of equity
- max daily loss: 1.25%
- stop after 2 consecutive losses
- BTC/ETH leverage: 2x to 4x
- SOL/XRP/SUI leverage: 2x to 3x
- minimum reward-to-risk: 1.8R
- no martingale
- no averaging down
- no revenge trades
- size positions inversely to realized volatility; when volatility expands sharply, reduce size
- rebalance risk meaningfully, not on every minor fluctuation

Trade management:
- take partial profits around 1.5R when appropriate
- move stop to breakeven only after structure confirms
- let the remaining size run toward the next liquidity objective

Pair selection rules:
- prefer the most liquid, highest-OI markets
- skip markets with poor structure, poor spread, or unclear liquidity objectives

No-trade conditions:
- mixed regime
- unclear liquidity map
- no clean sweep / displacement / structure shift
- reward-to-risk below 1.8R
- price already extended far from base
- major announcement is imminent and the move has not been digested yet

If external macro data is available, treat elevated US 10Y yield around 4.3% to 4.5% as a risk-off warning and be alert for sudden relief headlines that can trigger squeezes.

Feature hierarchy:
- first: regime and cross-asset confirmation
- second: liquidity map objective plus price structure
- third: funding, OI, and volume confirmation
- fourth: sentiment or headline layer if available

Keep the rule set stable. Adapt slowly and only after enough evidence, because overfitting destroys live performance.

Every trade must be explainable in one paragraph:
- regime
- setup
- entry
- stop
- take-profit
- why this trade improves score quality instead of just increasing activity

If there is no clear edge, do nothing.
```

## Versi Singkat

Kalau mau dipadatkan jadi satu kalimat:

> Trade BTC/ETH/SOL only when macro regime jelas, price menyapu liquidity pool penting, crowding mendukung, dan entry muncul setelah market structure shift; sisanya skip.

## Sumber

- Degen Claw: <https://degen.virtuals.io/>
- Degen Claw skill / scoring / endpoints: <https://github.com/Virtual-Protocol/dgclaw-skill>
- SSRN abstract `151 Trading Strategies`: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3247865>
- Kutekians thread: <https://x.com/Kutekians/status/2036370257921667540>
- CoinGlass liquidation heatmap article: <https://www.coinglass.com/learn/how-to-use-liqmap-to-assist-trading-en>
- CoinGlass heatmap docs: <https://docs.coinglass.com/reference/liquidation-heatmap>
