import { state, NOTE_NAMES, readJsonStorage, writeJsonStorage } from "./state.js";
import { connectMidi, setMidiOnChordCallback, midiPcSet, detectMidiChord } from "./midi.js";
import { noteToMidi } from "./audio.js";

const TRIAD = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6] };
const SUFFIX = { maj: "", min: "m", dim: "°" };
const CHORD_VARIANTS = {
  triad: { label: "Osnovni", short: "", suffix: { maj: "", min: "m", dim: "°" } },
  "7": { label: "7", short: "7", suffix: { maj: "7", min: "m7", dim: "m7b5" } },
  "9": { label: "9", short: "9", suffix: { maj: "9", min: "m9", dim: "dim9" } },
  sus: { label: "sus", short: "sus", suffix: { maj: "sus", min: "sus", dim: "sus" } },
  maj7: { label: "maj7", short: "maj", suffix: { maj: "maj7", min: "m maj7", dim: "dim maj7" } },
  dim: { label: "dim", short: "dim", suffix: { maj: "dim", min: "dim", dim: "dim" } }
};
const CHORD_VARIANT_GROUPS = {
  triad: ["triad"],
  "7": ["7"],
  "9": ["9"],
  sus: ["sus"],
  maj7: ["maj7"],
  dim: ["dim"],
  all: ["triad", "7", "9", "sus", "maj7", "dim"]
};
const INTERVAL_DRILLS = [
  ["mala sekunda", 1], ["velika sekunda", 2], ["mala terca", 3], ["velika terca", 4],
  ["kvarta", 5], ["tritonus", 6], ["kvinta", 7], ["mala seksta", 8],
  ["velika seksta", 9], ["mala septima", 10], ["velika septima", 11], ["oktava", 12]
];
const MAJOR_DEGREES = [
  ["I", "maj", 0], ["ii", "min", 2], ["iii", "min", 4], ["IV", "maj", 5],
  ["V", "maj", 7], ["vi", "min", 9], ["vii°", "dim", 11]
];
const MINOR_DEGREES = [
  ["i", "min", 0], ["ii°", "dim", 2], ["III", "maj", 3], ["iv", "min", 5],
  ["v", "min", 7], ["VI", "maj", 8], ["VII", "maj", 10], ["V dur", "maj", 7, true]
];
const SCALES = {
  "prirodni mol": [0, 2, 3, 5, 7, 8, 10],
  "harmonijski mol": [0, 2, 3, 5, 7, 8, 11],
  "dur": [0, 2, 4, 5, 7, 9, 11],
  "mol pentatonika": [0, 3, 5, 7, 10],
  "blues": [0, 3, 5, 6, 7, 10],
  "dorska": [0, 2, 3, 5, 7, 9, 10],
  "miksolidijska": [0, 2, 4, 5, 7, 9, 10],
  "alterovana (jazz)": [0, 1, 3, 4, 6, 8, 10]
};

// Pomocne funkcije za vizuelizaciju
export function fmtTime(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export function parseKey(text) {
  var raw = String(text || "").trim();
  if (!raw) return null;
  var lower = raw.toLowerCase().replace(/[\s\-_]+/g, "");
  var roots = [
    ["cis", 1], ["dis", 3], ["eis", 5], ["fis", 6], ["gis", 8], ["ais", 10],
    ["c", 0], ["d", 2], ["e", 4], ["f", 5], ["g", 7], ["a", 9], ["b", 10], ["h", 11]
  ];
  var pc = null, rest = "";
  for (var i = 0; i < roots.length; i++) {
    if (lower.indexOf(roots[i][0]) === 0) {
      pc = roots[i][1];
      rest = lower.slice(roots[i][0].length);
      break;
    }
  }
  if (pc === null) return null;
  var minor;
  if (rest.indexOf("mol") !== -1) minor = true;
  else if (rest.indexOf("dur") !== -1) minor = false;
  else minor = raw[0] === raw[0].toLowerCase();
  return { pc: pc, minor: minor };
}

export function formatKey(pc, minor) {
  return NOTE_NAMES[pc] + (minor ? "-mol" : "-dur");
}

export function selectedOctave() {
  return state.baseOctave;
}

function normalizePc(pc) {
  return ((Number(pc) % 12) + 12) % 12;
}

function selectedRootMidi(rootPc, options) {
  var root = normalizePc(rootPc);
  var octaveBase = (selectedOctave() + 1) * 12;
  if (state.octaveLocked) return octaveBase + root;
  var anchor = options && options.anchorPc !== undefined ? normalizePc(options.anchorPc) : root;
  return octaveBase + anchor + ((root - anchor + 12) % 12);
}

function uniqueSortedIntervals(intervals) {
  return Array.from(new Set(intervals)).sort(function (a, b) { return a - b; });
}

function chordIntervals(quality, variantId) {
  if (variantId === "sus") return [0, 5, 7];
  if (variantId === "dim") return [0, 3, 6];
  if (variantId === "maj7") return [0, quality === "min" ? 3 : 4, quality === "dim" ? 6 : 7, 11];

  var base = TRIAD[quality] || TRIAD.maj;
  if (variantId === "7" || variantId === "9") {
    var seventh = 10;
    var out = base.concat([seventh]);
    if (variantId === "9") out.push(14);
    return uniqueSortedIntervals(out);
  }
  return base.slice();
}

function chordName(rootPc, quality, variantId) {
  var variant = CHORD_VARIANTS[variantId] || CHORD_VARIANTS.triad;
  return NOTE_NAMES[rootPc] + (variant.suffix[quality] || variant.suffix.maj || "");
}

function inversionLabel(step) {
  if (!step) return "osnovni hvat";
  return step + ". obrt";
}

function applyInversion(intervals, step) {
  var out = uniqueSortedIntervals(intervals);
  var maxStep = Math.max(0, out.length - 1);
  var count = Math.max(0, Math.min(maxStep, Number(step) || 0));
  for (var i = 0; i < count; i++) {
    out.push(out.shift() + 12);
  }
  return out;
}

function chordMidisFromIntervals(rootPc, intervals, inversion, options) {
  var base = selectedRootMidi(rootPc, options);
  return applyInversion(intervals, inversion).map(function (iv) { return base + iv; });
}

function chordMidis(rootPc, type) {
  return chordMidisFromIntervals(rootPc, TRIAD[type] || TRIAD.maj, 0);
}

function noteNamesForIntervals(rootPc, intervals) {
  return uniqueSortedIntervals(intervals).map(function (iv) { return NOTE_NAMES[(rootPc + iv) % 12]; }).join(" ");
}

export function pressKeys(midis, holdMs, card) {
  var keys = midis.map(function (m) { return document.querySelector('.key[data-midi="' + m + '"]'); }).filter(Boolean);
  if (!keys.length) return;
  if (card) card.classList.add("playing");
  keys.forEach(function (k) {
    k.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerId: 900 + Number(k.dataset.midi) }));
  });
  setTimeout(function () {
    keys.forEach(function (k) {
      k.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerId: 900 + Number(k.dataset.midi) }));
    });
    if (card) card.classList.remove("playing");
  }, holdMs || 650);
}

