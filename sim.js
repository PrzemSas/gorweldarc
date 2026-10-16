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
  // Dół: za mały wkład ciepła z ZA SZYBKIEGO przejazdu łapie FAST_TOL niżej (3.6.0, flaga `uf`) — pokrycie tego nie widziało.
  const WELD_EFF = { MMA: 0.8, MIG: 0.8, TIG: 0.6 };   // sprawność cieplna procesu — 1:1 z index.html
  const HI_MAX_R = 1.25;        // górna granica zakresu z WPS = te same 25%, które gra pokazuje na pasku HI
  const CVN_BEADS = { steel: 1 };
  // ── ZA SZYBKI PRZEJAZD (3.6.0) — `coverage` mierzy, GDZIE przeszła ręka, nie ILE metalu tam leży,
  // więc przejechanie próbki 2–5× za szybko dawało C / ISO D „zaliczone". Prawdziwy ścieg położony
  // w takim tempie to niewypełniony rowek i brak wtopienia w brzegi (ISO 5817: 511, 401) — odrzut,
  // nie kara. Próg na ŚREDNIM tempie ściegu (najgorszy ścieg w próbce), zwężany jak `spdAcc`
  // tolerancją materiału: stal 1,5×, nierdzewka 1,41×, alu 1,35× tempa z WPS. Do progu nic się
  // nie zmienia — runda w tempie liczy się bit-w-bit jak 3.5.0. Działa TYLKO w rundach z flagą `uf`
  // (jak `cvn` w 3.4.0): stare nagrania nie mogą po fakcie wrócić jako REJECT za regułę, której nie było.
  const FAST_TOL = 0.5;   // stal węglowa. Austenityczna nierdzewka i alu — bez próby udarności, bez limitu
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
  // ── ELEKTRODY (3.10.0, nagranie kb:4, tylko MMA) — 1:1 z index.html ──
  // Do 3.9.0 jedna Ø na całą próbkę (z grubości) i prąd z grubości, nie z elektrody: grań 12 mm dostawała 170 A.
  // Teraz gracz wybiera Ø przed KAŻDYM ściegiem (domyślnie typowa = podpowiedź z planu), prąd idzie z Ø
  // (środek zakresu producenta × pozycja), łuk nominalny L0 = Ø. Zła Ø to wada sama w sobie (diaFit),
  // a w AUTO dodatkowo inny prąd → inny HI (za gruba na stali = odrzut, jeśli nie przyspieszysz).
  // Zdarzenie `dia` (d = Ø×10) przyjmowane tylko przed pierwszym kroplą ściegu — w trakcie Ø stoi.
  const DIAS = [20, 25, 32, 40];
  const AMP_DIA = { 20: 60, 25: 80, 32: 115, 40: 160 };   // 2,0: 50–70 · 2,5: 70–90 · 3,2: 100–130 · 4,0: 140–180 A
  function elecTyp(k, thick) { return thick <= 2 ? 20 : thick <= 3 || k === "root" ? 25 : thick > 8 && k === "fill" ? 40 : 32; }
  function diaAmps(d, posK) { return Math.round(AMP_DIA[d] * (POS_AMP_MUL[POSITIONS[posK].stars] || 1)); }
  // s = o ile rozmiarów od typowej. +1: szersze, gorętsze jeziorko; na grani doczołowej (warstwa 0) przepalenie = wada.
  // −1: wąskie, zimne lico (gorzej kryje fazę). ±2 i więcej = wada (przepalenie / brak wtopienia).
  function diaFit(sel, typ, lay) { const s = DIAS.indexOf(sel) - DIAS.indexOf(typ);
    if (!s) return { s, w: 1, pen: 0, sev: null, spatAdd: 0 };
    const big = Math.abs(s) >= 2;
    if (s > 0) return { s, w: big ? 1.3 : 1.15, pen: big ? 18 : 6, sev: big || lay === 0 ? "major" : "minor", spatAdd: big ? 0.8 : 0.4 };
    return { s, w: big ? 0.75 : 0.88, pen: big ? 18 : 6, sev: big ? "major" : "minor", spatAdd: 0 }; }
  function ampFOf(ar) { return { ar, w: Math.pow(ar, 0.55),
    pen: ar < 1 ? Math.min(30, (1 - ar) * 70) : Math.min(30, (ar - 1) * 50),
    sev: ar === 1 ? null : (Math.abs(ar - 1) >= 0.25 ? "major" : "minor"),
    spatAdd: ar > 1 ? (ar - 1) * 2 : 0,
    por: ar < 0.85 ? Math.round((0.85 - ar) * 6) : 0 }; }
  // ── KOMBAJN (3.7.0): realna sekwencja ściegów — wspólna tabela gry i weryfikatora (1:1 z index.html) ──
  // Doczołowe wg ISO 9692-1 (do 3 mm złącze I, od 5 mm V 60°), liczba warstw i ściegów jak w praktyce WPS:
  // PC/PE — dużo ściegów prostych, PF — mało, z wahadłem, PA — pośrodku. MAG ma większe stopiwo (o warstwę
  // wypełnienia mniej przy 8–12 mm), TIG mniejsze (o warstwę więcej). Rura: 1G≈PA, 2G≈PC, 5G≈PF, 6G≈PC.
  // Pachwina: a≈0,7·t; PB/PD/PG ściegami prostymi (MAG mniej), PF/PA (korytko) wahadłem.
  // Ścieg: k (root|fill|cap), lay (nr warstwy), n (ściegów w warstwie), lane (-1…1 w poprzek rowka),
  // wm (szerokość względem warstwy: 1, z wahadłem 1,2, przy n ściegach 1,2/n — sąsiednie zachodzą ~20%), wv (wahadło).
  function weldPlan(joint, thick, pos, proc, v = 1) {   // v = wersja planu = flaga kb nagrania: 1 → 3.7.0, 2 → 3.8.0
    const p = { P1G: "PA", P2G: "PC", P5G: "PF", HL045: "PC", PB: "PB", PD: "PD" }[pos] || pos;
    let L;
    if (joint === "fillet") {
      if (thick <= 5) L = [["cap", 1]];
      else if (p === "PF" || p === "PA") L = thick <= 8 ? [["cap", 1, 1]] : [["root", 1], ["cap", 1, 1]];
      else L = (thick <= 8 || proc === "MIG") ? [["root", 1], ["cap", 2]] : [["root", 1], ["fill", 2], ["cap", 3]];
    } else if (v >= 2) {
      // 3.8.0 (kb=2), wg praktyki spawacza: przetop prosty (szybki), wypełnienie i lico wahadłem/zakosami —
      // we wszystkich pozycjach i metodach. ≤3 mm złącze I = 1 ścieg, ≤5 mm przetop + lico, >5 mm 3 warstwy
      // (minimum ISO 9606-1 dla ≥12 mm). Pachwina bez zmian (piramida ściegów w PB/PD to praktyka).
      L = thick <= 3 ? [["cap", 1]] : thick <= 5 ? [["root", 1], ["cap", 1, 1]] : [["root", 1], ["fill", 1, 1], ["cap", 1, 1]];
    } else {
      const T5 = { PA: [["root",1],["cap",1]], PC: [["root",1],["cap",2]], PE: [["root",1],["cap",2]], PF: [["root",1],["cap",1,1]], PG: [["root",1],["cap",1]] };
      const T8 = { PA: [["root",1],["fill",1],["cap",1,1]], PC: [["root",1],["fill",2],["cap",3]], PE: [["root",1],["fill",2],["cap",2]],
                   PF: [["root",1],["fill",1,1],["cap",1,1]], PG: [["root",1],["fill",2],["cap",2]] };
      const T12 = { PA: [["root",1],["fill",1],["fill",2],["cap",2]], PC: [["root",1],["fill",2],["fill",3],["cap",4]],
                    PE: [["root",1],["fill",2],["fill",3],["cap",3]], PF: [["root",1],["fill",1,1],["fill",1,1],["cap",1,1]],
                    PG: [["root",1],["fill",1],["fill",3],["cap",2]] };
      L = thick <= 3 ? [["cap", 1]] : (thick <= 5 ? T5 : thick <= 8 ? T8 : T12)[p] || [["cap", 1]];
      L = L.map(l => l.slice());
      if (thick > 5 && proc === "MIG") { const i = L.findIndex(l => l[0] === "fill"); if (i >= 0) L.splice(i, 1); }
      if (thick > 5 && proc === "TIG") { let i = -1; L.forEach((l, j) => { if (l[0] === "fill") i = j; }); if (i >= 0) L.splice(i + 1, 0, L[i].slice()); }
    }
    const up = p === "PC";                       // naścienna: ściegi od dołu do góry (normalna szwu = w dół ekranu)
    const out = [];
    L.forEach(([k, n, wv], lay) => { for (let i = 0; i < n; i++) {
      const lane = n === 1 ? 0 : (up ? 1 - 2 * i / (n - 1) : -1 + 2 * i / (n - 1));
      out.push({ k, lay, n, lane, wm: n === 1 ? (wv ? 1.2 : 1) : 1.2 / n, wv: !!wv }); } });
    return out;
  }
  // Krawędź fazy [px] — 1:1 z visGroove() w grze: lico ma ją przykryć (3.7.0). Złącze I: połowa szczeliny.
  function bevelEdgePx(thick, gh) {
    const thin = thick <= 3, tan30 = Math.tan(Math.PI / 6);
    const gapMm = thin ? Math.max(0.5, thick * 0.4) : 2, rfMm = thin ? thick : Math.min(1.5, thick * 0.15);
    const capHalfMm = thin ? gapMm / 2 + 2.5 : gapMm / 2 + (thick - rfMm) * tan30 + 1.5;
    const k = gh * 1.25 / capHalfMm, gap = Math.max(1, gapMm / 2 * k);
    return thin ? gap : gap + (thick - rfMm) * tan30 * k;
  }
  // 3.9.0 (kb=3) — FIZYCZNA SKALA BLACHY: jedna skala VIS_K [px/mm] dla każdej grubości. Do 3.8.0 szerokość
  // lica w px szła ze wzoru 3+0,7·t, więc skala rysunku wychodziła inna dla każdej blachy (2 mm 1,90, 3 mm 2,06,
  // 5–12 mm ~1,65 px/mm) i 5 mm wyglądało prawie jak 3 mm. Teraz lico = realna szerokość (złącze I: szczelina + 2×2,5 mm,
  // V60: rozwarcie fazy + 2×1,5 mm) × VIS_K, a bevelW rośnie w tej samej proporcji (tolerancje względem ściegu bez zmian).
  // VIS_K = dawna skala 3 mm, więc 3 mm zostaje praktycznie jak było. 1:1 z index.html (grooveGeom).
  const VIS_K = 2.06;
  function capHalfMm(thick) {
    const thin = thick <= 3, tan30 = Math.tan(Math.PI / 6);
    const gapMm = thin ? Math.max(0.5, thick * 0.4) : 2, rfMm = thin ? thick : Math.min(1.5, thick * 0.15);
    return thin ? gapMm / 2 + 2.5 : gapMm / 2 + (thick - rfMm) * tan30 + 1.5;
  }
  function grooveGeom(thick, phys) {
    const gh0 = 3 + thick * 0.7, bw0 = 7 + thick * 1.3;
    if (!phys) return { gh: gh0, bw: bw0 };
    const gh = capHalfMm(thick) * VIS_K / 1.25;
    return { gh, bw: bw0 * gh / gh0 };
  }
  // Progi kontroli 3.7.0 (tylko rundy z flagą `kb`)
  const EDGE_OK = 0.85, EDGE_MAJOR = 0.6, EDGE_PEN = 20, EDGE_PEN_CAP = 12;   // lico zakrywa krawędzie fazy
  const IB_MAJOR = 0.3;                                                       // szczelina między ściegami / r → 401
  const BASE_REWARD = 50;
  const ZONE_BW = 1.5;   // 3.11.0: strefa łuku = krawędź fazy + 1,5 × szerokość fazy od osi (1:1 z index.html)
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
    let ampF = ampFOf(ampAr);

    // ── łuk (2.0.0) ──
    const arcLive = !!arc;
    let arcL0 = ELEC_DIA[thick] || 2.5;
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
    const uf = !!round.uf;   // 3.6.0: „ta runda podlega progowi za szybkiego przejazdu" — starsze nagrania liczą się jak 3.5.0
    // 3.7.0 KOMBAJN: `kb` = runda spawana wg realnej sekwencji ściegów (tory, zakrycie fazy, 401, żużel).
    // Bez flagi wszystko idzie dawną ścieżką — bit-w-bit jak 3.6.0 (test kb.js na zamrożonym sim-3.6.0).
    const kb = !!round.kb;
    const phys = round.kb >= 3;    // 3.9.0: fizyczna skala blachy (VIS_K) — kb=1/2 liczą się bit-w-bit jak 3.8.0
    const dz = round.kb >= 4 && proc === "MMA";
    const zoneOn = round.kb >= 5;   // 3.11.0: łuk tylko w strefie rowka (rowek + faza ×ZONE_BW) — kb≤4 bit-w-bit jak 3.10.0   // 3.10.0: Ø elektrody per ścieg, prąd z Ø — kb≤3 i MIG/TIG bit-w-bit jak 3.9.0
    let waDeg = 0, taDeg = 0, keyMask = 0;
    let angPenAcc = 0, angTime = 0, angPorAcc = 0, angWSum = 0, angTSum = 0;
    // Kąt rusza się WYŁĄCZNIE w trakcie jazdy (na zdarzeniach `move`), tak samo jak długość łuku.
    // Gdyby dało się go przekręcić przed zajarzeniem, replay startowałby z innej pozycji niż ekran.
    function angOff() { return angLive ? angOffPx(waDeg, grooveHalf) : 0; }

    // ── passy ──
    function passPlan() { if (thick <= 3) return ["cap"]; if (thick <= 5) return ["root","cap"]; return ["root","fill","cap"]; }
    const beadPlan = kb ? weldPlan(joint, thick, posKey, proc, round.kb >= 2 ? 2 : 1) : null;   // 3.8.0: kb=2 → plan „przetop prosty, wypełnienie i lico wahadłem”
    const passPlanArr = kb ? beadPlan.map(b => b.k) : passPlan();
    const bwm = i => kb ? beadPlan[i].wm : 1;
    let passIndex = 0, passMul = PASS_W[passPlanArr[0]] * bwm(0);

    // ── geometria (recalc + buildWorkpiece, cy=H*0.66) ──
    let grooveHalf, bevelW, idealHalf, targetPx;
    function recalc() {
      const g = grooveGeom(thick, phys); grooveHalf = g.gh; bevelW = g.bw;
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

    // ── tory ściegów (3.7.0) — szew przesunięty w poprzek o lane·(połowa warstwy − połowa ściegu) ──
    const nrm = seamPts.map((p, i) => { const a = seamPts[Math.max(0, i - 1)], b = seamPts[Math.min(seamPts.length - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return { x: -dy / l, y: dx / l }; });
    let lanePts = seamPts, laneOff = 0;
    function setLane() { if (!kb) return; const b = beadPlan[passIndex]; if (!b) return;
      const Wl = grooveHalf * 1.25 * PASS_W[b.k]; laneOff = b.lane * (Wl - Wl * b.wm);
      lanePts = laneOff ? seamPts.map((p, i) => ({ x: p.x + nrm[i].x * laneOff, y: p.y + nrm[i].y * laneOff })) : seamPts; }
    setLane();
    // ── elektroda ściegu (3.10.0) ──
    const ampK = (ampRec && amps) ? amps / ampRec : 1, ampMan = !!round.am;   // AUTO: krotność pokrętła; RĘCZNIE (`am`): ampery bezwzględne
    let manA = amps;                                                          // RĘCZNIE: pokrętło przekręcone między ściegami (zdarzenie `amp`)
    let diaSel = 0, diaTyp = 0, fitF = { w: 1, pen: 0, sev: null, spatAdd: 0 }, beadAmps = 0, beadBase = 0, arcVb = 0, arcTb = 0;
    const elecLog = [];
    function beadElec() { if (!dz) return; const b = beadPlan[passIndex] || beadPlan[beadPlan.length - 1];
      diaTyp = elecTyp(b.k, thick); if (!diaSel) diaSel = diaTyp;
      beadBase = diaAmps(diaSel, posKey); beadAmps = (ampMan && manA) ? manA : Math.round(beadBase * ampK);
      ampF = ampFOf(beadAmps / beadBase); fitF = diaFit(diaSel, diaTyp, joint === "fillet" ? -1 : b.lay); arcL0 = diaSel / 10; }
    function elecEntry(m) { return { d: diaSel, typ: diaTyp, amps: beadAmps, ref: diaAmps(diaTyp, posKey), pen: ampF.pen, sev: ampF.sev, ar: ampF.ar,
      fit: fitF, avgV: m.avgV, u: arcTb ? arcVb / arcTb : null }; }
    beadElec();
    const EDGE = bevelEdgePx(thick, grooveHalf);
    const capMin = kb ? seamPts.map(() => 1e9) : null, capMax = kb ? seamPts.map(() => -1e9) : null;
    let segLen = 0; for (let i = 1; i < seamPts.length; i++) segLen += Math.hypot(seamPts[i].x - seamPts[i - 1].x, seamPts[i].y - seamPts[i - 1].y);
    segLen /= Math.max(1, seamPts.length - 1);
    const beadStats = []; let bSo = 0, bR = 0, bN = 0;          // średni tor i szerokość każdego ściegu → 401
    let needChip = false, slagCount = 0;                         // MMA: żużel zbierany między ściegami → 301
    function nearestLane(x, y) { let d = 1e18, px = x, py = y; for (const p of lanePts) { const dd = (p.x - x) ** 2 + (p.y - y) ** 2; if (dd < d) { d = dd; px = p.x; py = p.y; } } return { d: Math.sqrt(d), x: px, y: py }; }
    function nearestIdx(x, y) { let d = 1e18, j = 0; for (let i = 0; i < seamPts.length; i++) { const dd = (seamPts[i].x - x) ** 2 + (seamPts[i].y - y) ** 2; if (dd < d) { d = dd; j = i; } } return j; }
    // ── helpery geometrii (1:1) ──
    function nearestSeam(x, y) { let d = 1e18, px = x, py = y; for (const p of seamPts) { const dd = (p.x - x) ** 2 + (p.y - y) ** 2; if (dd < d) { d = dd; px = p.x; py = p.y; } } return { d: Math.sqrt(d), x: px, y: py }; }
    function plateHalf() { return grooveHalf + bevelW + 75; }
    // 3.5.0: blacha konczy sie tam, gdzie szew (rysowana z plaskim koncem). Wczesniej strefa "na blasze"
    // byla polkolem ~90 px za kazdym koncem szwu prostego — luk palil sie i kladl spoine w powietrzu.
    // Tolerancja 1,5 px: nagrania zaokraglaja wspolrzedne do 0,01, a start bywa dokladnie na krawedzi.
    function pastSeamEnd(x, y) { if (P.pipe || seamPts.length < 2) return false;
      const a = seamPts[0], b = seamPts[seamPts.length - 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      if (!L2) return false; const t = ((x - a.x) * dx + (y - a.y) * dy) / L2, tol = 1.5 / Math.sqrt(L2);
      return t < -tol || t > 1 + tol; }
    function onPlate(x, y) { return nearestSeam(x, y).d <= plateHalf() && !pastSeamEnd(x, y); }
    // 3.11.0: do 3.10.0 łuk palił się i kładł metal do ~75 px poza fazą — przeciągnięcie po blasze robiło „dywan" spoiny.
    // Teraz zajarzenie, palenie i odkładanie tylko w strefie rowka: krawędź fazy + pół szerokości fazy zapasu.
    function onZone(x, y) { return nearestSeam(x, y).d <= grooveHalf + bevelW * ZONE_BW && !pastSeamEnd(x, y); }
    const onWeld = zoneOn ? onZone : onPlate;

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
      return w * ampF.w * fitF.w * arcW * (angLive ? angWFac(taDeg) : 1); }   // 1:1 z arcWFac()/angWFac() w index.html
    function depositBead(x, y, w) { const ns = kb ? nearestLane(x, y) : nearestSeam(x, y);
      if (ns.d < grooveHalf + bevelW) { x += (ns.x - x) * 0.4; y += (ns.y - y) * 0.4; }
      const jit = proc === "MMA" ? (rng() * 0.18 - 0.09) * w : 0;   // jedyny pobór z rng (jak w grze)
      x += jit;
      if (kb) { const j = nearestIdx(x, y), so = (x - seamPts[j].x) * nrm[j].x + (y - seamPts[j].y) * nrm[j].y;
        bSo += so; bR += w; bN++;
        if (passPlanArr[passIndex] === "cap") { const s = Math.ceil(w / Math.max(1e-6, segLen));
          for (let i = Math.max(0, j - s); i <= Math.min(seamPts.length - 1, j + s); i++) {
            if (so - w < capMin[i]) capMin[i] = so - w; if (so + w > capMax[i]) capMax[i] = so + w; } } }
      baked.push({ x, y, r: w, off: ns.d }); return { x, y }; }

    function covThr() { const b = kb && beadPlan[passIndex]; return b && b.n > 1 ? grooveHalf * 1.25 * PASS_W[b.k] * b.wm * 1.3 : grooveHalf * 1.6; }
    function passMetrics() {
      const K = seamPts.length; let covered = 0; const gaps = [], thr = covThr();
      for (let i = 0; i < K; i++) { const p = lanePts[i]; let d = 1e18; for (const b of baked) { const dd = (b.x - p.x) ** 2 + (b.y - p.y) ** 2; if (dd < d) d = dd; }
        if (Math.sqrt(d) < thr) covered++; else gaps.push(p); }
      const coverage = K ? covered / K : 0;
      let out = 0, narrow = 0, wide = 0, rs = [];
      const nThr = kb ? idealHalf * 0.75 : grooveHalf * 0.9;   // 3.7.0: „wąski" względem WŁASNEGO ściegu (ścieg prosty z wielu jest wąski z założenia)
      for (const b of baked) { if (b.off > grooveHalf + bevelW * 0.7) out++; if (b.r < nThr) narrow++; if (b.r > idealHalf * 1.65) wide++; rs.push(b.r); }
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
      let endGap = 0; for (const e of [lanePts[0], lanePts[K - 1]]) { let d = 1e18; for (const b of baked) { const dd = (b.x - e.x) ** 2 + (b.y - e.y) ** 2; if (dd < d) d = dd; } if (Math.sqrt(d) > grooveHalf * 1.7) endGap++; }
      return { coverage, overflow, evenness, spdAcc, porosity, spatter, narrow, wide, out, gaps, avgV, endGap, offPen };
    }
    function bankReset() { const pm = passMetrics(); passLog.push(pm);
      if (dz) { elecLog.push(elecEntry(pm)); arcVb = 0; arcTb = 0; diaSel = 0; }
      if (kb) { const b = beadPlan[passIndex]; if (b) beadStats.push({ lay: b.lay, lane: b.lane, so: bN ? bSo / bN : 0, r: bN ? bR / bN : 0, n: bN });
        bSo = 0; bR = 0; bN = 0; if (proc === "MMA") needChip = true; }
      baked = []; speedSum = 0; speedN = 0; vVarSum = 0; spatterCount = 0; distAcc = 0;
      vSumT = 0; vTimeS = 0; passWeldMs = 0; depCarry = 0; tickAcc = 0; vTickRef = vEMA;
      passIndex++; passMul = (PASS_W[passPlanArr[passIndex]] || 1) * (kb && beadPlan[passIndex] ? beadPlan[passIndex].wm : 1); recalc(); setLane(); beadElec(); }

    // ── replay zdarzeń ──
    for (const ev of events) {
      if (ev.type === "chip") { if (kb) needChip = false; continue; }   // 3.7.0: żużel zebrany młotkiem
      if (ev.type === "amp") { if (dz && ampMan && !bN && !last && Number.isInteger(ev.a) && ev.a > 0 && ev.a <= 400) { manA = ev.a; beadElec(); } continue; }   // 3.10.0: RĘCZNIE — prąd przestawiony przed ściegiem
      if (ev.type === "dia") { if (dz && !bN && !last && DIAS.includes(ev.d)) { diaSel = ev.d; beadElec(); electrodeLeft = 1; replacing = false; } continue; }   // 3.10.0: nowa elektroda wybranej Ø
      if (ev.type === "down") { if (zoneOn && !onZone(ev.x, ev.y)) continue;   // 3.11.0: poza rowkiem łuk nie zajarzy (gra tego nie nagrywa)
        if (kb && needChip) { slagCount++; needChip = false; }   // następny ścieg na niezebranym żużlu
        last = { x: ev.x, y: ev.y }; lastT = ev.t; vEMA = targetPx; lastDab = ev.t;
        btnMask = ev.b | 0; arcLen = 0; contactT = 0;   // dotyk blachy = zajarzenie
        trail = [{ t: ev.t, x: ev.x, y: ev.y }];
        if (replacing) { electrodeLeft = 1; replacing = false; } continue; }
      if (ev.type === "up") { last = null; continue; }
      if (ev.type === "bank") { bankReset(); continue; }
      if (ev.type !== "move" || !last) continue;
      const p = { x: ev.x, y: ev.y }, now = ev.t;
      if (arcLive && !onWeld(p.x, p.y)) { last = null; continue; }   // zjazd z blachy (od 3.11.0: z rowka) gasi łuk (1:1 z grą)
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
        const uNow = recommendedVolts(proc, thick) + ARC_V_SLOPE * (arcLen - arcL0);
        arcVSum += uNow * dtS; if (dz) { arcVb += uNow * dtS; arcTb += dtS; }
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
        if (dab && onWeld(p.x + aox, p.y + aoy)) { const dw = Math.max(idealHalf, w * 0.95);
          const pl = depositBead(p.x + aox, p.y + aoy, dw); lastDab = now;
          if (tigLive) { if (lastDabPos) { const gap = Math.hypot(pl.x - lastDabPos.x, pl.y - lastDabPos.y);
              filPenAcc += filPenNow(gap / Math.max(1e-6, targetPx * FIL_DT)); filCount++; }
            lastDabPos = { x: pl.x, y: pl.y }; } }
      } else {
        const step = Math.max(2, w * 0.35); depCarry += dist;
        const n = Math.floor(depCarry / step); if (n > 0) depCarry -= n * step;
        for (let i = 1; i <= n; i++) { const x = last.x + ddx * (i / n) + aox, y = last.y + ddy * (i / n) + aoy;
          if (!onWeld(x, y)) continue;
          if (proc === "MMA") { if (replacing) break; electrodeLeft -= step / (arcLive ? ELEC_TRAVEL_ARC : 650);
            if (electrodeLeft <= ELEC_STUB) { replacing = true; break; } }
          depositBead(x, y, w); distAcc += step; }
      }
      // 1.4.0: tempo poza oknem = rozprysk (1:1 z index.html). Kara przestała być stałą dla
      // danego proc/thick — idealny przebieg nie płaci za nic, zły płaci do 2×.
      let spatFac = Math.min(2, Math.abs(vEMA / targetPx - 1) / 0.30);
      const spA = ampF.spatAdd + fitF.spatAdd; if (spA) spatFac = Math.min(2.6, spatFac + spA);
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
    // ── 3.7.0: lico vs krawędzie fazy, wtopienie między ściegami, żużel ──
    let edgeCov = 1, ibGaps = 0, ibMax = 0;
    if (kb) {
      if (joint !== "fillet") { let okN = 0; for (let i = 0; i < K; i++) if (capMin[i] <= -EDGE && capMax[i] >= EDGE) okN++; edgeCov = K ? okN / K : 0; }
      const cb = beadPlan[passIndex]; if (cb) beadStats.push({ lay: cb.lay, lane: cb.lane, so: bN ? bSo / bN : 0, r: bN ? bR / bN : 0, n: bN });
      const byLay = {}; for (const s of beadStats) (byLay[s.lay] = byLay[s.lay] || []).push(s);
      for (const k in byLay) { const a = byLay[k].filter(s => s.n).sort((p, q) => p.so - q.so);
        for (let i = 1; i < a.length; i++) { const g = (a[i].so - a[i].r) - (a[i - 1].so + a[i - 1].r);
          if (g > 0) { ibGaps++; ibMax = Math.max(ibMax, g / Math.max(1e-6, Math.min(a[i].r, a[i - 1].r))); } } }
    }
    const edgePen = kb ? Math.min(EDGE_PEN_CAP, (1 - edgeCov) * EDGE_PEN) : 0;

    // HI liczony DOKŁADNIE tak, jak raport w grze: napięcie z przebiegu łuku (dłuższy łuk = wyższe U),
    // prąd GRACZA i JEGO tempo. `arcTime` rośnie wyłącznie przy żywym łuku, więc na dotyku i przy TIG
    // (brak modelu długości łuku) schodzimy na napięcie z WPS — tak samo jak index.html.
    const vWps = recommendedVolts(proc, thick), effP = WELD_EFF[proc] || 0.8;
    const ampsUse = (ampRec && amps) ? amps : ampRec;
    const uAct = arcTime ? arcVSum / arcTime : vWps;
    const hiWps = (vWps != null && ampRec != null) ? heatInputKJmm(vWps, ampRec, targetPx / PX_PER_MM, effP) : null;
    const hiAct = (uAct != null && ampsUse != null) ? heatInputKJmm(uAct, ampsUse, cur.avgV / PX_PER_MM, effP) : null;
    const hiMax = hiWps != null ? Math.round(hiWps * HI_MAX_R * 1000) / 1000 : null;
    let hiOver = !!(cvn && hiMax != null && hiAct != null && hiAct > hiMax);
    // 3.10.0: każdy ścieg ma własną Ø, prąd i tempo → HI liczony PER ŚCIEG, referencja = prąd TYPOWEJ Ø z WPS.
    // Do raportu idzie ścieg najbliżej sufitu (najgorszy). Kary prądu i Ø = średnia po ściegach, wada = najgorsza.
    let ampPenT = ampF.pen, ampMajor = ampF.sev === "major", diaPen = 0, diaMajor = false, elec = null;
    let hiR = hiAct, hiRW = hiWps, hiRM = hiMax, ampsR = ampsUse;
    if (dz) {
      const E = elecLog.concat([elecEntry(cur)]), tr = targetPx / PX_PER_MM;
      ampPenT = 0; ampMajor = false; hiOver = false; let worst = -1;
      for (const e of E) { ampPenT += e.pen; diaPen += e.fit.pen; if (e.sev === "major") ampMajor = true; if (e.fit.sev === "major") diaMajor = true;
        e.hiW = vWps != null ? heatInputKJmm(vWps, e.ref, tr, effP) : null;
        e.hiM = e.hiW != null ? Math.round(e.hiW * HI_MAX_R * 1000) / 1000 : null;
        e.hi = vWps != null ? heatInputKJmm(e.u != null ? e.u : vWps, e.amps, e.avgV / PX_PER_MM, effP) : null;
        if (e.hi != null && e.hiM != null) { const r = e.hi / e.hiM; if (r > worst) { worst = r; hiR = e.hi; hiRW = e.hiW; hiRM = e.hiM; ampsR = e.amps; }
          if (cvn && e.hi > e.hiM) hiOver = true; } }
      ampPenT /= E.length; diaPen /= E.length;
      elec = E.map(e => ({ d: e.d, typ: e.typ, amps: e.amps, ref: e.ref, fit: e.fit.s, hi: e.hi, hiMax: e.hiM }));
    }
    const fastR = Math.max.apply(null, all.map(m => m.avgV)) / targetPx, fastMax = 1 + FAST_TOL * MATERIAL[bead].tol;
    const tooFast = uf && fastR > fastMax;

    let score = coverage * 50 + spdAcc * 20 + evenness * 15 + (1 - overflow) * 15
              - porosity * 5 - Math.min(SPATTER_PEN_CAP, proc === "TIG" ? spatter * 3 : spatter * 0.5)
              - ampPenT - diaPen - arcPen - Math.min(15, arcFails * 4) - angPen - offPen - filPen - edgePen;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // wady major (do oceny ISO / odrzutu) — te same progi co w grze
    const Dmajor =
      (coverage < 0.6) ||
      (overflow > 0.3) ||
      (porosity > 3) ||
      (endGap > 1) ||
      (passPlanArr[0] === "root" && rootCov < 0.8) ||
      (ampMajor) || (dz && diaMajor) ||
      (arcPen >= 12) || (arcFails > 2) ||
      (angPen >= 10) || (offPen >= OFF_MAJOR) || (filPen >= FIL_MAJOR) ||
      hiOver ||                     // poza zakresem kwalifikacji WPS — ocena lica tego nie ratuje
      tooFast ||                    // niewypełniony rowek — tak samo
      (kb && edgeCov < EDGE_MAJOR) ||   // 3.7.0: lico nie przykryło krawędzi fazy (511/401)
      (kb && ibMax >= IB_MAJOR) ||      // brak wtopienia między ściegami (401)
      (kb && slagCount > 0);            // wtrącenie żużla (301)

    // przyczyny odrzutu dla karty Battle — TE SAME warunki co Dmajor, w kolejności ważności; nie wpływają na wynik
    const rejectReasons = [];
    if (coverage < 0.6) rejectReasons.push("coverage");
    if (passPlanArr[0] === "root" && rootCov < 0.8) rejectReasons.push("root");
    if (endGap > 1) rejectReasons.push("ends");
    if (hiOver) rejectReasons.push("heatInput");
    if (tooFast) rejectReasons.push("underfill");
    if (kb && edgeCov < EDGE_MAJOR) rejectReasons.push("edges");
    if (kb && ibMax >= IB_MAJOR) rejectReasons.push("interbead");
    if (kb && slagCount > 0) rejectReasons.push("slag");
    if (overflow > 0.3) rejectReasons.push("overflow");
    if (porosity > 3) rejectReasons.push("porosity");
    if (offPen >= OFF_MAJOR) rejectReasons.push("offAxis");
    if (dz && diaMajor) rejectReasons.push("electrode");
    if (ampMajor) rejectReasons.push("amps");
    if ((arcPen >= 12) || (arcFails > 2)) rejectReasons.push("arc");
    if (angPen >= 10) rejectReasons.push("angle");
    if (filPen >= FIL_MAJOR) rejectReasons.push("filler");
    if (!Dmajor && score < 50) rejectReasons.push("score");

    const letter = score >= 90 ? "A" : score >= 78 ? "B" : score >= 62 ? "C" : score >= 45 ? "D" : "F";
    const iso = (Dmajor || score < 50) ? "REJECT" : score >= 88 ? "B" : score >= 72 ? "C" : "D";

    // ekonomia (do parytetu wypłaty)
    const mb = { MIG:1.0, MMA:1.6, TIG:2.2 }[proc];
    const pm = [0,1.0,1.25,1.6,2.1,2.8][P.stars] || 1;
    const jm = joint === "pipe" ? 1.3 : joint === "fillet" ? 0.9 : 1.0;
    const mf = MATERIAL[bead][proc] || 1;
    const nLay = kb ? beadPlan[beadPlan.length - 1].lay + 1 : passPlanArr.length;   // trudność od liczby WARSTW (jak dotąd)
    const pf = 1 + 0.18 * (nLay - 1);
    const difficulty = mb * pm * jm * mf * pf;

    return { score, letter, iso, coverage, spdAcc, evenness, overflow, porosity, spatter, endGap, baked: baked.length, passes: passPlanArr.length, difficulty: +difficulty.toFixed(2), amps: dz ? ampsR : ampRec && amps ? amps : ampRec, ampsWps: ampRec, ampPen: +ampPenT.toFixed(2),
             arcPen: +arcPen.toFixed(2), arcR: +arcR.toFixed(3), stickCount, arcBroke,
             angPen: +angPen.toFixed(2), offPen: +offPen.toFixed(2), filPen: +filPen.toFixed(2), filDabs: filCount, waDeg: +waDeg.toFixed(2), taDeg: +taDeg.toFixed(2),
             angW: +angW.toFixed(2), angT: +angT.toFixed(2), taIdeal: TA_IDEAL[proc] != null ? TA_IDEAL[proc] : 0,
             volts: arcTime ? +(arcVSum / arcTime).toFixed(2) : recommendedVolts(proc, thick),
             hi: hiR, hiWps: hiRW, hiMax: hiRM, hiOver, cvn, fastR: +fastR.toFixed(3), fastMax: +fastMax.toFixed(3), tooFast, rejectReasons: iso === "REJECT" ? rejectReasons : [],
             ...(dz ? { elec, diaPen: +diaPen.toFixed(2) } : {}),
             ...(kb ? { kb: true, beads: beadPlan.length, edgeCov: +edgeCov.toFixed(3), edgePen: +edgePen.toFixed(2), ibGaps, ibMax: +ibMax.toFixed(3), slag: slagCount } : {}) };
  }

  // 3.11.0 — ŁUK TYLKO W ROWKU (flaga `kb: 5`): zajarzenie, palenie i odkładanie metalu tylko w strefie
  //         grooveHalf + bevelW × ZONE_BW od osi złącza (wcześniej cała blacha ±75 px — „dywan" spoiny po blasze).
  //         Zjazd ze strefy gasi łuk jak dawniej zjazd z blachy. Rundy kb≤4 bit-w-bit jak 3.10.0
  //         (zamrożony sim-3.10.0.js, test kb5.js). SCORING_VERSION 1.6.0.
  // 3.10.0 — ELEKTRODY (flaga `kb: 4`, tylko MMA): Ø wybierana przed każdym ściegiem (zdarzenie `dia`, domyślnie
  //         typowa), prąd z Ø (AMP_DIA × pozycja; RĘCZNIE `am` = ampery bezwzględne, przestawiane między ściegami
  //         zdarzeniem `amp`), L0 łuku = Ø, zła Ø = diaFit
  //         (±1 kara/drobna, na grani doczołowej +1 i ±2 = REJECT „electrode"), HI per ścieg. MIG/TIG z kb:4 i rundy
  //         kb≤3 bit-w-bit jak 3.9.0 (zamrożony sim-3.9.0.js, test kb4.js). SCORING_VERSION 1.5.0.
  // 3.9.0 — FIZYCZNA SKALA BLACHY (flaga `kb: 3`): szerokość lica, faza i tolerancje w px liczone z realnych mm
  //         w jednej skali VIS_K dla wszystkich grubości (grooveGeom). Plan ściegów jak kb=2. Rundy kb=1/2 liczą się
  //         bit-w-bit jak 3.8.0 (zamrożony sim-3.8.0.js, test kb3.js). SCORING_VERSION 1.4.0.
  // 3.8.0 — PLAN ŚCIEGÓW WG PRAKTYKI (flaga `kb: 2`): doczołowe i rura — przetop prosty, wypełnienie i lico
  //         po JEDNYM ściegu z wahadłem/zakosami we wszystkich pozycjach i metodach (>5 mm 3 warstwy, ≤5 mm 2,
  //         ≤3 mm 1). Do 3.7.0 12 mm miało 4–13 ściegów prostych (np. MMA PC 10, MAG PE 7). Rundy z `kb: 1`
  //         liczą się bit-w-bit jak 3.7.0 (zamrożony sim-3.7.0.js, test kb2.js). SCORING_VERSION 1.3.0.
  // 3.7.0 — KOMBAJN: realna sekwencja ściegów (weldPlan), każdy ścieg na własnym TORZE w poprzek rowka,
  //         lico musi przykryć krawędzie fazy (edgeCov; <0,6 = REJECT „edges", kara do 12 pkt), sąsiednie
  //         ściegi muszą się zlać (szczelina ≥0,3·r = REJECT „interbead", 401), MMA: żużel zebrany przed
  //         następnym ściegiem (zdarzenie `chip`; inaczej REJECT „slag", 301). Tylko rundy z flagą `kb` —
  //         bez niej bit-w-bit jak 3.6.0. SCORING_VERSION 1.2.0.
  // 3.6.0 — ZA SZYBKI PRZEJAZD = REJECT „underfill" (patrz FAST_TOL). SCORING_VERSION 1.1.0.
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
  // Bump SCORING_VERSION when score, grade thresholds, or inspection rejection rules change.
  const API = { simulate, mulberry32, recommendedAmps, recommendedVolts, heatInputKJmm, weldPlan, bevelEdgePx, grooveGeom, capHalfMm, VIS_K, elecTyp, diaAmps, diaFit, AMP_DIA, DIAS, VERSION: "3.11.0", SCORING_VERSION: "1.6.0", ZONE_BW };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.ArcSim = API;
})(typeof self !== "undefined" ? self : this);
