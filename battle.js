(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GorWeldBattle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TASK_FIELDS = [
    "seed", "W", "H", "proc", "joint", "pos", "thick", "bead",
    "amps", "ampMode", "requiredCoverage"
  ];
  const TASK_DEFAULTS = {
    W: 1280,
    H: 720,
    ampMode: "auto",
    requiredCoverage: 0.8
  };
  const TASK_ALIASES = {
    width: "W",
    height: "H",
    process: "proc",
    position: "pos",
    thicknessMm: "thick",
    material: "bead",
    amperage: "amps",
    currentA: "amps"
  };
  const PROC_ALIASES = {
    "MMA 111": "MMA",
    "111": "MMA",
    "MAG": "MIG",
    "MIG/MAG": "MIG",
    "MIG/MAG 135": "MIG",
    "MAG 135": "MIG",
    "135": "MIG",
    "TIG 141": "TIG",
    "141": "TIG"
  };
  const GRADES = new Set(["A", "B", "C", "D", "F"]);
  const STAMP_FIELDS = ["taskHash", "scoringVersion", "engineVersion"];

  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function nonEmptyString(value, name) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(name + " must be a non-empty string");
    }
  }

  function getBattlePoints(score) {
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new RangeError("Invalid ARC score");
    }
    return score * 10;
  }

  function mappedFields(input, name) {
    if (!record(input)) throw new TypeError(name + " must be an object");
    const mapped = {};
    for (const key of Object.keys(input)) {
      const field = TASK_ALIASES[key] || key;
      if (!TASK_FIELDS.includes(field)) throw new TypeError("Unknown task field: " + key);
      if (Object.prototype.hasOwnProperty.call(mapped, field) &&
          !Object.is(mapped[field], input[key])) {
        throw new TypeError("Conflicting values for task field: " + field);
      }
      mapped[field] = input[key];
    }
    return mapped;
  }

  function normalizeBattleTask(source, defaults = {}) {
    const fromDefaults = mappedFields(defaults, "defaults");
    const fromSource = mappedFields(source, "task");
    const values = { ...TASK_DEFAULTS, ...fromDefaults, ...fromSource };

    for (const field of TASK_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(values, field) || values[field] == null) {
        throw new TypeError("Missing task field: " + field);
      }
    }
    if (!Number.isInteger(values.seed) || values.seed < 0 || values.seed > 0xffffffff) {
      throw new RangeError("seed must be an unsigned 32-bit integer");
    }
    for (const field of ["W", "H"]) {
      if (!Number.isInteger(values[field]) || values[field] < 1) {
        throw new RangeError(field + " must be a positive integer");
      }
    }

    const procValue = String(values.proc).trim().toUpperCase();
    const proc = PROC_ALIASES[procValue] || procValue;
    if (!["MMA", "MIG", "TIG"].includes(proc)) {
      throw new TypeError("proc must be MMA, MIG or TIG");
    }
    for (const field of ["joint", "pos", "bead"]) nonEmptyString(values[field], field);
    if (!Number.isFinite(values.thick) || values.thick <= 0) {
      throw new RangeError("thick must be a positive number");
    }
    if (!Number.isFinite(values.amps) || values.amps <= 0) {
      throw new RangeError("amps must be a positive number");
    }
    const mode = String(values.ampMode).trim().toLowerCase();
    const ampMode = mode === "man" || mode === "manual" ? "manual" : mode;
    if (ampMode !== "auto" && ampMode !== "manual") {
      throw new TypeError("ampMode must be auto or manual");
    }
    if (!Number.isFinite(values.requiredCoverage) ||
        values.requiredCoverage < 0 || values.requiredCoverage > 1) {
      throw new RangeError("requiredCoverage must be between 0 and 1");
    }

    return {
      seed: values.seed,
      W: values.W,
      H: values.H,
      proc,
      joint: String(values.joint).trim(),
      pos: String(values.pos).trim().toUpperCase(),
      thick: values.thick,
      bead: String(values.bead).trim().toLowerCase(),
      amps: values.amps,
      ampMode,
      requiredCoverage: values.requiredCoverage
    };
  }

  function toArcAmpMode(mode) {
    const normalized = String(mode).trim().toLowerCase();
    if (normalized === "auto") return "auto";
    if (normalized === "manual" || normalized === "man") return "man";
    throw new TypeError("ampMode must be auto or manual");
  }

  function validateBattleTaskForArc(source, arcSim) {
    const task = normalizeBattleTask(source);
    if (task.ampMode !== "auto") {
      return { supported: false, reason: "TASK_UNSUPPORTED", detail: "AMP_MODE_UNSUPPORTED", task };
    }
    if (!arcSim || typeof arcSim.recommendedAmps !== "function" ||
        typeof arcSim.VERSION !== "string" || !arcSim.VERSION) {
      throw new TypeError("ArcSim version and recommendedAmps are required");
    }
    let expectedAmps;
    try { expectedAmps = arcSim.recommendedAmps(task.proc, task.thick, task.pos); }
    catch (error) {
      return { supported: false, reason: "TASK_UNSUPPORTED", detail: "ARC_TASK_UNSUPPORTED", task };
    }
    if (expectedAmps == null || !Number.isFinite(expectedAmps)) {
      return { supported: false, reason: "TASK_UNSUPPORTED", detail: "AMP_TABLE_UNAVAILABLE", task };
    }
    if (task.amps !== expectedAmps) {
      return { supported: false, reason: "TASK_MISMATCH", detail: "AMP_MISMATCH",
        expectedAmps, task };
    }
    return { supported: true, reason: null, task, engineVersion: arcSim.VERSION };
  }

  function canonicalizeTask(task, defaults) {
    return JSON.stringify(normalizeBattleTask(task, defaults));
  }

  function cryptoProvider() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    if (typeof require === "function") return require("node:crypto").webcrypto;
    return null;
  }

  // Zapasowe SHA-256 w czystym JS. Przegladarka daje crypto.subtle tylko w "bezpiecznym kontekscie"
  // (HTTPS albo localhost) — na http://192.168.x.x (test w sieci domowej) go nie ma, a Battle i tak
  // musi policzyc ten sam taskHash. Wynik bit w bit jak crypto.subtle.digest("SHA-256").
  function sha256Fallback(bytes) {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const length = bytes.length, total = Math.ceil((length + 9) / 64) * 64;
    const data = new Uint8Array(total);
    data.set(bytes); data[length] = 0x80;
    const view = new DataView(data.buffer);
    const bitLength = sha256BitLengthWords(length);
    view.setUint32(total - 8, bitLength.high);
    view.setUint32(total - 4, bitLength.low);
    const w = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < total; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(x => x.toString(16).padStart(8, "0")).join("");
  }

  function sha256BitLengthWords(byteLength) {
    return {
      high: Math.floor(byteLength / 0x20000000),
      low: (byteLength * 8) >>> 0
    };
  }

  async function computeTaskHash(task, defaults) {
    const canonical = canonicalizeTask(task, defaults);
    const bytes = new TextEncoder().encode(canonical);
    const provider = cryptoProvider();
    if (!provider) return sha256Fallback(bytes);
    const digest = await provider.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function validateBattleResult(result) {
    if (!record(result)) throw new TypeError("Battle result must be an object");
    getBattlePoints(result.score);
    if (typeof result.grade !== "string" || !GRADES.has(result.grade)) {
      throw new TypeError("grade must be one of A, B, C, D, F");
    }
    for (const key of ["inspectionRejected", "taskCompleted", "challengePassed"]) {
      if (typeof result[key] !== "boolean") throw new TypeError(key + " must be boolean");
    }
    if (!Number.isFinite(result.coverage) || result.coverage < 0 || result.coverage > 1) {
      throw new RangeError("coverage must be between 0 and 1");
    }
    for (const key of STAMP_FIELDS) nonEmptyString(result[key], key);
    if (result.serverTimeMs !== undefined && !Number.isFinite(result.serverTimeMs)) {
      throw new RangeError("serverTimeMs must be finite when provided");
    }
    if (!Number.isInteger(result.attemptNumber) || result.attemptNumber < 1) {
      throw new RangeError("attemptNumber must be an integer greater than or equal to 1");
    }
    if (!Number.isInteger(result.attemptsStarted) ||
        result.attemptsStarted < 1 ||
        result.attemptNumber > result.attemptsStarted) {
      throw new RangeError("attemptsStarted must be an integer at least attemptNumber");
    }
    return result;
  }

  function sameStamp(a, b) {
    return STAMP_FIELDS.every(key => a[key] === b[key]);
  }

  function validateEnvelopeShape(envelope) {
    if (!record(envelope)) throw new TypeError("Battle envelope must be an object");
    if (envelope.schemaVersion !== 1) throw new RangeError("Unsupported Battle schemaVersion");
    nonEmptyString(envelope.battleId, "battleId");
    for (const key of STAMP_FIELDS) nonEmptyString(envelope[key], key);
    if (!record(envelope.task)) throw new TypeError("task must be an object");
    if (!record(envelope.player1)) throw new TypeError("player1 result is required");
    if (envelope.player2 !== null && envelope.player2 !== undefined &&
        !record(envelope.player2)) {
      throw new TypeError("player2 must be a result or null");
    }
  }

  async function validateBattleEnvelope(envelope, taskDefaults) {
    validateEnvelopeShape(envelope);
    const normalizedTask = normalizeBattleTask(envelope.task, taskDefaults);
    const actualHash = await computeTaskHash(normalizedTask);
    if (actualHash !== envelope.taskHash) throw new RangeError("taskHash does not match normalized task");

    const player1 = { ...envelope.player1 };
    for (const key of STAMP_FIELDS) {
      if (player1[key] !== undefined && player1[key] !== envelope[key]) {
        throw new RangeError("player1 " + key + " does not match envelope");
      }
      player1[key] = envelope[key];
    }
    validateBattleResult(player1);

    let player2 = null;
    if (envelope.player2 != null) {
      player2 = { ...envelope.player2 };
      validateBattleResult(player2);
    }
    return { ...envelope, task: normalizedTask, player1, player2 };
  }

  async function preflightBattleStart(envelope, local, taskDefaults) {
    const validated = await validateBattleEnvelope(envelope, taskDefaults);
    if (!record(local)) throw new TypeError("local Battle configuration must be an object");
    for (const key of ["engineVersion", "scoringVersion"]) nonEmptyString(local[key], key);
    if (!record(local.task)) throw new TypeError("local task must be an object");

    if (local.engineVersion !== validated.engineVersion) {
      return { startAllowed: false, reason: "ENGINE_VERSION_MISMATCH" };
    }
    if (local.scoringVersion !== validated.scoringVersion) {
      return { startAllowed: false, reason: "SCORING_VERSION_MISMATCH" };
    }
    const localHash = await computeTaskHash(local.task, taskDefaults);
    if (localHash !== validated.taskHash) {
      return { startAllowed: false, reason: "TASK_MISMATCH" };
    }
    return { startAllowed: true, reason: null };
  }

  function battleVerdict(player1, player2, options = {}) {
    const mode = options.mode === undefined ? "link" : options.mode;
    if (mode !== "link" && mode !== "sync") throw new TypeError("mode must be link or sync");
    validateBattleResult(player1);
    validateBattleResult(player2);

    if (!sameStamp(player1, player2)) return "INCOMPARABLE";

    const qualified1 = player1.taskCompleted && !player1.inspectionRejected;
    const qualified2 = player2.taskCompleted && !player2.inspectionRejected;
    if (!qualified1 && !qualified2) return "NO_QUALIFIED_RESULT";
    if (qualified1 !== qualified2) return qualified1 ? "P1_WINS" : "P2_WINS";

    const bp1 = getBattlePoints(player1.score);
    const bp2 = getBattlePoints(player2.score);
    if (bp1 === bp2) {
      if (mode === "link") return "DRAW";
      if (!Number.isFinite(player1.serverTimeMs) || !Number.isFinite(player2.serverTimeMs)) {
        throw new TypeError("sync results require serverTimeMs");
      }
      if (player1.serverTimeMs === player2.serverTimeMs) return "DRAW";
      return player1.serverTimeMs < player2.serverTimeMs ? "P1_WINS" : "P2_WINS";
    }
    return bp1 > bp2 ? "P1_WINS" : "P2_WINS";
  }

  function selectBestAttempt(attempts) {
    if (!Array.isArray(attempts) || attempts.length === 0) {
      throw new TypeError("attempts must be a non-empty array");
    }
    attempts.forEach(validateBattleResult);
    return attempts.slice().sort((a, b) => {
      const qualifiedA = a.taskCompleted && !a.inspectionRejected;
      const qualifiedB = b.taskCompleted && !b.inspectionRejected;
      if (qualifiedA !== qualifiedB) return qualifiedA ? -1 : 1;
      const pointDelta = getBattlePoints(b.score) - getBattlePoints(a.score);
      if (pointDelta) return pointDelta;
      if (Number.isFinite(a.serverTimeMs) && Number.isFinite(b.serverTimeMs) &&
          a.serverTimeMs !== b.serverTimeMs) return a.serverTimeMs - b.serverTimeMs;
      return a.attemptNumber - b.attemptNumber;
    })[0];
  }

  function carryAttemptCount(bestAttempt, attemptsStarted) {
    validateBattleResult(bestAttempt);
    if (!Number.isInteger(attemptsStarted) ||
        attemptsStarted < bestAttempt.attemptNumber ||
        attemptsStarted < bestAttempt.attemptsStarted) {
      throw new RangeError("attemptsStarted cannot precede the saved attempt");
    }
    return { ...bestAttempt, attemptsStarted };
  }

  return {
    normalizeBattleTask,
    toArcAmpMode,
    validateBattleTaskForArc,
    getBattlePoints,
    canonicalizeTask,
    computeTaskHash,
    validateBattleResult,
    validateBattleEnvelope,
    preflightBattleStart,
    battleVerdict,
    selectBestAttempt,
    carryAttemptCount
  };
});