// Oznacavanje na virtuelnom klaviru
let activeHint = null;
let hintClearTimer = null;

function clearHintTimer() {
  if (hintClearTimer) {
    window.clearTimeout(hintClearTimer);
    hintClearTimer = null;
  }
}

export function renderHint(hint) {
  if (!hint) return;
  var base = selectedRootMidi(hint.rootPc, { anchorPc: hint.anchorPc });
  var midis = hint.midis ? hint.midis.slice() : hint.intervals.map(function (iv) { return base + iv; });
  var pcs = new Set(midis.map(function (m) { return ((m % 12) + 12) % 12; }));
  
  document.querySelectorAll("#keyboard .key.root-hint, #keyboard .key.scale-hint").forEach(function (key) {
    key.classList.remove("root-hint", "scale-hint");
  });
  
  if (hint.allOctaves) {
    document.querySelectorAll("#keyboard .key").forEach(function (key) {
      var pc = ((Number(key.dataset.midi) % 12) + 12) % 12;
      if (pcs.has(pc)) key.classList.add("scale-hint");
    });
  } else {
    midis.forEach(function (m) {
      var key = document.querySelector('.key[data-midi="' + m + '"]');
      if (key) key.classList.add("scale-hint");
    });
  }
  
  const dockScaleName = document.getElementById("dockScaleName");
  if (dockScaleName) dockScaleName.textContent = hint.label || "";
}

export function paintScale(rootPc, intervals, label, options) {
  clearHintTimer();
  activeHint = {
    rootPc: rootPc,
    intervals: intervals.slice(),
    label: label || "",
    autoClear: !!(options && options.autoClear),
    allOctaves: !!(options && options.allOctaves),
    anchorPc: options && options.anchorPc !== undefined ? normalizePc(options.anchorPc) : rootPc
  };
  renderHint(activeHint);
  if (activeHint.autoClear) {
    hintClearTimer = window.setTimeout(clearScale, options && options.holdMs ? options.holdMs : 900);
  }
}

export function paintMidis(midis, label, options) {
  clearHintTimer();
  activeHint = {
    rootPc: midis.length ? ((midis[0] % 12) + 12) % 12 : 0,
    intervals: [],
    midis: midis.slice(),
    label: label || "",
    autoClear: !!(options && options.autoClear),
    allOctaves: !!(options && options.allOctaves)
  };
  renderHint(activeHint);
  if (activeHint.autoClear) {
    hintClearTimer = window.setTimeout(clearScale, options && options.holdMs ? options.holdMs : 900);
  }
}

export function clearScale() {
  clearHintTimer();
  activeHint = null;
  document.querySelectorAll("#keyboard .key.root-hint, #keyboard .key.scale-hint").forEach(function (key) {
    key.classList.remove("root-hint", "scale-hint");
  });
  const dockScaleName = document.getElementById("dockScaleName");
  if (dockScaleName) dockScaleName.textContent = "";
}

export function getActiveHint() {
  return activeHint;
}

// ---------------- METRONOM & DRUM MACHINE ----------------
export const metro = {
  bpm: 96,
  sig: "4/4",
  rhythm: "click",
  beatIndex: -1,
  stepIndex: -1,
  timer: null,
  audio: null,
  taps: []
};

// Proceduralni zvuk Kick bubnja
function playKick(audioContext, time) {
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.connect(gain);
  gain.connect(audioContext.destination);

  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.1);

  gain.gain.setValueAtTime(1.0, time);
  gain.gain.exponentialRampToValueAtTime(0.01, time + 0.12);

  osc.start(time);
  osc.stop(time + 0.15);
}

// Proceduralni zvuk Snare bubnja
function playSnare(audioContext, time, volume = 0.7) {
  const bufferSize = audioContext.sampleRate * 0.15;
  const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = audioContext.createBufferSource();
  noise.buffer = buffer;

  const filter = audioContext.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 1000;

  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.005, time + 0.12);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);

  // quick shell click
  const osc = audioContext.createOscillator();
  const oscGain = audioContext.createGain();
  osc.frequency.setValueAtTime(180, time);
  oscGain.gain.setValueAtTime(volume * 0.4, time);
  oscGain.gain.exponentialRampToValueAtTime(0.005, time + 0.08);

  osc.connect(oscGain);
  oscGain.connect(audioContext.destination);

  noise.start(time);
  noise.stop(time + 0.15);
  osc.start(time);
  osc.stop(time + 0.1);
}

