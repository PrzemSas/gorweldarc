/**
 * GORWELD ARC WELDER — silnik oceny spoiny.
 * © 2026 Przemysław Sąsiadek (gorweld.com). Wszelkie prawa zastrzeżone / All rights reserved.
 * GORWELD® — zarejestrowany znak towarowy UPRP, prawo wyłączne nr R.396313 (kl. 9, 36, 37, 42).
 * Oprogramowanie zastrzeżone, NIE open source — warunki w pliku /LICENSE.
 * Proprietary software. Copying, redistribution or commercial use without prior written
 * permission is prohibited.
 *
 * headless deterministyczny silnik oceny (faza on-chain, krok 2).
 *
 * `ArcSim.simulate(round)` odtwarza rundę z surowych inputów i SAM liczy wynik — bez grafiki.
 * Ta sama funkcja działa w przeglądarce (parity-check) i w Node (przyszły serwer-oracle).
 *
 * round = { seed, W, H, proc, joint, pos, thick, bead, events:[{type:'down'|'move'|'up'|'bank', t, x, y}] }
 *
 * UWAGA: matematyka jest 1:1 z `index.html` (depositBead / move / passMetrics / inspect).
 * Po potwierdzeniu parity scali się to w jedno źródło (index.html zacznie WOŁAĆ sim.js).
 *
 * Spatter jest teraz bit-exact: gra też nalicza go w `move()` po czasie łuku (spawnSparks
 * odpowiada wyłącznie za grafikę), a do wyniku idzie TEMPO odprysków (na sekundę) z sufitem
 * kary SPATTER_PEN_CAP — dawna suma bez limitu dawała grubemu MMA twarde F niezależnie od jakości.
 *
 * Wszystkie metryki liczą się po CZASIE i po DRODZE, nie po liczbie zdarzeń `move`,
 * więc wynik nie zależy od częstotliwości myszy/ekranu gracza.
 */
