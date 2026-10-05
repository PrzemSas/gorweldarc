# Battle Weld — grafiki gry

Źródła: `Desktop\GORWELD\15-VELDA\BATTLE-WELD-GRAFIKI\` (Grok Imagine, prompty:
`15-VELDA\BATTLE-WELD-GROK-IMAGINE-PROMPTY.txt`), przygotowane 2026-10-04.
Oryginały zostają na pulpicie — tutaj tylko wersje do sieci (WebP).

| Plik | Z czego | Rozmiar | Użycie |
|---|---|---|---|
| `battle-weld-logo.svg` (zapas) | generator `battle-weld-ui/tools/make_logo.py` (Big Shoulders Display + Chivo Mono jako kształty) | wektor | brama, nagłówek, karta |
| `battle-weld-wordmark.svg` | j.w., bez hasła | wektor | zapas (nieużywany od 05.10) |
| `battle-weld-wordmark-v2.svg` | generator `battle-weld-ui/tools/make_logo_v2.py` (ten sam font co UI: chrom, wytłoczenie 3D, pochylenie jak VS, żarzące WELD, płyta z nitami, spoina z nalotem cieplnym, iskra) | wektor | **logo w grze**: nagłówek Battle i karta wyniku (wybór usera 05.10) |
| `battle-weld-letters-600.webp` | 07 (baner Groka) przycięty do samych liter | 600×104 | zapas — odrzucone 05.10, bo inny krój niż reszta UI |
| `velda-calm.webp` | 01 | 600×800 | pasek Veldy: „Gear check.”, „Same task. Same rules.” |
| `velda-focus.webp` | 02 | 600×800 | „Strike the arc.”, „Inspection complete.” |
| `velda-verdict.webp` | 03 | 600×800 | „Verdict locked.” (kadr z tłem, bez wycinania) |
| `arena-wide.webp` | 04b (05.10, łańcuchy) podbite Real-ESRGAN x4plus → 1920×1080, WebP q72 | 1920×1080 | tło bramy / VS na komputerze (przyciemnić, lekko rozmyć) |
| `arena-tall.webp` | 05 | 720×1280 | tło na telefonie |
| `gate-left.webp`, `gate-right.webp` | 09 przecięte w połowie | 640×720 | ceremonia ENTER BATTLE (skrzydła rozjeżdżają się) |
| `card-bg.webp` | 10 | 1200×675 | tło karty do udostępniania |
| `emblem-w-256.webp`, `emblem-w-192.png`, `emblem-w-48.png` | 06 | 256/192/48 | znak, ikona |
| `avatar-1..4.webp` | 08 czarny / czerwony / rdza / szary | 256×256 | domyślne awatary graczy |

Łącznie ok. 390 KB. Zasady: Velda tylko w wersji ubranej (gra ma pilotaż w szkołach),
zero napisów w grafikach rastrowych — napisy robi kod, logo jest SVG.