// Proceduralni zvuk Hi-Hat-a (cimbala)
function playHiHat(audioContext, time, open = false) {
  const duration = open ? 0.25 : 0.05;
  const bufferSize = audioContext.sampleRate * duration;
  const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = audioContext.createBufferSource();
  noise.buffer = buffer;

  const filter = audioContext.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 7500;

  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0.25, time);
  gain.gain.exponentialRampToValueAtTime(0.01, time + duration - 0.01);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);

  noise.start(time);
  noise.stop(time + duration);
}

function playDrumPatternStep(rhythm, step) {
  if (!metro.audio) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    metro.audio = new AudioContext();
  }
  if (metro.audio.state === "suspended") metro.audio.resume();

  const time = metro.audio.currentTime;

  if (rhythm === "rock") {
    if (step === 0 || step === 4) playKick(metro.audio, time);
    if (step === 2 || step === 6) playSnare(metro.audio, time);
    playHiHat(metro.audio, time, step === 7);
  } else if (rhythm === "funk") {
    if (step === 0 || step === 3 || step === 4) playKick(metro.audio, time);
    if (step === 2 || step === 6) playSnare(metro.audio, time);
    else if (step === 7) playSnare(metro.audio, time, 0.15); // Ghost note
    playHiHat(metro.audio, time, step === 5);
  } else if (rhythm === "swing") {
    if (step === 0 || step === 6) playKick(metro.audio, time);
    if (step === 3 || step === 9) playSnare(metro.audio, time);
    if ([0, 2, 3, 5, 6, 8, 9, 11].includes(step)) {
      playHiHat(metro.audio, time, [2, 8].includes(step));
    }
  } else if (rhythm === "rumba") {
    if (step === 0 || step === 3 || step === 4 || step === 7) playKick(metro.audio, time);
    if (step === 2 || step === 5) playSnare(metro.audio, time);
    playHiHat(metro.audio, time, step === 3);
  }
}

export function initMetronome() {
  const mtPlay = document.getElementById("mtPlay");
  if (!mtPlay) return;

  const beatsBySig = { "2/4": 2, "3/4": 3, "4/4": 4, "6/8": 6, "7/8": 7, "9/8": 9 };

  function drawBeats() {
    const wrap = document.getElementById("mtBeats");
    if (!wrap) return;
    const n = beatsBySig[metro.sig] || 4;
    wrap.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const dot = document.createElement("span");
      dot.className = "beat" + (i === 0 ? " strong" : "") + (i === metro.beatIndex ? " hit" : "");
      wrap.appendChild(dot);
    }
  }

  function updateBpm() {
    const mtVal = document.getElementById("mtVal");
    if (mtVal) mtVal.textContent = metro.bpm;
  }

  function click(accent) {
    if (!metro.audio) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      metro.audio = new AudioContext();
    }
    if (metro.audio.state === "suspended") metro.audio.resume();

    const osc = metro.audio.createOscillator();
    const gain = metro.audio.createGain();

    osc.frequency.value = accent ? 1250 : 780;
    gain.gain.setValueAtTime(accent ? 0.5 : 0.3, metro.audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, metro.audio.currentTime + 0.07);

    osc.connect(gain);
    gain.connect(metro.audio.destination);

    osc.start();
    osc.stop(metro.audio.currentTime + 0.08);
  }

  function tick() {
    const is44 = metro.sig === "4/4";
    const rhythm = metro.rhythm;

    if (rhythm === "click" || !is44) {
      // Standard metronome click on each beat
      metro.beatIndex = (metro.beatIndex + 1) % (beatsBySig[metro.sig] || 4);
      click(metro.beatIndex === 0);
    } else {
      // Drum machine sequence
      const totalSteps = rhythm === "swing" ? 12 : 8;
      const subdivPerBeat = rhythm === "swing" ? 3 : 2;

      metro.stepIndex = (metro.stepIndex + 1) % totalSteps;
      metro.beatIndex = Math.floor(metro.stepIndex / subdivPerBeat);

      playDrumPatternStep(rhythm, metro.stepIndex);
    }
    drawBeats();
  }

  function stop() {
    if (metro.timer) {
      window.clearInterval(metro.timer);
      metro.timer = null;
    }
    metro.beatIndex = -1;
    metro.stepIndex = -1;
    drawBeats();
    if (mtPlay) mtPlay.innerHTML = "&#9654; Start";
  }

  function start() {
    if (metro.timer) return;
    if (mtPlay) mtPlay.innerHTML = "&#9632; Stop";
    metro.beatIndex = -1;
    metro.stepIndex = -1;
    tick();

    const intervalMs = (metro.rhythm === "click" || metro.sig !== "4/4")
      ? (60000 / metro.bpm)
      : (metro.rhythm === "swing" ? (20000 / metro.bpm) : (30000 / metro.bpm));

    metro.timer = window.setInterval(tick, intervalMs);
  }

  function restart() {
    const wasRunning = !!metro.timer;
    stop();
    if (wasRunning) start();
  }

  const mtUp = document.getElementById("mtUp");
  if (mtUp) mtUp.addEventListener("click", () => {
    metro.bpm = Math.min(240, metro.bpm + 1);
    updateBpm();
    restart();
  });

  const mtDown = document.getElementById("mtDown");
  if (mtDown) mtDown.addEventListener("click", () => {
    metro.bpm = Math.max(30, metro.bpm - 1);
    updateBpm();
    restart();
  });

  const mtSig = document.getElementById("mtSig");
  const mtRhythm = document.getElementById("mtRhythm");

  if (mtSig) mtSig.addEventListener("change", (event) => {
    metro.sig = event.target.value;
    // Ako se izabere bilo koji takt osim 4/4, drum machine ritmovi se vracaju na obican metronom klik
    if (metro.sig !== "4/4" && mtRhythm) {
      mtRhythm.value = "click";
      metro.rhythm = "click";
    }
    restart();
  });

  if (mtRhythm) mtRhythm.addEventListener("change", (event) => {
    metro.rhythm = event.target.value;
    // Ako se izabere drum machine ritam, automatski prebaci takt na 4/4
    if (metro.rhythm !== "click" && mtSig) {
      mtSig.value = "4/4";
      metro.sig = "4/4";
    }
    restart();
  });

  const mtTap = document.getElementById("mtTap");
  if (mtTap) mtTap.addEventListener("click", () => {
    const now = performance.now();
    metro.taps.push(now);
    metro.taps = metro.taps.filter((t) => now - t < 3200);
    if (metro.taps.length > 1) {
      const avg = (metro.taps[metro.taps.length - 1] - metro.taps[0]) / (metro.taps.length - 1);
      metro.bpm = Math.max(30, Math.min(240, Math.round(60000 / avg)));
      updateBpm();
      restart();
    }
  });

  mtPlay.addEventListener("click", () => {
    if (metro.timer) stop();
    else start();
  });

  updateBpm();
  drawBeats();
}