(function (root) {
  "use strict";

  // ── PRNG (identyczny jak w grze) ──
  function mulberry32(seed) { let a = seed >>> 0; return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ── Tabele konfiguracyjne (1:1 z index.html) ──
  const PX_PER_MM = 16;
  const PROCESS = {
    MMA: { vMul: 1.00, sparks: 1.4 },
    MIG: { vMul: 1.40, sparks: 0.7 },
    TIG: { vMul: 0.70, sparks: 0.0 },
  };
  const POSITIONS = {
    PA:{ang:0,stars:1}, PB:{ang:0,stars:2}, PC:{ang:0,stars:3}, PD:{ang:0,stars:4,flip:true},
    PE:{ang:0,stars:5,flip:true}, PF:{ang:90,stars:4}, PG:{ang:90,stars:3},
    P1G:{ang:0,stars:1,pipe:"flat"}, P2G:{ang:0,stars:3,pipe:"wall"},
    P5G:{ang:0,stars:4,pipe:"axis"}, HL045:{ang:0,stars:5,pipe:"axis",tilt:45},
  };
  const SPEED = { 2:5.0, 3:4.3, 5:3.2, 8:2.3, 12:1.6 };
  const MATERIAL = {
    steel:{ MIG:1.0, MMA:1.0, TIG:1.0, tol:1.00 },
    ss:   { MIG:1.2, MMA:1.6, TIG:1.5, tol:0.82 },
    alu:  { MIG:1.4, MMA:2.4, TIG:1.9, tol:0.70 },
  };
  const PASS_W = { root:0.72, fill:0.92, cap:1.00 };
  // Prąd — tablice 1:1 z index.html (AMP_TABLES / POS_AMP_MUL / recommendedAmps).
  const AMP_TABLES = {
    MMA:[[1,3,60],[3,6,90],[6,10,130],[10,15,170]],
    MIG:[[1,3,80],[3,6,140],[6,12,200]],
    TIG:[[1,2,45],[2,4,70],[4,6,100],[6,10,140]],
  };
  const POS_AMP_MUL = {1:1.0,2:0.95,3:0.90,4:0.85,5:0.80};
  // Długość łuku — 1:1 z index.html. Runda bez `arc` (dotyk, demo, wszystko sprzed 2.0.0)
  // przechodzi z łukiem wyłączonym i liczy się bit-w-bit jak 1.5.0.
  const ELEC_DIA = {2:2.0,3:2.5,5:3.25,8:4.0,12:4.0};
  const ARC_RISE = 1.0, ARC_PUSH = 3.5, ARC_LIFT = 1.5, ARC_STICK_T = 0.80;
  const ELEC_TRAVEL_ARC = 1000, ARC_BURN_S = 55;   // zapas drogi i czas jarzenia na całą elektrodę (1:1 z grą)
  const ARC_MAX_MUL = 3.2, ARC_V_SLOPE = 2.4, ARC_LO = 0.6, ARC_HI = 1.6;
  const VOLT_TABLES = {
    MMA:[[1,3,20],[3,6,22],[6,10,24],[10,15,26]],
    MIG:[[1,3,18],[3,6,22],[6,12,26]],
    TIG:[[1,2,11],[2,4,12],[4,6,13],[6,10,14]],
  };
  function recommendedVolts(p, t) { const tbl = VOLT_TABLES[p]; if (!tbl) return null;
    for (const [lo,hi,v] of tbl) if (lo < t && t <= hi) return v; return null; }
  function arcPenNow(r) { return r < ARC_LO ? Math.min(25, (ARC_LO - r) * 70) : r > ARC_HI ? Math.min(25, (r - ARC_HI) * 35) : 0; }
  // ── KĄT ELEKTRODY (3.0.0) — 1:1 z index.html ──
  // Dwa kąty, tak jak uczą w szkole i jak liczą je symulatory AR:
  //   • ROBOCZY (wa)      — odchyłka od dwusiecznej złącza, mierzona w poprzek jazdy;
  //   • POCHYLENIA (ta)   — ciągnięcie / pchanie, mierzone WZGLĘDEM kierunku jazdy,
  //     więc ta sama liczba znaczy to samo na prostej, na pionie i na obwodzie rury.
  // Obie to ODCHYŁKI OD WPS (jak `amps`), nie kąty bezwzględne. Gracz, który nie dotknie
  // klawiatury, stoi dokładnie na zaleceniu (MMA +10° ciągnięcia) i NIE płaci nic — inaczej
  // mechanika byłaby pułapką, a nie umiejętnością. Runda bez `ang` liczy się bit-w-bit jak 2.0.0.
  const DEG = Math.PI / 180;
  const ANG_RATE = 42;                        // [°/s] tempo obrotu przy trzymanym klawiszu
  const WA_MAX = 35, TA_MAX = 45;             // zakres odchyłki [°]
  const TA_IDEAL = { MMA: 10, MIG: -8, TIG: -15 };   // kąt WPS: + ciągnięcie (drag), − pchanie (push)
  const WA_BAND = 8, TA_BAND = 9;             // pasmo bez kary [°]
  const ANG_PEN_CAP = 28;
  // Pasmo kąta roboczego zwęża się z trudnością pozycji: w pułapowej ręka ma mniej luzu niż w podolnej.
  function waBandFor(posK) { return WA_BAND * (1 - 0.08 * ((POSITIONS[posK].stars || 1) - 1)); }
  function angOverW(wa, posK) { return Math.max(0, Math.abs(wa) - waBandFor(posK)); }
  function angOverT(ta) { return Math.max(0, Math.abs(ta) - TA_BAND); }
  // Kara CHWILOWA, całkowana po czasie — na średniej ktoś machający +30 ↔ −30 wyszedłby idealnie.
  function angPenNow(wa, ta, posK) {
    return Math.min(ANG_PEN_CAP, Math.min(20, angOverW(wa, posK) * 1.1) + Math.min(20, angOverT(ta) * 0.9)); }
  // Pchana elektroda rozlewa jeziorko szeroko i płytko, ciągnięta ściąga je w wąskie. Przy 0 wychodzi 1.
  function angWFac(ta) { return Math.max(0.82, Math.min(1.20, 1 - ta * 0.006)); }
  // Krzywo trzymana elektroda kładzie ścieg OBOK osi rowka. Przesunięcie jest CELOWO małe
  // (sufit 0,45·grooveHalf przy progu pokrycia 1,6·grooveHalf): ma być WIDAĆ, że ścieg ucieka,
  // ale nie wolno mu zablokować przejścia na następną warstwę. Kara siedzi w `angPen`, nie w geometrii
  // — dokładnie ta lekcja co przy prądzie w 1.5.0.
  const OFF_CAP = 1.6, OFF_SLOPE = 22, OFF_PEN_CAP = 18, OFF_MAJOR = 15;   // odchyłka toru (3.2.0)
  // SPOIWO TIG (3.3.0) — druga ręka podaje pręt SPACJĄ. Rytm liczony po DRODZE między dabami,
  // nie po czasie: przy wolniejszym posuwie dabuje się rzadziej i to jest poprawne.
  // Idealny odstęp = ten, który dawał stary automat 150 ms przy tempie z WPS.
  const FIL_DT = 0.15, FIL_LO = 0.6, FIL_HI = 1.6, FIL_PEN_CAP = 20, FIL_MAJOR = 17;   // spoiwo TIG (3.3.0)

  // ── WKŁAD CIEPŁA (3.4.0) ────────────────────────────────────────────────────────────────────
  // Na materiale badanym udarnościowo max heat input z WPS to LIMIT KODU, nie preferencja:
  // procedura kwalifikowana z próbą udarności ma HI jako zmienną istotną dodatkową
  // (ASME IX QW-409.1; analogicznie AWS D1.1 dla procedur z CVN). Przekroczysz — kwalifikacja
  // CVN NIE POKRYWA złącza produkcyjnego i złącze leci NIEZALEŻNIE od tego, jak ładne jest lico.
  // Dlatego to WARUNEK DOPUSZCZENIA (wada major → REJECT), a NIE kolejny człon kary: punktów za
  // to nie odejmujemy, bo to nie jest wada wykonania — spoina może być bez zarzutu i i tak odpaść.
  // Dół zostaje płynny i nietknięty: za mały wkład ciepła gra już karze brakiem wtopu i pokryciem.
  const WELD_EFF = { MMA: 0.8, MIG: 0.8, TIG: 0.6 };   // sprawność cieplna procesu — 1:1 z index.html
  const HI_MAX_R = 1.25;        // górna granica zakresu z WPS = te same 25%, które gra pokazuje na pasku HI
  const CVN_BEADS = { steel: 1 };   // stal węglowa. Austenityczna nierdzewka i alu — bez próby udarności, bez limitu
  function heatInputKJmm(volts, amps, travelMmS, eff) { if (!travelMmS) return null;
    const travelMmMin = travelMmS * 60; return Math.round((volts * amps * 60) / (travelMmMin * 1000) * eff * 1000) / 1000; }
  function filPenNow(r){ return r < FIL_LO ? Math.min(25, (FIL_LO - r) * 40)
                       : r > FIL_HI ? Math.min(25, (r - FIL_HI) * 22) : 0; }
  function angOffPx(wa, gh) { const m = gh * 0.45; return Math.max(-m, Math.min(m, wa * 0.03 * gh)); }
  function recommendedAmps(p, t, posK) {
    const tbl = AMP_TABLES[p]; if (!tbl) return null;
    let base = null; for (const [lo,hi,v] of tbl) if (lo < t && t <= hi) { base = v; break; }   // pierwszy trafiony, jak tableLookup()
    if (base == null) return null;
    return Math.round(base * (POS_AMP_MUL[POSITIONS[posK].stars] || 1));
  }
  const BASE_REWARD = 50;
  const ELEC_STUB = 0.16;
  const V_TAU = 0.045;            // stała czasowa wygładzania prędkości [s]
  const V_TICK = 0.016;           // referencyjny takt [s] — skala `instab`
  const SPATTER_PEN_CAP = 15;     // sufit kary za odpryski
  // Prędkość mierzymy z PRZEMIESZCZENIA w oknie V_WIN, nie z sumy odcinków między próbkami.
  // Tempo docelowe TIG 5 mm to 35,8 px/s = 0,57 px na klatkę 60 Hz, czyli mniej niż piksel.
  // Drżenie ręki i zaokrąglenie kursora do pikseli dokładają ~1 px do KAŻDEJ próbki, więc suma
  // odcinków rosła wraz z częstotliwością próbkowania: ten sam idealny spaw dawał 65 pkt przy
  // 250 Hz i 99 pkt przy 20 Hz. Okno patrzy tylko na pozycje odległe o V_WIN — szum się kasuje.
  // 1.4.0 — odpryski przestały być STAŁĄ kary. Do 1.3.0 `spatterCount` zależał wyłącznie od
  //         `proc`/`thick`/czasu łuku, więc idealny przebieg MMA tracił 7 pkt przy 3 mm i 14 pkt
  //         przy 12 mm — sufit wynosił 93, a 8/12 mm NIE MOGŁY dostać A nawet zagrane bezbłędnie.
  //         Teraz mnożnik `spatFac` = odchyłka tempa od docelowego / 0,30 (sufit 2×): tempo w oknie
  //         = zero odprysków = 100 pkt, galop 200% = 26–31 odprysków. Kara mierzy grę, nie ustawienia.
  //         Rundy nagrane silnikiem 1.3.0 i starszym NIE są porównywalne z 1.4.0.
  // 1.3.0 — okno 0,05 s radziło sobie z szumem myszy, ale nie z KWANTYZACJĄ kursora do pikseli CSS.
  // Krok siatki w play-space = 1280/rect.width, więc w oknie 800 px to 1,6 px, a przemieszczenie
  // w 50 ms przy tempie MMA 5 mm to 2,56 px — schodki dawały skok prędkości rzędu 100%, `instab`
  // czytał to jako drżenie ręki i doliczał 2 pkt porowatości (−10 pkt) każdemu w mniejszym oknie.
  const V_WIN = 0.10;             // okno pomiaru prędkości [s]

  function simulate(round) {
    const { seed, W, H, proc, joint, pos: posKey, thick, bead, amps, arc, ang, events } = round;
    const rng = mulberry32(seed >>> 0);
    const P = POSITIONS[posKey];

    // ── Prąd gracza (1.5.0) ──
    // `amps` brak / równe zaleceniu WPS ⇒ ar=1 ⇒ wszystkie współczynniki 1/false i silnik
    // liczy bit-w-bit jak 1.4.0. Rundy sprzed 1.5.0 (bez pola `amps`) replayują się identycznie.
    const ampRec = recommendedAmps(proc, thick, posKey);
    const ampAr = (ampRec && amps) ? amps / ampRec : 1;
    const ampF = { ar: ampAr, w: Math.pow(ampAr, 0.55),
                   pen: ampAr < 1 ? Math.min(30, (1 - ampAr) * 70) : Math.min(30, (ampAr - 1) * 50),
                   sev: ampAr === 1 ? null : (Math.abs(ampAr - 1) >= 0.25 ? "major" : "minor"),
                   spatAdd: ampAr > 1 ? (ampAr - 1) * 2 : 0,
                   por: ampAr < 0.85 ? Math.round((0.85 - ampAr) * 6) : 0 };

    // ── łuk (2.0.0) ──
    const arcLive = !!arc;
    const arcL0 = ELEC_DIA[thick] || 2.5;
    let arcLen = 0, btnMask = 0, stickCount = 0, arcBroke = 0, contactT = 0;
    let arcPenAcc = 0, arcTime = 0, arcVSum = 0, arcPorAcc = 0, arcRSum = 0;

    // ── kąt (3.0.0) ──
    const angLive = !!ang;
    // 3.3.0 — TIG MA WŁASNE STEROWANIE. LPM zapala łuk, PPM go gasi, a spoina powstaje WYŁĄCZNIE
    // tam, gdzie gracz dołoży spoiwo spacją: sam łuk grzeje blachę i nic nie odkłada. Długość łuku
    // NIE jest modelowana — obie ręce mają inne zadania, więc `arcLen` stoi na nominale (kara 0).
    // Flaga `tig` jest w każdej rundzie TIG nagranej od 3.3.0; starsze idą dawną ścieżką = parytet.
    const tigLive = !!round.tig && proc === "TIG";
    // Jak `tig`: flaga jest w każdej rundzie nagranej od 3.4.0. Rundy starsze jej nie mają i idą
    // dawną ścieżką — bez limitu HI, bit-w-bit jak 3.3.0. Inaczej stare nagrania stali zaczęłyby
    // nagle wracać jako REJECT za regułę, której w chwili spawania nie było.
    const cvn = !!round.cvn && !!CVN_BEADS[bead];
    let waDeg = 0, taDeg = 0, keyMask = 0;
    let angPenAcc = 0, angTime = 0, angPorAcc = 0, angWSum = 0, angTSum = 0;
    // Kąt rusza się WYŁĄCZNIE w trakcie jazdy (na zdarzeniach `move`), tak samo jak długość łuku.
    // Gdyby dało się go przekręcić przed zajarzeniem, replay startowałby z innej pozycji niż ekran.
    function angOff() { return angLive ? angOffPx(waDeg, grooveHalf) : 0; }

    // ── passy ──
    function passPlan() { if (thick <= 3) return ["cap"]; if (thick <= 5) return ["root","cap"]; return ["root","fill","cap"]; }
    const passPlanArr = passPlan();
    let passIndex = 0, passMul = PASS_W[passPlanArr[0]];

    // ── geometria (recalc + buildWorkpiece, cy=H*0.66) ──
    let grooveHalf, bevelW, idealHalf, targetPx;
    function recalc() {
      grooveHalf = 3 + thick * 0.7; bevelW = 7 + thick * 1.3;
      idealHalf = grooveHalf * 1.25 * passMul; targetPx = SPEED[thick] * PX_PER_MM * PROCESS[proc].vMul;
    }
    recalc();
    const seamPts = [];
    (function buildSeam() {
      const cx = W / 2, cy = H * 0.66;
      if (P.pipe) {
        const r = Math.min(W, H) * 0.30, tilt = (P.tilt || 0) * Math.PI / 180;
        const yS = P.pipe === "flat" ? 0.40 : P.pipe === "wall" ? 1.0 : 0.6;
        for (let a = 0; a <= Math.PI * 2 + 0.001; a += Math.PI / 110) { const x = Math.cos(a) * r, y = Math.sin(a) * r * yS;
          seamPts.push({ x: cx + x * Math.cos(tilt) - y * Math.sin(tilt), y: cy + x * Math.sin(tilt) + y * Math.cos(tilt) }); }
      } else {
        const len = Math.min(W, H) * 0.62, ang = P.ang * Math.PI / 180, dx = Math.cos(ang), dy = Math.sin(ang);
        for (let t = -1; t <= 1.0001; t += 2 / 150) seamPts.push({ x: cx + dx * len / 2 * t, y: cy + dy * len / 2 * t });
      }
    })();

    // ── helpery geometrii (1:1) ──
    function nearestSeam(x, y) { let d = 1e18, px = x, py = y; for (const p of seamPts) { const dd = (p.x - x) ** 2 + (p.y - y) ** 2; if (dd < d) { d = dd; px = p.x; py = p.y; } } return { d: Math.sqrt(d), x: px, y: py }; }
    function plateHalf() { return grooveHalf + bevelW + 75; }
    function onPlate(x, y) { return nearestSeam(x, y).d <= plateHalf(); }

    // ── stan rundy (jak globalne w grze) ──
    let baked = [], speedSum = 0, speedN = 0, vVarSum = 0, spatterCount = 0, distAcc = 0;
    let vSumT = 0, vTimeS = 0, depCarry = 0, passWeldMs = 0;
    let electrodeLeft = 1, replacing = false, vEMA = targetPx;
    let last = null, lastT = 0, lastDab = 0, ux = 1, uy = 0;
    let filPenAcc = 0, filCount = 0, lastDabPos = null;
    let trail = [];                 // {t,x,y} z ostatnich V_WIN sekund — baza pomiaru prędkości
    let tickAcc = 0, vTickRef = targetPx;   // `instab` próbkowana na stałym takcie, nie na zdarzeniu
    const passLog = [];

    function beadWidth() { const sr = vEMA / targetPx; let w;
      if (sr < 0.7) w = Math.min(idealHalf * 1.9, idealHalf * Math.pow(0.7 / Math.max(sr, 0.08), 0.55));
      else if (sr > 1.3) w = Math.max(idealHalf * 0.42, idealHalf * Math.pow(1.3 / sr, 0.7));
      else w = idealHalf;
      const arcW = arcLive ? Math.min(1.6, Math.max(0.62, Math.pow(Math.max(0.15, arcLen / arcL0), 0.35))) : 1;
      return w * ampF.w * arcW * (angLive ? angWFac(taDeg) : 1); }   // 1:1 z arcWFac()/angWFac() w index.html
    function depositBead(x, y, w) { const ns = nearestSeam(x, y);
      if (ns.d < grooveHalf + bevelW) { x += (ns.x - x) * 0.4; y += (ns.y - y) * 0.4; }
      const jit = proc === "MMA" ? (rng() * 0.18 - 0.09) * w : 0;   // jedyny pobór z rng (jak w grze)
      x += jit; baked.push({ x, y, r: w, off: ns.d }); return { x, y }; }

    function passMetrics() {
      const K = seamPts.length; let covered = 0; const gaps = [];
      for (let i = 0; i < K; i++) { const p = seamPts[i]; let d = 1e18; for (const b of baked) { const dd = (b.x - p.x) ** 2 + (b.y - p.y) ** 2; if (dd < d) d = dd; }
        if (Math.sqrt(d) < grooveHalf * 1.6) covered++; else gaps.push(p); }
      const coverage = K ? covered / K : 0;
      let out = 0, narrow = 0, wide = 0, rs = [];
      for (const b of baked) { if (b.off > grooveHalf + bevelW * 0.7) out++; if (b.r < grooveHalf * 0.9) narrow++; if (b.r > idealHalf * 1.65) wide++; rs.push(b.r); }
      const overflow = baked.length ? out / baked.length : 0;
      // 3.2.0 — ODCHYŁKA TORU OD GRANI jako ZBOCZE, nie schodek. Do 3.1.0 zjechanie z osi
      // kosztowało DOKŁADNIE ZERO aż do progu `out`, a tuż za nim leciał od razu REJECT —
      // bo `depositBead()` przyciąga kroplę 40% z powrotem do grani i `coverage` tego nie widzi.
      // `b.off` to odległość RĘKI GRACZA od osi, zapisana PRZED tym przyciągnięciem, więc mierzy
      // technikę, a nie rysunek. Zero w rowku (tam ścieg ma prawo być), potem liniowo aż do progu
      // podtopienia. Kara siedzi we WŁASNYM członie, nie w `coverage` — ten sam licznik przełącza
      // warstwy, więc obcięcie go zablokowałoby grę przy krzywym torze.
      let offSum = 0;
      for (const b of baked) offSum += Math.min(OFF_CAP, Math.max(0, (b.off - grooveHalf) / (bevelW * 0.7)));
      const offPen = baked.length ? Math.min(OFF_PEN_CAP, (offSum / baked.length) * OFF_SLOPE) : 0;
      const mean = rs.reduce((a, v) => a + v, 0) / (rs.length || 1);
      const evenness = rs.length ? Math.max(0, 1 - (Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / rs.length) / mean) * 1.4) : 0;
      const tol = MATERIAL[bead].tol;
      const avgV = vTimeS ? vSumT / vTimeS : targetPx, spdAcc = Math.max(0, 1 - Math.abs(avgV - targetPx) / (targetPx * tol));
      const ticks = Math.max(1, vTimeS / V_TICK);
      const instab = vTimeS ? vVarSum / ticks : 0; const porosity = Math.max(0, Math.round((instab / 8 + (proc === "MIG" && spdAcc < 0.4 ? 2 : 0)) / tol)) + ampF.por;
      const weldSec = Math.max(0.5, passWeldMs / 1000);
      const spatter = Math.round((spatterCount / weldSec) * PROCESS[proc].sparks / 40);
      let endGap = 0; for (const e of [seamPts[0], seamPts[K - 1]]) { let d = 1e18; for (const b of baked) { const dd = (b.x - e.x) ** 2 + (b.y - e.y) ** 2; if (dd < d) d = dd; } if (Math.sqrt(d) > grooveHalf * 1.7) endGap++; }
      return { coverage, overflow, evenness, spdAcc, porosity, spatter, narrow, wide, out, gaps, avgV, endGap, offPen };
    }
    function bankReset() { passLog.push(passMetrics());
      baked = []; speedSum = 0; speedN = 0; vVarSum = 0; spatterCount = 0; distAcc = 0;
      vSumT = 0; vTimeS = 0; passWeldMs = 0; depCarry = 0; tickAcc = 0; vTickRef = vEMA;
      passIndex++; passMul = PASS_W[passPlanArr[passIndex]] || 1; recalc(); }

    // ── replay zdarzeń ──
    for (const ev of events) {
      if (ev.type === "down") { last = { x: ev.x, y: ev.y }; lastT = ev.t; vEMA = targetPx; lastDab = ev.t;
        btnMask = ev.b | 0; arcLen = 0; contactT = 0;   // dotyk blachy = zajarzenie
        trail = [{ t: ev.t, x: ev.x, y: ev.y }];
        if (replacing) { electrodeLeft = 1; replacing = false; } continue; }
      if (ev.type === "up") { last = null; continue; }
      if (ev.type === "bank") { bankReset(); continue; }
      if (ev.type !== "move" || !last) continue;
      const p = { x: ev.x, y: ev.y }, now = ev.t;
      if (arcLive && !onPlate(p.x, p.y)) { last = null; continue; }   // zjazd z blachy gasi łuk (1:1 z grą)
      const ddx = p.x - last.x, ddy = p.y - last.y, dist = Math.hypot(ddx, ddy);
      const dtS = Math.min(0.25, Math.max(0.001, (now - lastT) / 1000));
      if (tigLive) {
        btnMask = ev.b | 0;
        if (btnMask & 2) { last = null; continue; }              // PPM = świadome zgaszenie łuku (bez kary)
        arcLen = arcL0;                                          // łuk trzymany na nominale → arcWFac 1, arcPen 0
      } else if (arcLive) {
        btnMask = ev.b | 0;
        // 3.1.0 — LPM+PPM RAZEM = świadome zgaszenie łuku. Odróżnione od zerwania (odciągnięcia
        // za daleko): tam gracz TRACI łuk i płaci `arcBroke`, tu go GASI i nie płaci nic ponad
        // to, czego i tak nie zaspawał. Wcześniej oba przyciski naraz dawały netto −1,0 mm/s,
        // więc gest był wolny — stąd tu, a nie na osobnym klawiszu.
        if ((btnMask & 3) === 3) { last = null; continue; }
        arcLen += (ARC_RISE + ((btnMask & 2) ? ARC_LIFT : 0) - ((btnMask & 1) ? ARC_PUSH : 0)) * dtS;
        if (arcLen <= 0) { arcLen = 0; contactT += dtS;
          if (contactT >= ARC_STICK_T) { stickCount++; last = null; continue; }        // przywarcie
        } else contactT = 0;
        if (arcLen >= arcL0 * ARC_MAX_MUL) { arcLen = arcL0 * ARC_MAX_MUL; arcBroke++; last = null; continue; }  // zerwany łuk
        const r = arcLen / arcL0;
        arcPenAcc += arcPenNow(r) * dtS; arcTime += dtS; arcRSum += r * dtS;
        arcVSum += (recommendedVolts(proc, thick) + ARC_V_SLOPE * (arcLen - arcL0)) * dtS;
        if (r > ARC_HI) arcPorAcc += (r - ARC_HI) * dtS;
        if (proc === "MMA" && !replacing) { electrodeLeft -= dtS / ARC_BURN_S;   // łuk zjada elektrodę w czasie
          if (electrodeLeft <= ELEC_STUB) { replacing = true; last = null; continue; } }
      }
      if (angLive) {
        keyMask = ev.k | 0;                                          // A/D = roboczy, W/S = pochylenia
        const kd = ((keyMask & 2) ? 1 : 0) - ((keyMask & 1) ? 1 : 0);
        const ks = ((keyMask & 8) ? 1 : 0) - ((keyMask & 4) ? 1 : 0);
        if (kd) waDeg = Math.max(-WA_MAX, Math.min(WA_MAX, waDeg + kd * ANG_RATE * dtS));
        if (ks) taDeg = Math.max(-TA_MAX, Math.min(TA_MAX, taDeg + ks * ANG_RATE * dtS));
        angPenAcc += angPenNow(waDeg, taDeg, posKey) * dtS; angTime += dtS;
        angWSum += Math.abs(waDeg) * dtS; angTSum += taDeg * dtS;
        const tOv = angOverT(taDeg); if (tOv > 0) angPorAcc += tOv / 120 * dtS;   // żużel przed łukiem → wtrącenia
      }
      trail.push({ t: now, x: p.x, y: p.y });
      while (trail.length > 2 && (now - trail[0].t) / 1000 > V_WIN) trail.shift();
      const ref = trail[0], span = Math.max(0.001, (now - ref.t) / 1000);
      // Prędkość z REGRESJI LINIOWEJ po całym oknie, nie z różnicy jego końców: różnica końców bierze
      // błąd kwantyzacji obu skrajnych próbek w całości, regresja rozkłada go na wszystkie i tłumi ~√N.
      let inst;
      if (trail.length >= 3) {
        let st = 0, sx = 0, sy = 0; const n = trail.length;
        for (const q of trail) { st += q.t; sx += q.x; sy += q.y; }
        const mt = st / n, mx = sx / n, my = sy / n;
        let stt = 0, stx = 0, sty = 0;
        for (const q of trail) { const d = q.t - mt; stt += d * d; stx += d * (q.x - mx); sty += d * (q.y - my); }
        inst = stt > 0 ? Math.hypot(stx / stt, sty / stt) * 1000 : Math.hypot(p.x - ref.x, p.y - ref.y) / span;
      } else inst = Math.hypot(p.x - ref.x, p.y - ref.y) / span;
      const aEMA = 1 - Math.exp(-dtS / V_TAU);
      vEMA = vEMA + (inst - vEMA) * aEMA;
      // suma modułów jest ≥ modułu sumy, więc licząc na KAŻDYM zdarzeniu mysz 250 Hz dostawała
      // czterokrotnie więcej przyrostów na ten sam ruch ręki niż 60 Hz. Takt to wyrównuje.
      tickAcc += dtS;
      while (tickAcc >= V_TICK) { tickAcc -= V_TICK; vVarSum += Math.abs(vEMA - vTickRef); vTickRef = vEMA; }
      const w = beadWidth(); if (dist) { ux = ddx / dist; uy = ddy / dist; }
      const ao = angOff(), aox = -uy * ao, aoy = ux * ao;            // krzywy kąt roboczy = ścieg obok osi rowka
      if (proc === "TIG") {
        // 3.3.0 — bit 16 maski klawiszy to POJEDYNCZY dab spacją (zbocze, nie stan trzymania),
        // zatrzaśnięty w grze do najbliższego `move`, żeby krótkie stuknięcie nie przepadło
        // między zdarzeniami.
        // Bez `tig` (rundy sprzed 3.3.0) zostaje dawny automat co 150 ms.
        const dab = tigLive ? !!((ev.k | 0) & 16) : (now - lastDab > 150);
        if (dab && onPlate(p.x + aox, p.y + aoy)) { const dw = Math.max(idealHalf, w * 0.95);
          const pl = depositBead(p.x + aox, p.y + aoy, dw); lastDab = now;
          if (tigLive) { if (lastDabPos) { const gap = Math.hypot(pl.x - lastDabPos.x, pl.y - lastDabPos.y);
              filPenAcc += filPenNow(gap / Math.max(1e-6, targetPx * FIL_DT)); filCount++; }
            lastDabPos = { x: pl.x, y: pl.y }; } }
      } else {
        const step = Math.max(2, w * 0.35); depCarry += dist;
        const n = Math.floor(depCarry / step); if (n > 0) depCarry -= n * step;
        for (let i = 1; i <= n; i++) { const x = last.x + ddx * (i / n) + aox, y = last.y + ddy * (i / n) + aoy;
          if (!onPlate(x, y)) continue;
          if (proc === "MMA") { if (replacing) break; electrodeLeft -= step / (arcLive ? ELEC_TRAVEL_ARC : 650);
            if (electrodeLeft <= ELEC_STUB) { replacing = true; break; } }
          depositBead(x, y, w); distAcc += step; }
      }
      // 1.4.0: tempo poza oknem = rozprysk (1:1 z index.html). Kara przestała być stałą dla
      // danego proc/thick — idealny przebieg nie płaci za nic, zły płaci do 2×.
      let spatFac = Math.min(2, Math.abs(vEMA / targetPx - 1) / 0.30);
      if (ampF.spatAdd) spatFac = Math.min(2.6, spatFac + ampF.spatAdd);
      if (arcLive) { const rr = arcLen / arcL0; if (rr > ARC_HI) spatFac = Math.min(3.2, spatFac + (rr - ARC_HI) * 1.2); }
      if (angLive) { const so = angOverT(taDeg); if (so > 0) spatFac = Math.min(3.2, spatFac + Math.min(0.8, so / 45)); }
      spatterCount += Math.round((3 + (thick >> 1)) * PROCESS[proc].sparks) * spatFac * (dtS * 1000 / 16); passWeldMs += dtS * 1000;
      vSumT += vEMA * dtS; vTimeS += dtS;
      speedSum += vEMA; speedN++;
      last = p; lastT = now;
    }

    // ── inspekcja (1:1 z inspect()) ──
    const K = seamPts.length;
    const cur = passMetrics(), all = passLog.concat([cur]), n = all.length, avg = k => all.reduce((a, m) => a + m[k], 0) / n;
    const coverage = avg("coverage"), spdAcc = avg("spdAcc"), evenness = avg("evenness");
    const overflow = Math.max.apply(null, all.map(m => m.overflow));
    const arcPen = arcTime ? arcPenAcc / arcTime : 0, arcR = arcTime ? arcRSum / arcTime : 1;
    const arcFails = stickCount + arcBroke;
    const angPen = angTime ? angPenAcc / angTime : 0;
    const angW = angTime ? angWSum / angTime : 0, angT = angTime ? angTSum / angTime : 0;
    const porosity = all.reduce((a, m) => a + m.porosity, 0) + Math.round(arcPorAcc) + Math.round(angPorAcc);
    const spatter = Math.round(avg("spatter"));   // tempo — uśredniamy po passach, nie sumujemy
    const endGap = Math.max.apply(null, all.map(m => m.endGap));
    const offPen = avg("offPen");
    const filPen = filCount ? Math.min(FIL_PEN_CAP, filPenAcc / filCount) : 0;
    const rootCov = (passPlanArr[0] === "root" && passLog.length) ? passLog[0].coverage : 1;

    // HI liczony DOKŁADNIE tak, jak raport w grze: napięcie z przebiegu łuku (dłuższy łuk = wyższe U),
    // prąd GRACZA i JEGO tempo. `arcTime` rośnie wyłącznie przy żywym łuku, więc na dotyku i przy TIG
    // (brak modelu długości łuku) schodzimy na napięcie z WPS — tak samo jak index.html.
    const vWps = recommendedVolts(proc, thick), effP = WELD_EFF[proc] || 0.8;
    const ampsUse = (ampRec && amps) ? amps : ampRec;
    const uAct = arcTime ? arcVSum / arcTime : vWps;
    const hiWps = (vWps != null && ampRec != null) ? heatInputKJmm(vWps, ampRec, targetPx / PX_PER_MM, effP) : null;
    const hiAct = (uAct != null && ampsUse != null) ? heatInputKJmm(uAct, ampsUse, cur.avgV / PX_PER_MM, effP) : null;
    const hiMax = hiWps != null ? Math.round(hiWps * HI_MAX_R * 1000) / 1000 : null;
    const hiOver = !!(cvn && hiMax != null && hiAct != null && hiAct > hiMax);

    let score = coverage * 50 + spdAcc * 20 + evenness * 15 + (1 - overflow) * 15
              - porosity * 5 - Math.min(SPATTER_PEN_CAP, proc === "TIG" ? spatter * 3 : spatter * 0.5)
              - ampF.pen - arcPen - Math.min(15, arcFails * 4) - angPen - offPen - filPen;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // wady major (do oceny ISO / odrzutu) — te same progi co w grze
    const Dmajor =
      (coverage < 0.6) ||
      (overflow > 0.3) ||
      (porosity > 3) ||
      (endGap > 1) ||
      (passPlanArr[0] === "root" && rootCov < 0.8) ||
      (ampF.sev === "major") ||
      (arcPen >= 12) || (arcFails > 2) ||
      (angPen >= 10) || (offPen >= OFF_MAJOR) || (filPen >= FIL_MAJOR) ||
      hiOver;                       // poza zakresem kwalifikacji WPS — ocena lica tego nie ratuje

    const letter = score >= 90 ? "A" : score >= 78 ? "B" : score >= 62 ? "C" : score >= 45 ? "D" : "F";
    const iso = (Dmajor || score < 50) ? "REJECT" : score >= 88 ? "B" : score >= 72 ? "C" : "D";

    // ekonomia (do parytetu wypłaty)
    const mb = { MIG:1.0, MMA:1.6, TIG:2.2 }[proc];
    const pm = [0,1.0,1.25,1.6,2.1,2.8][P.stars] || 1;
    const jm = joint === "pipe" ? 1.3 : joint === "fillet" ? 0.9 : 1.0;
    const mf = MATERIAL[bead][proc] || 1;
    const pf = 1 + 0.18 * (passPlanArr.length - 1);
    const difficulty = mb * pm * jm * mf * pf;

    return { score, letter, iso, coverage, spdAcc, evenness, overflow, porosity, spatter, endGap, baked: baked.length, passes: passPlanArr.length, difficulty: +difficulty.toFixed(2), amps: ampRec && amps ? amps : ampRec, ampsWps: ampRec, ampPen: +ampF.pen.toFixed(2),
             arcPen: +arcPen.toFixed(2), arcR: +arcR.toFixed(3), stickCount, arcBroke,
             angPen: +angPen.toFixed(2), offPen: +offPen.toFixed(2), filPen: +filPen.toFixed(2), filDabs: filCount, waDeg: +waDeg.toFixed(2), taDeg: +taDeg.toFixed(2),
             angW: +angW.toFixed(2), angT: +angT.toFixed(2), taIdeal: TA_IDEAL[proc] != null ? TA_IDEAL[proc] : 0,
             volts: arcTime ? +(arcVSum / arcTime).toFixed(2) : recommendedVolts(proc, thick),
             hi: hiAct, hiWps, hiMax, hiOver, cvn };
  }

  // 3.0.0 — KĄT ELEKTRODY z klawiatury: A/D kąt roboczy, W/S pochylenia (ciągnięcie ↔ pchanie).
  //         Mysz nie ma już wolnej osi — obie zajmuje pozycja, oba przyciski długość łuku — więc
  //         druga ręka idzie na klawiaturę. To jest zresztą prawdziwa postawa: elektroda w jednej
  //         ręce, druga podpiera. Obie liczby to ODCHYŁKI OD WPS, więc kto nie dotknie klawiszy,
  //         stoi na zaleceniu i nie płaci nic; runda bez flagi `ang` liczy się bit-w-bit jak 2.0.0.
  //         Kąt rusza się wyłącznie na zdarzeniach `move` (jak długość łuku) — inaczej dałoby się
  //         przekręcić go przed zajarzeniem i replay startowałby z innej pozycji niż ekran.
  //         ⚠ Przesunięcie ściegu w bok jest CELOWO za małe, żeby zbić `coverage` poniżej 0,9:
  //         ten sam licznik przełącza warstwy, więc kara musi siedzieć w `angPen` — jak w 1.5.0.
  // 2.0.0 — DŁUGOŚĆ ŁUKU z dwóch przycisków myszy. LPM to DOTYK BLACHY: nim się zajarza, a trzymany
  //         za długo (ARC_STICK_T) powoduje przywarcie. Puszczony — elektroda odjeżdża sama, bo się topi.
  //         Łuk pali się niezależnie od przycisków; kończy go przywarcie albo odciągnięcie za daleko.
  //         Zdarzenia niosą teraz maskę przycisków `b`, a runda flagę `arc`. Bez `arc` (dotyk = demo,
  //         każda runda sprzed 2.0.0) model jest WYŁĄCZONY i wynik wychodzi bit-w-bit jak 1.5.0.
  //         Łuk domyka równanie wkładu ciepła: napięcie przestało być stałą z tablicy, więc U, I oraz v
  //         są już wszystkie w rękach gracza. Kara liczona CHWILOWO i całkowana po czasie — na średniej
  //         ktoś skaczący 0,2 ↔ 3,0 wyszedłby idealnie.
  // 1.5.0 — PRĄD stał się parametrem gracza. `round.amps` (absolutne ampery) porównywane z
  //         zaleceniem WPS daje `ar`; przy ar=1 każdy współczynnik wynosi 1/false, więc wynik jest
  //         BIT-W-BIT taki jak 1.4.0 — rundy 1.4.0 i rundy zagrane „po WPS" pozostają porównywalne.
  //         Kara `pen` jest ODJEMNIKIEM (jak porowatość), nie kolejną wagą dodatnią — suma wag
  //         dodatnich zostaje 100 i idealny przejazd po WPS nadal sięga sufitu.
  //         ⚠ Pierwsze podejście liczyło prąd przez GEOMETRIĘ (próg pokrycia i rozlanie ściegu).
  //         Pomiar 2026-08-31 pokazał, że to martwe: przy spawaniu środkiem rowka odległość ścieg↔szew
  //         jest bliska zeru, więc zwężenie progu nic nie zmienia, a 130% prądu dawało dalej 100 pkt.
  //         Kary NIE wolno też wpiąć w `coverage` — ten licznik napędza pasek live i przejście na
  //         następną warstwę (>=0,9), więc obcięcie go zablokowałoby grę przy niskim prądzie.
  // 1.3.0 — prędkość z regresji liniowej po oknie 0,10 s + `instab` próbkowana na stałym takcie:
  //         wynik przestał zależeć od SZEROKOŚCI OKNA (kwantyzacja kursora do pikseli CSS).
  //         Zmierzone na 8 rękach × 3 Hz × 8 szerokości 500–1920 px: różnica średnich 12,0 → 1,6 pkt.
  //         Dzięki temu próg `CHAL_MIN_W` schodzi z 1000 na 600 px i konkurs otwiera się na telefony.
  // 1.2.0 — prędkość z przemieszczenia w oknie V_WIN: wynik przestał zależeć od Hz myszy
  //         i od rozmiaru okna przeglądarki (kwantyzacja kursora do pikseli). Przed poprawką
  //         ten sam ruch dawał od 0 do 98 pkt zależnie od sprzętu.
  // 1.1.0 — spatter jako tempo z sufitem kary, metryki niezależne od Hz, parytet z index.html.
  // Rundy nagrane silnikiem 1.2.0 i starszym liczą się inaczej i NIE są porównywalne z challengem.
  const API = { simulate, mulberry32, recommendedAmps, recommendedVolts, heatInputKJmm, VERSION: "3.4.0" };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.ArcSim = API;
})(typeof self !== "undefined" ? self : this);