// ---------------- ALATI (akordi, skale, vezba, chart) ----------------
export const TOOLS = {
  akordi: function () {
    const toolBody = document.getElementById("toolBody");
    toolBody.innerHTML = '<div class="scale-head">' + keyPickerHTML("ak") +
      '<label>Tip <select id="akVariant">' +
      '<option value="all">Sve</option><option value="triad">Osnovni</option><option value="7">7</option><option value="9">9</option>' +
      '<option value="sus">sus</option><option value="maj7">maj7</option><option value="dim">dim</option></select></label>' +
      '<label>Hvat <select id="akInversion">' +
      '<option value="0">osnovni</option><option value="1">1. obrt</option><option value="2">2. obrt</option><option value="3">3. obrt</option></select></label>' +
      '<span class="tool-note" style="margin:0 0 0 auto">klik na akord - odsvira se izabrani hvat na klaviru dole</span></div>' +
      '<div class="deg-row expanded" id="akRow"></div>';
    
    var read = initKeyPicker("ak", renderRow);
    var akVariant = document.getElementById("akVariant");
    var akInversion = document.getElementById("akInversion");
    akVariant.addEventListener("change", renderRow);
    akInversion.addEventListener("change", renderRow);

    function renderRow() {
      var k = read();
      var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
      var variantIds = CHORD_VARIANT_GROUPS[akVariant.value] || CHORD_VARIANT_GROUPS.all;
      var inversion = Number(akInversion.value) || 0;
      var row = document.getElementById("akRow");
      row.innerHTML = "";
      degrees.forEach(function (d) {
        var pc = (k.pc + d[2]) % 12;
        variantIds.forEach(function (variantId) {
          var intervals = chordIntervals(d[1], variantId);
          var midis = chordMidisFromIntervals(pc, intervals, inversion, { anchorPc: k.pc });
          var name = chordName(pc, d[1], variantId);
          var actualInversion = Math.min(inversion, Math.max(0, midis.length - 1));
          var card = document.createElement("button");
          card.type = "button";
          card.className = "deg" + (d[3] ? " alt" : "");
          card.dataset.midis = midis.join(",");
          card.innerHTML = '<span class="r">' + d[0] + (variantId === "triad" ? "" : " · " + CHORD_VARIANTS[variantId].label) + '</span>' +
            '<span class="nm">' + name + "</span>" +
            '<span class="nt">' + noteNamesForIntervals(pc, intervals) + " · " + inversionLabel(actualInversion) + "</span>";
          card.addEventListener("click", function () {
            pressKeys(midis, 700, card);
            paintMidis(midis, name + " · " + inversionLabel(actualInversion), { autoClear: true, holdMs: 900 });
          });
          row.appendChild(card);
        });
      });
    }
    renderRow();
  },

  skale: function () {
    const toolBody = document.getElementById("toolBody");
    toolBody.innerHTML = '<div class="scale-head"><label>Osnova <select id="scRoot"></select></label>' +
      '<label>Skala <select id="scType"></select></label>' +
      '<label class="toggle-row inline-toggle"><input id="scAllOctaves" type="checkbox"><span>Ceo klavir</span></label>' +
      '<button class="text-button mini" id="scPlay" type="button">&#9654; Odsviraj</button>' +
      '<button class="text-button mini" id="scClear" type="button">Obrisi oznake</button></div>' +
      '<div class="formula" id="scFormula"></div>' +
      '<p class="tool-note">Oznaceni tonovi su prikazani jednako. Opcija <b>Ceo klavir</b> ponavlja iste tonove kroz sve oktave.</p>';
    
    var scRoot = document.getElementById("scRoot");
    var scType = document.getElementById("scType");
    var scAllOctaves = document.getElementById("scAllOctaves");
    
    NOTE_NAMES.forEach(function (n, i) { scRoot.add(new Option(n, i)); });
    Object.keys(SCALES).forEach(function (k) { scType.add(new Option(k, k)); });
    var k = shownKey();
    scRoot.value = String(k.pc);
    scType.value = k.minor ? "harmonijski mol" : "dur";
    scAllOctaves.checked = state.scaleAllOctaves;

    function update() {
      var pc = Number(scRoot.value) || 0;
      var ivs = SCALES[scType.value];
      paintScale(pc, ivs, NOTE_NAMES[pc] + " " + scType.value, { allOctaves: state.scaleAllOctaves, anchorPc: pc });
      document.getElementById("scFormula").innerHTML = ivs.map(function (iv) {
        return '<span class="fstep">' + NOTE_NAMES[(pc + iv) % 12] + "</span>";
      }).join("");
    }
    scRoot.addEventListener("change", update);
    scType.addEventListener("change", update);
    scAllOctaves.addEventListener("change", function () {
      state.scaleAllOctaves = scAllOctaves.checked;
      writeJsonStorage("fgr-ui-v1", { 
        theme: state.theme, 
        tool: state.tool, 
        scaleAllOctaves: state.scaleAllOctaves, 
        octaveLocked: state.octaveLocked 
      });
      update();
    });
    document.getElementById("scClear").addEventListener("click", clearScale);
    document.getElementById("scPlay").addEventListener("click", function () {
      var pc = Number(scRoot.value) || 0;
      var ivs = SCALES[scType.value].concat([12]);
      var base = selectedRootMidi(pc, { anchorPc: pc });
      ivs.forEach(function (iv, i) {
        setTimeout(function () { pressKeys([base + iv], 240); }, i * 280);
      });
    });
    update();
  },

  vezba: function () {
    const toolBody = document.getElementById("toolBody");
    toolBody.innerHTML = '<div class="practice expanded-practice">' +
      '<div class="practice-controls"><label>Tip vezbe <select id="vzMode">' +
      '<option value="all">Sve</option><option value="chord">Akordi i obrtaji</option><option value="scale">Skale</option>' +
      '<option value="interval">Intervali</option><option value="degree">Stepeni tonaliteta</option>' +
      '<option value="trans_drill">Transpozicija akorda</option></select></label>' +
      '<button class="text-button mini" id="vzNew" type="button">Novi zadatak</button>' +
      '<button class="text-button mini" id="vzSkip" type="button">Preskoci</button></div>' +
      '<div class="streak"><span>Niz: <b id="vzStreak">0</b></span><span>Tacno: <b id="vzScore">0/0</b></span>' +
      '<span>Tonalitet: <b id="vzKey"></b></span></div>' +
      '<div class="task"><div><div class="q" id="vzPrompt">Zadatak</div><div class="big" id="vzTask">-</div>' +
      '<div class="practice-answer" id="vzAnswer"></div></div><span class="st" id="vzState">ceka...</span></div>' +
      '<div class="practice-progress" id="vzProgress"></div>' +
      '<p class="tool-note"><b>Vezbe:</b> akordi sa 7/9/sus/maj/dim i obrtajima, skale, intervali, stepeni tonaliteta i transpozicioni izazovi. Radi preko MIDI klavijature i preko klavira dole.</p></div>';

    var k = shownKey();
    var modeSelect = document.getElementById("vzMode");
    var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
    var streak = 0, good = 0, total = 0, target = null, lock = false, inputHistory = new Set();
    document.getElementById("vzKey").textContent = formatKey(k.pc, k.minor);

    function rand(items) {
      return items[Math.floor(Math.random() * items.length)];
    }
    function pcsFrom(rootPc, intervals) {
      return Array.from(new Set(intervals.map(function (iv) { return (rootPc + iv) % 12; })));
    }
    function degreeName(d) {
      return d[0].replace(" dur", "");
    }
    function taskKinds() {
      return modeSelect.value === "all" ? ["chord", "scale", "interval", "degree", "trans_drill"] : [modeSelect.value];
    }
    function makeChordTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      var variantId = rand(["triad", "7", "9", "sus", "maj7", "dim"]);
      var intervals = chordIntervals(d[1], variantId);
      var inversion = Math.min(rand([0, 1, 2, 3]), Math.max(0, intervals.length - 1));
      var midis = chordMidisFromIntervals(pc, intervals, inversion, { anchorPc: k.pc });
      var name = chordName(pc, d[1], variantId);
      return {
        kind: "chord",
        prompt: "Odsviraj akord",
        title: name + " · " + inversionLabel(inversion),
        answer: degreeName(d) + " stepen · " + noteNamesForIntervals(pc, intervals),
        pcs: pcsFrom(pc, intervals),
        exact: true,
        bassPc: ((midis[0] % 12) + 12) % 12,
        midis: midis
      };
    }
    function makeTransDrillTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      var variantId = rand(["triad", "7", "maj7", "sus"]);
      var intervals = chordIntervals(d[1], variantId);
      var shift = rand([-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6]);
      var shiftedPc = (pc + shift + 12) % 12;
      var name = chordName(pc, d[1], variantId);
      var shiftedName = chordName(shiftedPc, d[1], variantId);
      var midis = chordMidisFromIntervals(shiftedPc, intervals, 0, { anchorPc: k.pc });
      return {
        kind: "trans_drill",
        prompt: "Transponuj akord na brzinu",
        title: name + " transponovano za " + (shift > 0 ? "+" + shift : shift) + " polust.",
        answer: shiftedName + " (" + noteNamesForIntervals(shiftedPc, intervals) + ")",
        pcs: pcsFrom(shiftedPc, intervals),
        exact: true,
        bassPc: shiftedPc,
        midis: midis
      };
    }
    function makeScaleTask() {
      var names = Object.keys(SCALES);
      var scaleName = rand(names);
      var rootPc = Math.random() < 0.65 ? k.pc : (k.pc + rand(degrees)[2]) % 12;
      var intervals = SCALES[scaleName];
      return {
        kind: "scale",
        prompt: "Odsviraj tonove skale",
        title: NOTE_NAMES[rootPc] + " " + scaleName,
        answer: intervals.map(function (iv) { return NOTE_NAMES[(rootPc + iv) % 12]; }).join(" "),
        pcs: pcsFrom(rootPc, intervals),
        accumulate: true,
        rootPc: rootPc,
        intervals: intervals
      };
    }
    function makeIntervalTask() {
      var d = rand(degrees);
      var rootPc = (k.pc + d[2]) % 12;
      var interval = rand(INTERVAL_DRILLS);
      return {
        kind: "interval",
        prompt: "Odsviraj interval",
        title: NOTE_NAMES[rootPc] + " + " + interval[0],
        answer: NOTE_NAMES[rootPc] + " - " + NOTE_NAMES[(rootPc + interval[1]) % 12],
        pcs: pcsFrom(rootPc, [0, interval[1]]),
        accumulate: true,
        midis: chordMidisFromIntervals(rootPc, [0, interval[1]], 0, { anchorPc: rootPc })
      };
    }
    function makeDegreeTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      return {
        kind: "degree",
        prompt: "Pronađi stepen tonaliteta",
        title: degreeName(d) + " u " + formatKey(k.pc, k.minor),
        answer: NOTE_NAMES[pc],
        pcs: [pc],
        accumulate: true,
        midis: [selectedRootMidi(pc, { anchorPc: k.pc })]
      };
    }
    function makeTask() {
      var kind = rand(taskKinds());
      if (kind === "scale") return makeScaleTask();
      if (kind === "interval") return makeIntervalTask();
      if (kind === "degree") return makeDegreeTask();
      if (kind === "trans_drill") return makeTransDrillTask();
      return makeChordTask();
    }
    function updateProgress() {
      if (!target) return;
      var done = target.pcs.filter(function (pc) { return inputHistory.has(pc); });
      document.getElementById("vzProgress").textContent = target.accumulate && done.length
        ? "Pogođeno: " + done.map(function (pc) { return NOTE_NAMES[pc]; }).join(" ") + " (" + done.length + "/" + target.pcs.length + ")"
        : "";
    }
    function paintTask() {
      if (target.kind === "scale") {
        paintScale(target.rootPc, target.intervals, target.title, { allOctaves: state.scaleAllOctaves, anchorPc: target.rootPc });
      } else {
        paintMidis(target.midis || target.pcs.map(selectedRootMidi), target.title);
      }
    }
    function newTask() {
      inputHistory = new Set();
      target = makeTask();
      lock = false;
      document.getElementById("vzPrompt").textContent = target.prompt;
      document.getElementById("vzTask").textContent = target.title;
      document.getElementById("vzAnswer").textContent = target.answer;
      document.getElementById("vzState").textContent = "čeka...";
      document.getElementById("vzState").classList.remove("good", "bad");
      document.getElementById("vzProgress").textContent = "";
      paintTask();
    }
    function markDone() {
      lock = true;
      streak++; good++; total++;
      document.getElementById("vzStreak").textContent = streak;
      document.getElementById("vzScore").textContent = good + "/" + total;
      document.getElementById("vzState").textContent = "Tačno!";
      document.getElementById("vzState").classList.remove("bad");
      document.getElementById("vzState").classList.add("good");
      window.setTimeout(newTask, 850);
    }
    function check(pcSet, meta) {
      if (lock || !target) return;
      if (meta && meta.down && Number.isFinite(meta.pc)) inputHistory.add(meta.pc);
      pcSet.forEach(function (pc) { inputHistory.add(pc); });
      updateProgress();

      var ok = false;
      if (target.exact) {
        ok = target.pcs.every(function (pc) { return pcSet.has(pc); }) && pcSet.size === target.pcs.length;
        if (ok && target.bassPc !== undefined && meta && Array.isArray(meta.midis) && meta.midis.length) {
          var bassMidi = meta.midis.reduce(function (a, b) { return a < b ? a : b; });
          ok = ((bassMidi % 12) + 12) % 12 === target.bassPc;
        }
        if (!ok && pcSet.size >= target.pcs.length) {
          document.getElementById("vzState").textContent = "probaj drugi hvat / obrt";
          document.getElementById("vzState").classList.add("bad");
        }
      } else {
        ok = target.pcs.every(function (pc) { return inputHistory.has(pc); });
      }
      if (ok) markDone();
    }

    setMidiOnChordCallback(check);
    modeSelect.addEventListener("change", newTask);
    document.getElementById("vzNew").addEventListener("click", newTask);
    document.getElementById("vzSkip").addEventListener("click", function () {
      streak = 0; total++;
      document.getElementById("vzStreak").textContent = "0";
      document.getElementById("vzScore").textContent = good + "/" + total;
      newTask();
    });
    connectMidi(true);
    newTask();
  },

  chart: function () {
    const toolBody = document.getElementById("toolBody");
    const currentSong = state.repertoire.find((song) => song.id === state.selectedSongId) || null;
    var chords = currentSong && Array.isArray(currentSong.chords) ? currentSong.chords : [];
    var head = '<div class="scale-head"><b style="font-size:12.5px">' +
      (currentSong ? (currentSong.title || "Pesma") : "Nema izabrane pesme") + " · chord chart</b>" +
      (currentSong ? '<button class="text-button mini primary-button" id="ccAdd" type="button">+ Akord na trenutno vreme</button>' : "") +
      '<span class="tool-note" style="margin:0">klik na akord — pesma skače na to mesto · desni klik briše</span></div>';
    
    toolBody.innerHTML = head + '<div class="cc-strip" id="ccStrip"></div>';
    var strip = document.getElementById("ccStrip");
    if (!chords.length) {
      strip.innerHTML = '<div class="chart-empty">Još nema akorda za ovu pesmu.<br>' +
        "Pusti pesmu i klikći <b>+ Akord na trenutno vreme</b> dok slušaš — ili sačekaj automatsko prepoznavanje iz koraka „Skidanja“.</div>";
    } else {
      chords.forEach(function (chord, index) {
        var cell = document.createElement("div");
        cell.className = "cc";
        cell.dataset.t = chord.t;
        cell.innerHTML = '<div class="n">' + transposeChordName(chord.n) + '</div><div class="t">' + fmtTime(chord.t) + "</div>";
        cell.addEventListener("click", function () {
          // prenosimo do ui-controllera preko eventa
          window.dispatchEvent(new CustomEvent("fgr:seekrequest", { detail: { time: chord.t } }));
          paintChordName(transposeChordName(chord.n), false);
        });
        cell.addEventListener("contextmenu", function (event) {
          event.preventDefault();
          if (confirm("Obriši " + chord.n + " (" + fmtTime(chord.t) + ")?")) {
            window.dispatchEvent(new CustomEvent("fgr:removechordrequest", { detail: { index } }));
          }
        });
        strip.appendChild(cell);
      });
    }
    
    const ccAdd = document.getElementById("ccAdd");
    if (ccAdd) ccAdd.addEventListener("click", function () {
      window.dispatchEvent(new CustomEvent("fgr:addchordrequest"));
    });
  },
  
  // Krug kvinti
  krug: function() {
    const toolBody = document.getElementById("toolBody");
    const live = state.currentPlaybackChordName ? "Live: " + state.currentPlaybackChordName : "Live: nema akorda";
    toolBody.innerHTML = '<div class="scale-head"><b>Krug kvinti</b><span class="tool-note" style="margin:0 0 0 auto">' + live + '</span></div>' +
      '<div class="circle-shell"><div id="circleContainer" style="max-width:340px;margin:0 auto;"></div></div>';
    renderCircleOfFifths();
  }
};

export function renderTool() {
  const toolBody = document.getElementById("toolBody");
  if (!toolBody) return;
  if (!TOOLS[state.tool]) {
    state.tool = "akordi";
    writeJsonStorage("fgr-ui-v1", { 
      theme: state.theme, 
      tool: state.tool, 
      scaleAllOctaves: state.scaleAllOctaves, 
      octaveLocked: state.octaveLocked 
    });
  }
  
  const chipsWrap = document.getElementById("toolChips");
  if (chipsWrap) {
    Array.prototype.forEach.call(chipsWrap.children, function (chip) {
      chip.classList.toggle("on", chip.dataset.m === state.tool);
    });
  }
  if (state.tool !== "vezba") {
    setMidiOnChordCallback(null);
  }
  TOOLS[state.tool]();
}

export function selectTool(name) {
  if (!TOOLS[name]) name = "akordi";
  state.tool = name;
  writeJsonStorage("fgr-ui-v1", { 
    theme: state.theme, 
    tool: state.tool, 
    scaleAllOctaves: state.scaleAllOctaves, 
    octaveLocked: state.octaveLocked 
  });
  
  const chipsWrap = document.getElementById("toolChips");
  if (chipsWrap) {
    Array.prototype.forEach.call(chipsWrap.children, function (chip) {
      chip.classList.toggle("on", chip.dataset.m === name);
    });
  }
  clearScale();
  renderTool();
}

// ---------------- KRUG KVINTI CRTANJE ----------------
// Globalna funkcija za reprodukciju akorada iz kruga kvinti
window.playCircleChord = function(pc, quality) {
  const intervals = quality === "minor" ? [0, 3, 7] : [0, 4, 7];
  const baseMidi = 12 * 3 + pc; // Oktava niže za puniji zvuk akorda (C3..)
  const midis = intervals.map(iv => baseMidi + iv);
  const label = NOTE_NAMES[pc] + (quality === "minor" ? "m" : "");
  
  pressKeys(midis, 800);
  paintMidis(midis, label, { autoClear: true, holdMs: 1000 });
};

function chordQualityFromName(name) {
  var m = String(name || "").trim().match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
  if (!m) return "major";
  var suffix = m[2].split("/")[0].trim();
  return suffix.indexOf("m") === 0 && suffix.indexOf("maj") !== 0 ? "minor" : "major";
}

function renderCircleOfFifths() {
  const container = document.getElementById("circleContainer");
  if (!container) return;

  const currentKey = shownKey();
  const circleMajor = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  const liveChord = parseChordName(state.currentPlaybackChordName || "");
  const liveQuality = chordQualityFromName(state.currentPlaybackChordName || "");
  const livePc = liveChord ? liveChord.pc : null;
  const keyMajorPc = currentKey.minor ? (currentKey.pc + 3) % 12 : currentKey.pc;
  const keyMinorPc = currentKey.minor ? currentKey.pc : (currentKey.pc + 9) % 12;

  let html = `<svg viewBox="0 0 300 300" width="100%" height="100%" aria-label="Krug kvinti">
    <circle cx="150" cy="150" r="142" fill="none" stroke="var(--line)" stroke-width="1" />
    <circle cx="150" cy="150" r="110" fill="none" stroke="var(--line)" stroke-width="1" />
    <circle cx="150" cy="150" r="78" fill="none" stroke="var(--line)" stroke-width="1" />
    <text x="150" y="144" text-anchor="middle" font-size="10" font-weight="800" fill="var(--muted)">TONALITET</text>
    <text x="150" y="160" text-anchor="middle" font-size="15" font-weight="900" fill="var(--ink)">${formatKey(currentKey.pc, currentKey.minor)}</text>`;

  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const xMajor = 150 + 126 * Math.cos(angle);
    const yMajor = 150 + 126 * Math.sin(angle);
    const pcMajor = circleMajor[i];

    const pcMinor = (pcMajor + 9) % 12;
    const xMinor = 150 + 94 * Math.cos(angle);
    const yMinor = 150 + 94 * Math.sin(angle);

    const isKeyMajor = pcMajor === keyMajorPc;
    const isKeyMinor = pcMinor === keyMinorPc;
    const isLiveMajor = livePc === pcMajor && liveQuality === "major";
    const isLiveMinor = livePc === pcMinor && liveQuality === "minor";

    let fillMajor = "transparent";
    let strokeMajor = "var(--line)";
    let textMajorColor = "var(--ink-2)";
    if (isLiveMajor) {
      fillMajor = "#2f9bff";
      strokeMajor = "#2f9bff";
      textMajorColor = "#ffffff";
    } else if (isKeyMajor) {
      fillMajor = "var(--accent)";
      strokeMajor = "var(--accent)";
      textMajorColor = "var(--accent-contrast)";
    }

    let fillMinor = "transparent";
    let strokeMinor = "var(--line)";
    let textMinorColor = "var(--muted)";
    if (isLiveMinor) {
      fillMinor = "#2f9bff";
      strokeMinor = "#2f9bff";
      textMinorColor = "#ffffff";
    } else if (isKeyMinor) {
      fillMinor = "var(--accent-soft)";
      strokeMinor = "color-mix(in srgb, var(--accent) 55%, transparent)";
      textMinorColor = "var(--accent-strong)";
    }

    html += `<g class="circle-chord-btn" onclick="window.playCircleChord(${pcMajor}, 'major')">
      <circle cx="${xMajor}" cy="${yMajor}" r="14" fill="${fillMajor}" stroke="${strokeMajor}" stroke-width="1.5" />
      <text x="${xMajor}" y="${yMajor + 4}" font-size="11" font-weight="800" text-anchor="middle" fill="${textMajorColor}">${NOTE_NAMES[pcMajor]}</text>
    </g>`;

    html += `<g class="circle-chord-btn" onclick="window.playCircleChord(${pcMinor}, 'minor')">
      <circle cx="${xMinor}" cy="${yMinor}" r="12" fill="${fillMinor}" stroke="${strokeMinor}" stroke-width="1.5" />
      <text x="${xMinor}" y="${yMinor + 4}" font-size="9" font-weight="700" text-anchor="middle" fill="${textMinorColor}">${NOTE_NAMES[pcMinor].toLowerCase()}m</text>
    </g>`;
  }

  html += `</svg>`;
  container.innerHTML = html;
}
// ---------------- POMOCNE ZA KEY PICKER ----------------
function keyPickerHTML(idPrefix) {
  return '<label>Tonalitet <select id="' + idPrefix + 'Root"></select></label>' +
    '<div class="segmented compact" role="radiogroup"><label><input type="radio" name="' + idPrefix + 'Q" value="major"><span>Dur</span></label>' +
    '<label><input type="radio" name="' + idPrefix + 'Q" value="minor"><span>Mol</span></label></div>';
}

function initKeyPicker(idPrefix, onChange) {
  var sel = document.getElementById(idPrefix + "Root");
  NOTE_NAMES.forEach(function (n, i) { sel.add(new Option(n, i)); });
  var k = shownKey();
  sel.value = String(k.pc);
  var radios = document.querySelectorAll('input[name="' + idPrefix + 'Q"]');
  radios.forEach(function (r) {
    r.checked = (r.value === "minor") === k.minor;
    r.addEventListener("change", onChange);
  });
  sel.addEventListener("change", onChange);
  return function read() {
    var minor = true;
    radios.forEach(function (r) { if (r.checked) minor = r.value === "minor"; });
    return { pc: Number(sel.value) || 0, minor: minor };
  };
}

function songKey() {
  const currentSong = state.repertoire.find((song) => song.id === state.selectedSongId) || null;
  var parsed = currentSong ? parseKey(currentSong.key) : null;
  return parsed || { pc: 9, minor: true }; // a-mol
}

export function shownKey() {
  var k = songKey();
  return { pc: ((k.pc + state.transpose) % 12 + 12) % 12, minor: k.minor };
}

export function transposeChordName(name) {
  if (state.transpose === 0) return name;
  var m = String(name).match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
  if (!m) return name;
  var pc = NOTE_NAMES.indexOf(m[1]);
  if (pc < 0) return name;
  return NOTE_NAMES[((pc + state.transpose) % 12 + 12) % 12] + m[2];
}

export function parseChordName(name) {
  var m = String(name || "").trim().match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
  if (!m) return null;
  var pc = NOTE_NAMES.indexOf(m[1]);
  var suffix = m[2].split("/")[0].trim();
  const NAME_SUFFIX = {
    "": [0, 4, 7], "m": [0, 3, 7], "dim": [0, 3, 6], "°": [0, 3, 6], "sus4": [0, 5, 7], "sus2": [0, 2, 7],
    "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11], "m7b5": [0, 3, 6, 10], "dim7": [0, 3, 6, 9], "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9]
  };
  var ivs = NAME_SUFFIX[suffix];
  if (!ivs) ivs = suffix.indexOf("m") === 0 ? NAME_SUFFIX.m : NAME_SUFFIX[""];
  return { pc: pc, ivs: ivs };
}

export function paintChordName(name, weak) {
  var parsed = parseChordName(name);
  if (!parsed) return;
  paintScale(parsed.pc, parsed.ivs, (weak ? "prati pesmu: " : "") + name, {
    autoClear: true,
    holdMs: weak ? 900 : 1200
  });
}
