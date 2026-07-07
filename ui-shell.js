/* FGR UI shell v2: radni sto — tema, alati, transpozicija, MIDI, metronom.
   Nezavisno od app.js; sa playerom komunicira preko window.FGRBridge. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var NOTE = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];
  var TRIAD = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6] };
  var SUFFIX = { maj: "", min: "m", dim: "°" };
  var CHORD_VARIANTS = {
    triad: { label: "Osnovni", short: "", suffix: { maj: "", min: "m", dim: "°" } },
    "7": { label: "7", short: "7", suffix: { maj: "7", min: "m7", dim: "m7b5" } },
    "9": { label: "9", short: "9", suffix: { maj: "9", min: "m9", dim: "dim9" } },
    sus: { label: "sus", short: "sus", suffix: { maj: "sus", min: "sus", dim: "sus" } },
    maj7: { label: "maj7", short: "maj", suffix: { maj: "maj7", min: "m maj7", dim: "dim maj7" } },
    dim: { label: "dim", short: "dim", suffix: { maj: "dim", min: "dim", dim: "dim" } }
  };
  var CHORD_VARIANT_GROUPS = {
    triad: ["triad"],
    "7": ["7"],
    "9": ["9"],
    sus: ["sus"],
    maj7: ["maj7"],
    dim: ["dim"],
    all: ["triad", "7", "9", "sus", "maj7", "dim"]
  };
  var INTERVAL_DRILLS = [
    ["mala sekunda", 1], ["velika sekunda", 2], ["mala terca", 3], ["velika terca", 4],
    ["kvarta", 5], ["tritonus", 6], ["kvinta", 7], ["mala seksta", 8],
    ["velika seksta", 9], ["mala septima", 10], ["velika septima", 11], ["oktava", 12]
  ];
  var MAJOR_DEGREES = [
    ["I", "maj", 0], ["ii", "min", 2], ["iii", "min", 4], ["IV", "maj", 5],
    ["V", "maj", 7], ["vi", "min", 9], ["vii°", "dim", 11]
  ];
  var MINOR_DEGREES = [
    ["i", "min", 0], ["ii°", "dim", 2], ["III", "maj", 3], ["iv", "min", 5],
    ["v", "min", 7], ["VI", "maj", 8], ["VII", "maj", 10], ["V dur", "maj", 7, true]
  ];
  var SCALES = {
    "prirodni mol": [0, 2, 3, 5, 7, 8, 10],
    "harmonijski mol": [0, 2, 3, 5, 7, 8, 11],
    "dur": [0, 2, 4, 5, 7, 9, 11],
    "mol pentatonika": [0, 3, 5, 7, 10],
    "blues": [0, 3, 5, 6, 7, 10],
    "dorska": [0, 2, 3, 5, 7, 9, 10],
    "miksolidijska": [0, 2, 4, 5, 7, 9, 10],
    "alterovana (jazz)": [0, 1, 3, 4, 6, 8, 10]
  };

  /* ---------- prefs ---------- */
  var STORAGE_KEY = "fgr-ui-v1";
  var prefs = { theme: "dark", tool: "akordi", scaleAllOctaves: false };
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved && typeof saved === "object") {
      if (saved.theme === "light" || saved.theme === "dark") prefs.theme = saved.theme;
      if (typeof saved.tool === "string") prefs.tool = saved.tool;
      if (typeof saved.scaleAllOctaves === "boolean") prefs.scaleAllOctaves = saved.scaleAllOctaves;
    }
  } catch (e) {}
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {} }

  /* ---------- tema + podesavanja ---------- */
  var root = document.documentElement;
  var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4"/>';
  var MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  var themeRadios = Array.prototype.slice.call(document.querySelectorAll("input[name='uiTheme']"));

  function applyTheme() {
    root.setAttribute("data-theme", prefs.theme);
    var icon = $("themeToggleIcon");
    if (icon) icon.innerHTML = prefs.theme === "dark" ? SUN : MOON;
    themeRadios.forEach(function (r) { r.checked = r.value === prefs.theme; });
    var meta = document.querySelector("meta[name='theme-color']");
    if (meta) meta.setAttribute("content", prefs.theme === "dark" ? "#141009" : "#efe9dd");
  }
  if ($("themeToggle")) $("themeToggle").addEventListener("click", function () {
    prefs.theme = prefs.theme === "dark" ? "light" : "dark"; save(); applyTheme();
  });
  themeRadios.forEach(function (r) {
    r.addEventListener("change", function () { if (r.checked) { prefs.theme = r.value; save(); applyTheme(); } });
  });
  if ($("settingsToggle") && $("settingsPanel")) {
    $("settingsToggle").addEventListener("click", function () {
      var show = $("settingsPanel").hidden;
      $("settingsPanel").hidden = !show;
      $("settingsToggle").setAttribute("aria-expanded", show ? "true" : "false");
    });
  }
  if ($("addSongToggle") && $("addSongForm")) {
    $("addSongToggle").addEventListener("click", function () {
      $("addSongForm").hidden = !$("addSongForm").hidden;
    });
  }

  /* ---------- pomocne ---------- */
  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function parseKey(text) {
    var raw = String(text || "").trim();
    if (!raw) return null;
    var lower = raw.toLowerCase().replace(/[\s\-_]+/g, "");
    var roots = [["cis", 1], ["dis", 3], ["eis", 5], ["fis", 6], ["gis", 8], ["ais", 10],
                 ["c", 0], ["d", 2], ["e", 4], ["f", 5], ["g", 7], ["a", 9], ["b", 10], ["h", 11]];
    var pc = null, rest = "";
    for (var i = 0; i < roots.length; i++) {
      if (lower.indexOf(roots[i][0]) === 0) { pc = roots[i][1]; rest = lower.slice(roots[i][0].length); break; }
    }
    if (pc === null) return null;
    var minor;
    if (rest.indexOf("mol") !== -1) minor = true;
    else if (rest.indexOf("dur") !== -1) minor = false;
    else minor = raw[0] === raw[0].toLowerCase();
    return { pc: pc, minor: minor };
  }
  function formatKey(pc, minor) { return NOTE[pc] + (minor ? "-mol" : "-dur"); }

  function selectedOctave() {
    var bridge = window.FGRBridge;
    var octave = bridge && typeof bridge.getBaseOctave === "function" ? Number(bridge.getBaseOctave()) : 4;
    return Number.isFinite(octave) ? Math.max(0, Math.min(8, octave)) : 4;
  }
  function selectedRootMidi(rootPc) {
    return (selectedOctave() + 1) * 12 + rootPc;
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
    return NOTE[rootPc] + (variant.suffix[quality] || variant.suffix.maj || "");
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
  function chordMidisFromIntervals(rootPc, intervals, inversion) {
    var base = selectedRootMidi(rootPc);
    return applyInversion(intervals, inversion).map(function (iv) { return base + iv; });
  }
  function chordMidis(rootPc, type) {
    return chordMidisFromIntervals(rootPc, TRIAD[type] || TRIAD.maj, 0);
  }
  function noteNamesForIntervals(rootPc, intervals) {
    return uniqueSortedIntervals(intervals).map(function (iv) { return NOTE[(rootPc + iv) % 12]; }).join(" ");
  }
  function pressKeys(midis, holdMs, card) {
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

  /* ---------- crtanje skale na pravom klaviru ---------- */
  var activeHint = null;
  var hintClearTimer = null;

  function clearHintTimer() {
    if (hintClearTimer) {
      window.clearTimeout(hintClearTimer);
      hintClearTimer = null;
    }
  }
  function renderHint(hint) {
    var base = selectedRootMidi(hint.rootPc);
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
    if ($("dockScaleName")) $("dockScaleName").textContent = hint.label || "";
  }
  function paintScale(rootPc, intervals, label, options) {
    clearHintTimer();
    activeHint = {
      rootPc: rootPc,
      intervals: intervals.slice(),
      label: label || "",
      autoClear: !!(options && options.autoClear),
      allOctaves: !!(options && options.allOctaves)
    };
    renderHint(activeHint);
    if (activeHint.autoClear) {
      hintClearTimer = window.setTimeout(clearScale, options && options.holdMs ? options.holdMs : 900);
    }
  }
  function paintMidis(midis, label, options) {
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
  function clearScale() {
    clearHintTimer();
    activeHint = null;
    document.querySelectorAll("#keyboard .key.root-hint, #keyboard .key.scale-hint").forEach(function (key) {
      key.classList.remove("root-hint", "scale-hint");
    });
    if ($("dockScaleName")) $("dockScaleName").textContent = "";
  }
  window.addEventListener("fgr:octavechange", function () {
    if (activeHint && !activeHint.autoClear) renderHint(activeHint);
    else clearScale();
  });
  window.addEventListener("fgr:keyboardready", function () {
    if (activeHint) renderHint(activeHint);
  });

  /* ---------- stanje pesme + transpozicija ---------- */
  var currentSong = null;
  var transpose = 0;

  function songKey() {
    var parsed = currentSong ? parseKey(currentSong.key) : null;
    return parsed || { pc: 9, minor: true }; /* a-mol podrazumevano */
  }
  function shownKey() {
    var k = songKey();
    return { pc: ((k.pc + transpose) % 12 + 12) % 12, minor: k.minor };
  }
  function updateToneCard() {
    var orig = currentSong ? parseKey(currentSong.key) : null;
    if ($("origKey")) $("origKey").textContent = orig ? formatKey(orig.pc, orig.minor) : (currentSong && currentSong.key ? currentSong.key : "—");
    var k = shownKey();
    if ($("transKey")) $("transKey").textContent = (currentSong || transpose !== 0) ? formatKey(k.pc, k.minor) : "—";
    if ($("transVal")) $("transVal").textContent = transpose > 0 ? "+" + transpose : (transpose < 0 ? String(transpose) : "±0");
  }
  if ($("transUp")) $("transUp").addEventListener("click", function () { transpose = Math.min(11, transpose + 1); afterTranspose(); });
  if ($("transDown")) $("transDown").addEventListener("click", function () { transpose = Math.max(-11, transpose - 1); afterTranspose(); });
  function afterTranspose() {
    updateToneCard();
    if (["akordi", "chart", "skale", "vezba"].indexOf(prefs.tool) !== -1) renderTool();
    renderMiniChart();
    if (typeof recRetune === "function") recRetune();
  }

  function transposeChordName(name) {
    if (transpose === 0) return name;
    var m = String(name).match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
    if (!m) return name;
    var pc = NOTE.indexOf(m[1]);
    if (pc < 0) return name;
    return NOTE[((pc + transpose) % 12 + 12) % 12] + m[2];
  }

  window.addEventListener("fgr:songchange", function (event) {
    currentSong = event.detail && event.detail.song ? event.detail.song : null;
    if ($("pillTitle")) $("pillTitle").textContent = currentSong ? (currentSong.title || "(bez naziva)") : "Izaberi pesmu";
    if ($("pillKey")) {
      $("pillKey").hidden = !(currentSong && currentSong.key);
      $("pillKey").textContent = currentSong && currentSong.key ? currentSong.key : "";
    }
    updateToneCard();
    renderMiniChart();
    if (prefs.tool === "akordi" || prefs.tool === "chart" || prefs.tool === "skale" || prefs.tool === "vezba") renderTool();
  });

  /* ---------- "Svira se" ogledalo ---------- */
  var activeChord = $("activeChordDisplay");
  var stage = $("stageChordName");
  function parseAppChord(text) {
    /* "C4 dur bliski (normalan) - C4 E4 G4" -> { name: "C dur", notes: "C E G" } */
    var parts = text.split(" - ");
    var main = parts[0].replace(/\([^)]*\)/g, "").trim();
    var words = main.split(/\s+/);
    var root = (words[0] || "").replace(/\d+/g, "");
    var quality = "";
    for (var i = 1; i < words.length; i++) {
      var w = words[i].toLowerCase();
      if (w === "dur" || w === "mol") { quality = w; break; }
      if (w.indexOf("sept") === 0) quality = quality || "7";
    }
    var notes = (parts[1] || "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
    return { name: (root + " " + quality).trim(), notes: notes };
  }
  function setStage(name, notes, idle) {
    if (stage) {
      stage.textContent = name;
      stage.classList.toggle("idle", !!idle);
    }
    var notesEl = $("stageChordNotes");
    if (notesEl) notesEl.textContent = notes ? "(" + notes + ")" : "";
  }
  function syncStage() {
    if (!activeChord || !stage) return;
    var midiName = detectMidiChord();
    if (midiName) {
      var midiNotes = Array.from(midiHeld).sort(function (a, b) { return a - b; })
        .map(function (m) { return NOTE[m % 12]; }).join(" ");
      setStage(midiName, midiHeld.size > 1 ? midiNotes : "", false);
      return;
    }
    var text = (activeChord.value || activeChord.textContent || "").trim();
    if (!text || text === "-") { setStage("—", "", true); return; }
    var parsed = parseAppChord(text);
    setStage(parsed.name || text, parsed.notes, false);
  }
  if (activeChord && stage && typeof MutationObserver !== "undefined") {
    new MutationObserver(syncStage).observe(activeChord, { childList: true, characterData: true, subtree: true });
    syncStage();
  }

  /* ---------- MIDI ---------- */
  var midiHeld = new Set();
  var midiOnChord = null; /* callback za vezbu */
  var MIDI_TEMPLATES = [["", [0, 4, 7]], ["m", [0, 3, 7]], ["dim", [0, 3, 6]], ["sus4", [0, 5, 7]], ["sus2", [0, 2, 7]],
    ["7", [0, 4, 7, 10]], ["m7", [0, 3, 7, 10]], ["maj7", [0, 4, 7, 11]], ["m7b5", [0, 3, 6, 10]], ["dim7", [0, 3, 6, 9]], ["6", [0, 4, 7, 9]], ["m6", [0, 3, 7, 9]]];
  function midiPcSet() {
    var set = new Set();
    midiHeld.forEach(function (m) { set.add(((m % 12) + 12) % 12); });
    return set;
  }
  function detectMidiChord() {
    if (!midiHeld || midiHeld.size === 0) return null;
    var notes = Array.from(midiHeld).sort(function (a, b) { return a - b; });
    if (notes.length === 1) return NOTE[notes[0] % 12];
    var pcs = Array.from(midiPcSet());
    var bassPc = notes[0] % 12;
    var best = null;
    for (var r = 0; r < pcs.length; r++) {
      var rootPc = pcs[r];
      var rel = pcs.map(function (pc) { return (pc - rootPc + 12) % 12; }).sort(function (a, b) { return a - b; });
      for (var t = 0; t < MIDI_TEMPLATES.length; t++) {
        var tpl = MIDI_TEMPLATES[t][1];
        if (tpl.length !== rel.length) continue;
        var match = tpl.every(function (iv) { return rel.indexOf(iv) !== -1; });
        if (match) {
          var score = tpl.length * 10 + (rootPc === bassPc ? 5 : 0);
          if (!best || score > best.score) best = { rootPc: rootPc, name: NOTE[rootPc] + MIDI_TEMPLATES[t][0], score: score };
        }
      }
    }
    if (!best) return pcs.map(function (pc) { return NOTE[pc]; }).join("·");
    return best.rootPc === bassPc ? best.name : best.name + "/" + NOTE[bassPc];
  }
  function onMidiMessage(event) {
    var st = event.data[0], d1 = event.data[1], d2 = event.data[2];
    var cmd = st & 0xF0;
    var changed = false;
    var isDown = cmd === 0x90 && d2 > 0;
    if (isDown) { midiHeld.add(d1); changed = true; }
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) { midiHeld.delete(d1); changed = true; }
    if (!changed) return;
    var key = document.querySelector('.key[data-midi="' + d1 + '"]');
    if (key) key.classList.toggle("midi-held", midiHeld.has(d1));
    syncStage();
    if (midiOnChord) midiOnChord(midiPcSet(), {
      down: isDown,
      midi: d1,
      pc: ((d1 % 12) + 12) % 12,
      midis: Array.from(midiHeld),
      source: "midi"
    });
  }
  function bindMidi(access) {
    var first = null, count = 0;
    access.inputs.forEach(function (input) {
      input.onmidimessage = onMidiMessage;
      if (!first) first = input;
      count++;
    });
    var led = $("midiLed"), name = $("midiName"), settingsStatus = $("midiSettingsStatus");
    if (count && first) {
      if (led) led.classList.remove("off");
      if (name) name.textContent = first.name || "MIDI";
      if (settingsStatus) settingsStatus.textContent = "✓ povezana: " + (first.name || "MIDI uredjaj");
    } else {
      if (led) led.classList.add("off");
      if (name) name.textContent = "MIDI";
      if (settingsStatus) settingsStatus.textContent = "nije povezana";
    }
  }
  function midiStatusMsg(text) {
    var el = $("midiSettingsStatus");
    if (el) el.textContent = text;
  }
  function connectMidi(silent) {
    if (!navigator.requestMIDIAccess) {
      midiStatusMsg("browser nema Web MIDI (koristi Chrome/Edge)");
      if (!silent) alert("Ovaj browser nema Web MIDI (koristi Chrome/Edge). Na iPad-u ne radi.");
      return;
    }
    if (!silent) midiStatusMsg("tražim uredjaje…");
    navigator.requestMIDIAccess().then(function (access) {
      bindMidi(access);
      access.onstatechange = function () { bindMidi(access); };
      if (access.inputs.size === 0) {
        midiStatusMsg("0 uredjaja — proveri: klavijatura ukljucena? kabl u USB DEVICE port? zatvori druge programe/tabove koji drze MIDI, pa klikni ponovo");
      }
    }).catch(function (err) {
      midiStatusMsg("pristup odbijen (" + err.message + ") — proveri dozvole sajta (katanac pored adrese)");
      if (!silent) alert("Pristup MIDI uredjajima je odbijen. Klikni katanac pored adrese sajta i dozvoli MIDI.");
    });
  }
  /* auto-povezivanje ako je dozvola vec data ranije */
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "midi", sysex: false }).then(function (st) {
      if (st.state === "granted") connectMidi(true);
    }).catch(function () {});
  }
  if ($("midiBadge")) $("midiBadge").addEventListener("click", function () { connectMidi(false); });
  if ($("midiConnectBtn")) $("midiConnectBtn").addEventListener("click", function () { connectMidi(false); });
  window.addEventListener("fgr:playchange", function (event) {
    if (!midiOnChord) return;
    var pcs = event.detail && Array.isArray(event.detail.pcs) ? event.detail.pcs : [];
    midiOnChord(new Set(pcs), {
      down: pcs.length > 0,
      pcs: pcs,
      midis: event.detail && Array.isArray(event.detail.midis) ? event.detail.midis : [],
      source: "app"
    });
  });

  /* ---------- naziv akorda -> tonovi (za crtanje hvata) ---------- */
  var NAME_SUFFIX = { "": [0, 4, 7], "m": [0, 3, 7], "dim": [0, 3, 6], "°": [0, 3, 6], "sus4": [0, 5, 7], "sus2": [0, 2, 7],
    "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11], "m7b5": [0, 3, 6, 10], "dim7": [0, 3, 6, 9], "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9] };
  function parseChordName(name) {
    var m = String(name || "").trim().match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
    if (!m) return null;
    var pc = NOTE.indexOf(m[1]);
    var suffix = m[2].split("/")[0].trim();
    var ivs = NAME_SUFFIX[suffix];
    if (!ivs) ivs = suffix.indexOf("m") === 0 ? NAME_SUFFIX.m : NAME_SUFFIX[""];
    return { pc: pc, ivs: ivs };
  }
  function paintChordName(name, weak) {
    var parsed = parseChordName(name);
    if (!parsed) return;
    paintScale(parsed.pc, parsed.ivs, (weak ? "prati pesmu: " : "") + name, {
      autoClear: true,
      holdMs: weak ? 900 : 1200
    });
  }

  /* ---------- brzina + A-B petlja ---------- */
  var RATES = [1, 0.75, 0.5];
  var rateIndex = 0;
  if ($("speedButton")) $("speedButton").addEventListener("click", function () {
    rateIndex = (rateIndex + 1) % RATES.length;
    var rate = RATES[rateIndex];
    if (window.FGRBridge) window.FGRBridge.setRate(rate);
    $("speedButton").textContent = rate === 1 ? "1×" : rate.toFixed(2).replace(/0$/, "") + "×";
    $("speedButton").classList.toggle("primary-button", rate !== 1);
  });

  var abA = null, abB = null, abTimer = null;
  function abStatus(text) { if ($("abLoopStatus")) $("abLoopStatus").textContent = text || ""; }
  if ($("abLoopButton")) $("abLoopButton").addEventListener("click", function () {
    var bridge = window.FGRBridge;
    if (!bridge) return;
    if (abA === null) {
      abA = bridge.getTime();
      abStatus("A " + fmtTime(abA) + " — klikni opet za B");
      $("abLoopButton").classList.add("primary-button");
    } else if (abB === null) {
      abB = bridge.getTime();
      if (abB <= abA + 1) { abB = null; abStatus("B mora biti posle A"); return; }
      abStatus("↻ " + fmtTime(abA) + " – " + fmtTime(abB));
      abTimer = window.setInterval(function () {
        var t = bridge.getTime();
        if (t > abB || t < abA - 2) bridge.seekTo(abA);
      }, 400);
    } else {
      abA = abB = null;
      if (abTimer) { window.clearInterval(abTimer); abTimer = null; }
      abStatus("");
      $("abLoopButton").classList.remove("primary-button");
    }
  });

  /* ---------- ALATI ---------- */
  var toolBody = $("toolBody");
  var chipsWrap = $("toolChips");

  function keyPickerHTML(idPrefix) {
    return '<label>Tonalitet <select id="' + idPrefix + 'Root"></select></label>' +
      '<div class="segmented compact" role="radiogroup"><label><input type="radio" name="' + idPrefix + 'Q" value="major"><span>Dur</span></label>' +
      '<label><input type="radio" name="' + idPrefix + 'Q" value="minor"><span>Mol</span></label></div>';
  }
  function initKeyPicker(idPrefix, onChange) {
    var sel = $(idPrefix + "Root");
    NOTE.forEach(function (n, i) { sel.add(new Option(n, i)); });
    var k = shownKey();
    sel.value = String(k.pc);
    var radios = document.querySelectorAll('input[name="' + idPrefix + 'Q"]');
    radios.forEach(function (r) { r.checked = (r.value === "minor") === k.minor; r.addEventListener("change", onChange); });
    sel.addEventListener("change", onChange);
    return function read() {
      var minor = true;
      radios.forEach(function (r) { if (r.checked) minor = r.value === "minor"; });
      return { pc: Number(sel.value) || 0, minor: minor };
    };
  }

  function initMetronome() {
    if (!$("mtPlay")) return;
    var beatsBySig = { "2/4": 2, "3/4": 3, "4/4": 4, "6/8": 6, "7/8": 7, "9/8": 9 };
    var metro = {
      bpm: 96,
      sig: $("mtSig") ? $("mtSig").value : "4/4",
      beatIndex: -1,
      timer: null,
      audio: null,
      taps: []
    };

    function drawBeats() {
      var wrap = $("mtBeats");
      if (!wrap) return;
      var n = beatsBySig[metro.sig] || 4;
      wrap.innerHTML = "";
      for (var i = 0; i < n; i++) {
        var dot = document.createElement("span");
        dot.className = "beat" + (i === 0 ? " strong" : "") + (i === metro.beatIndex ? " hit" : "");
        wrap.appendChild(dot);
      }
    }
    function updateBpm() {
      if ($("mtVal")) $("mtVal").textContent = metro.bpm;
    }
    function click(accent) {
      if (!metro.audio) metro.audio = new (window.AudioContext || window.webkitAudioContext)();
      if (metro.audio.state === "suspended") metro.audio.resume();
      var osc = metro.audio.createOscillator(), gain = metro.audio.createGain();
      osc.frequency.value = accent ? 1250 : 780;
      gain.gain.setValueAtTime(accent ? 0.5 : 0.3, metro.audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, metro.audio.currentTime + 0.07);
      osc.connect(gain); gain.connect(metro.audio.destination);
      osc.start(); osc.stop(metro.audio.currentTime + 0.08);
    }
    function tick() {
      metro.beatIndex = (metro.beatIndex + 1) % (beatsBySig[metro.sig] || 4);
      click(metro.beatIndex === 0);
      drawBeats();
    }
    function stop() {
      if (metro.timer) {
        window.clearInterval(metro.timer);
        metro.timer = null;
      }
      metro.beatIndex = -1;
      drawBeats();
      if ($("mtPlay")) $("mtPlay").innerHTML = "&#9654; Start";
    }
    function start() {
      if (metro.timer) return;
      if ($("mtPlay")) $("mtPlay").innerHTML = "&#9632; Stop";
      metro.beatIndex = -1;
      tick();
      metro.timer = window.setInterval(tick, 60000 / metro.bpm);
    }
    function restart() {
      var wasRunning = !!metro.timer;
      stop();
      if (wasRunning) start();
    }

    if ($("mtUp")) $("mtUp").addEventListener("click", function () {
      metro.bpm = Math.min(240, metro.bpm + 1);
      updateBpm();
      restart();
    });
    if ($("mtDown")) $("mtDown").addEventListener("click", function () {
      metro.bpm = Math.max(30, metro.bpm - 1);
      updateBpm();
      restart();
    });
    if ($("mtSig")) $("mtSig").addEventListener("change", function (event) {
      metro.sig = event.target.value;
      restart();
    });
    if ($("mtTap")) $("mtTap").addEventListener("click", function () {
      var now = performance.now();
      metro.taps.push(now);
      metro.taps = metro.taps.filter(function (t) { return now - t < 3200; });
      if (metro.taps.length > 1) {
        var avg = (metro.taps[metro.taps.length - 1] - metro.taps[0]) / (metro.taps.length - 1);
        metro.bpm = Math.max(30, Math.min(240, Math.round(60000 / avg)));
        updateBpm();
        restart();
      }
    });
    $("mtPlay").addEventListener("click", function () {
      if (metro.timer) stop();
      else start();
    });
    updateBpm();
    drawBeats();
  }

  var TOOLS = {
    akordi: function () {
      toolBody.innerHTML = '<div class="scale-head">' + keyPickerHTML("ak") +
        '<span class="tool-note" style="margin:0 0 0 auto">klik na akord — odsvira se na klaviru dole</span></div>' +
        '<div class="deg-row" id="akRow"></div>';
      var read = initKeyPicker("ak", renderRow);
      function renderRow() {
        var k = read();
        var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
        var row = $("akRow");
        row.innerHTML = "";
        degrees.forEach(function (d) {
          var pc = (k.pc + d[2]) % 12;
          var name = NOTE[pc] + SUFFIX[d[1]];
          var card = document.createElement("button");
          card.type = "button";
          card.className = "deg" + (d[3] ? " alt" : "");
          card.innerHTML = '<span class="r">' + d[0] + '</span><span class="nm">' + name + "</span>" +
            '<span class="nt">' + TRIAD[d[1]].map(function (iv) { return NOTE[(pc + iv) % 12]; }).join(" ") + "</span>";
          card.addEventListener("click", function () {
            pressKeys(chordMidis(pc, d[1]), 650, card);
            paintScale(pc, TRIAD[d[1]], name + " (akord)", { autoClear: true, holdMs: 800 });
          });
          row.appendChild(card);
        });
      }
      renderRow();
    },

    skale: function () {
      toolBody.innerHTML = '<div class="scale-head"><label>Osnova <select id="scRoot"></select></label>' +
        '<label>Skala <select id="scType"></select></label>' +
        '<button class="text-button mini" id="scPlay" type="button">▶ Odsviraj</button>' +
        '<button class="text-button mini" id="scClear" type="button">Obriši oznake</button></div>' +
        '<div class="formula" id="scFormula"></div>' +
        '<p class="tool-note">Skala je <b>osvetljena na klaviru dole</b> — zlatno je osnovni ton. Sviraj preko nje, ili pusti pesmu pa vežbaj u njenom tonalitetu.</p>';
      var scRoot = $("scRoot"), scType = $("scType");
      NOTE.forEach(function (n, i) { scRoot.add(new Option(n, i)); });
      Object.keys(SCALES).forEach(function (k) { scType.add(new Option(k, k)); });
      var k = shownKey();
      scRoot.value = String(k.pc);
      scType.value = k.minor ? "harmonijski mol" : "dur";
      function update() {
        var pc = Number(scRoot.value) || 0;
        var ivs = SCALES[scType.value];
        paintScale(pc, ivs, NOTE[pc] + " " + scType.value);
        $("scFormula").innerHTML = ivs.map(function (iv, i) {
          return '<span class="fstep' + (i === 0 ? " root" : "") + '">' + NOTE[(pc + iv) % 12] + "</span>";
        }).join("");
      }
      scRoot.addEventListener("change", update);
      scType.addEventListener("change", update);
      $("scClear").addEventListener("click", clearScale);
      $("scPlay").addEventListener("click", function () {
        var pc = Number(scRoot.value) || 0;
        var ivs = SCALES[scType.value].concat([12]);
        var base = selectedRootMidi(pc);
        ivs.forEach(function (iv, i) {
          setTimeout(function () { pressKeys([base + iv], 240); }, i * 280);
        });
      });
      update();
    },

    vezba: function () {
      toolBody.innerHTML = '<div class="practice">' +
        '<div class="streak"><span>Niz: <b id="vzStreak">0</b></span><span>Tačno: <b id="vzScore">0/0</b></span>' +
        '<span>Tonalitet: <b id="vzKey"></b></span>' +
        '<button class="text-button mini" id="vzSkip" type="button" style="margin-left:auto">Preskoči</button></div>' +
        '<div class="task"><div><div class="q">Odsviraj na klavijaturi:</div><div class="big" id="vzTask">—</div></div>' +
        '<span class="st" id="vzState">čeka…</span></div>' +
        '<p class="tool-note" id="vzNote"><b>MIDI:</b> poveži klavijaturu (dugme gore desno) — app čuje tačno šta pritisneš i ocenjuje. Radi i sa klavirom dole (klik mod „Akord“).</p></div>';
      var k = shownKey();
      $("vzKey").textContent = formatKey(k.pc, k.minor);
      var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
      var streak = 0, good = 0, total = 0, target = null, lock = false;

      function newTask() {
        var d = degrees[Math.floor(Math.random() * degrees.length)];
        var pc = (k.pc + d[2]) % 12;
        target = { name: NOTE[pc] + SUFFIX[d[1]], pcs: TRIAD[d[1]].map(function (iv) { return (pc + iv) % 12; }) };
        $("vzTask").textContent = target.name;
        $("vzState").textContent = "čeka…";
        $("vzState").classList.remove("good");
        paintScale(pc, TRIAD[d[1]], target.name + " (zadatak)");
        lock = false;
      }
      function check(pcSet) {
        if (lock || !target || pcSet.size < target.pcs.length) return;
        var ok = target.pcs.every(function (pc) { return pcSet.has(pc); }) && pcSet.size === target.pcs.length;
        if (!ok) return;
        lock = true;
        streak++; good++; total++;
        $("vzStreak").textContent = streak;
        $("vzScore").textContent = good + "/" + total;
        $("vzState").textContent = "✓ Tačno!";
        $("vzState").classList.add("good");
        setTimeout(newTask, 700);
      }
      midiOnChord = check;
      $("vzSkip").addEventListener("click", function () { streak = 0; total++; $("vzStreak").textContent = "0"; $("vzScore").textContent = good + "/" + total; newTask(); });
      connectMidi(true);
      newTask();
    },

    chart: function () {
      var chords = currentSong && Array.isArray(currentSong.chords) ? currentSong.chords : [];
      var head = '<div class="scale-head"><b style="font-size:12.5px">' +
        (currentSong ? (currentSong.title || "Pesma") : "Nema izabrane pesme") + " · chord chart</b>" +
        (currentSong ? '<button class="text-button mini primary-button" id="ccAdd" type="button">+ Akord na trenutno vreme</button>' : "") +
        '<span class="tool-note" style="margin:0">klik na akord — pesma skače na to mesto · desni klik briše</span></div>';
      toolBody.innerHTML = head + '<div class="cc-strip" id="ccStrip"></div>';
      var strip = $("ccStrip");
      if (!chords.length) {
        strip.innerHTML = '<div class="chart-empty">Još nema akorda za ovu pesmu.<br>' +
          "Pusti pesmu i klikći <b>+ Akord na trenutno vreme</b> dok slušaš (npr. upiši Cm kad krene Cm) — ili sačekaj automatsko prepoznavanje iz koraka „Skidanja“.</div>";
      } else {
        chords.forEach(function (chord, index) {
          var cell = document.createElement("div");
          cell.className = "cc";
          cell.dataset.t = chord.t;
          cell.innerHTML = '<div class="n">' + transposeChordName(chord.n) + '</div><div class="t">' + fmtTime(chord.t) + "</div>";
          cell.addEventListener("click", function () {
            if (rec.playing) recSeek(chord.t);
            else if (window.FGRBridge) window.FGRBridge.seekTo(chord.t);
            paintChordName(transposeChordName(chord.n), false);
          });
          cell.addEventListener("contextmenu", function (event) {
            event.preventDefault();
            if (window.FGRBridge && confirm("Obriši " + chord.n + " (" + fmtTime(chord.t) + ")?")) {
              window.FGRBridge.removeChordFromSelected(index);
              TOOLS.chart();
            }
          });
          strip.appendChild(cell);
        });
      }
      if ($("ccAdd")) $("ccAdd").addEventListener("click", function () {
        if (!window.FGRBridge) return;
        var t = window.FGRBridge.getTime();
        var name = prompt("Akord na " + fmtTime(t) + ":", "");
        if (name && window.FGRBridge.addChordToSelected(name, t)) TOOLS.chart();
      });
    }
  };

  TOOLS.akordi = function () {
    toolBody.innerHTML = '<div class="scale-head">' + keyPickerHTML("ak") +
      '<label>Tip <select id="akVariant">' +
      '<option value="all">Sve</option><option value="triad">Osnovni</option><option value="7">7</option><option value="9">9</option>' +
      '<option value="sus">sus</option><option value="maj7">maj7</option><option value="dim">dim</option></select></label>' +
      '<label>Hvat <select id="akInversion">' +
      '<option value="0">osnovni</option><option value="1">1. obrt</option><option value="2">2. obrt</option><option value="3">3. obrt</option></select></label>' +
      '<span class="tool-note" style="margin:0 0 0 auto">klik na akord - odsvira se izabrani hvat na klaviru dole</span></div>' +
      '<div class="deg-row expanded" id="akRow"></div>';
    var read = initKeyPicker("ak", renderRow);
    var akVariant = $("akVariant");
    var akInversion = $("akInversion");
    akVariant.addEventListener("change", renderRow);
    akInversion.addEventListener("change", renderRow);

    function renderRow() {
      var k = read();
      var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
      var variantIds = CHORD_VARIANT_GROUPS[akVariant.value] || CHORD_VARIANT_GROUPS.all;
      var inversion = Number(akInversion.value) || 0;
      var row = $("akRow");
      row.innerHTML = "";
      degrees.forEach(function (d) {
        var pc = (k.pc + d[2]) % 12;
        variantIds.forEach(function (variantId) {
          var intervals = chordIntervals(d[1], variantId);
          var midis = chordMidisFromIntervals(pc, intervals, inversion);
          var name = chordName(pc, d[1], variantId);
          var actualInversion = Math.min(inversion, Math.max(0, midis.length - 1));
          var card = document.createElement("button");
          card.type = "button";
          card.className = "deg" + (d[3] ? " alt" : "");
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
  };

  TOOLS.skale = function () {
    toolBody.innerHTML = '<div class="scale-head"><label>Osnova <select id="scRoot"></select></label>' +
      '<label>Skala <select id="scType"></select></label>' +
      '<label class="toggle-row inline-toggle"><input id="scAllOctaves" type="checkbox"><span>Ceo klavir</span></label>' +
      '<button class="text-button mini" id="scPlay" type="button">&#9654; Odsviraj</button>' +
      '<button class="text-button mini" id="scClear" type="button">Obrisi oznake</button></div>' +
      '<div class="formula" id="scFormula"></div>' +
      '<p class="tool-note">Oznaceni tonovi su prikazani jednako. Opcija <b>Ceo klavir</b> ponavlja iste tonove kroz sve oktave.</p>';
    var scRoot = $("scRoot"), scType = $("scType"), scAllOctaves = $("scAllOctaves");
    NOTE.forEach(function (n, i) { scRoot.add(new Option(n, i)); });
    Object.keys(SCALES).forEach(function (k) { scType.add(new Option(k, k)); });
    var k = shownKey();
    scRoot.value = String(k.pc);
    scType.value = k.minor ? "harmonijski mol" : "dur";
    scAllOctaves.checked = prefs.scaleAllOctaves;

    function update() {
      var pc = Number(scRoot.value) || 0;
      var ivs = SCALES[scType.value];
      paintScale(pc, ivs, NOTE[pc] + " " + scType.value, { allOctaves: prefs.scaleAllOctaves });
      $("scFormula").innerHTML = ivs.map(function (iv) {
        return '<span class="fstep">' + NOTE[(pc + iv) % 12] + "</span>";
      }).join("");
    }
    scRoot.addEventListener("change", update);
    scType.addEventListener("change", update);
    scAllOctaves.addEventListener("change", function () {
      prefs.scaleAllOctaves = scAllOctaves.checked;
      save();
      update();
    });
    $("scClear").addEventListener("click", clearScale);
    $("scPlay").addEventListener("click", function () {
      var pc = Number(scRoot.value) || 0;
      var ivs = SCALES[scType.value].concat([12]);
      var base = selectedRootMidi(pc);
      ivs.forEach(function (iv, i) {
        setTimeout(function () { pressKeys([base + iv], 240); }, i * 280);
      });
    });
    update();
  };

  TOOLS.vezba = function () {
    toolBody.innerHTML = '<div class="practice expanded-practice">' +
      '<div class="practice-controls"><label>Tip vezbe <select id="vzMode">' +
      '<option value="all">Sve</option><option value="chord">Akordi i obrtaji</option><option value="scale">Skale</option>' +
      '<option value="interval">Intervali</option><option value="degree">Stepeni tonaliteta</option></select></label>' +
      '<button class="text-button mini" id="vzNew" type="button">Novi zadatak</button>' +
      '<button class="text-button mini" id="vzSkip" type="button">Preskoci</button></div>' +
      '<div class="streak"><span>Niz: <b id="vzStreak">0</b></span><span>Tacno: <b id="vzScore">0/0</b></span>' +
      '<span>Tonalitet: <b id="vzKey"></b></span></div>' +
      '<div class="task"><div><div class="q" id="vzPrompt">Zadatak</div><div class="big" id="vzTask">-</div>' +
      '<div class="practice-answer" id="vzAnswer"></div></div><span class="st" id="vzState">ceka...</span></div>' +
      '<div class="practice-progress" id="vzProgress"></div>' +
      '<p class="tool-note"><b>Vezbe:</b> akordi sa 7/9/sus/maj/dim i obrtajima, skale, intervali i stepeni tonaliteta. Radi preko MIDI klavijature i preko klavira dole.</p></div>';

    var k = shownKey();
    var modeSelect = $("vzMode");
    var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
    var streak = 0, good = 0, total = 0, target = null, lock = false, inputHistory = new Set();
    $("vzKey").textContent = formatKey(k.pc, k.minor);

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
      return modeSelect.value === "all" ? ["chord", "scale", "interval", "degree"] : [modeSelect.value];
    }
    function makeChordTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      var variantId = rand(["triad", "7", "9", "sus", "maj7", "dim"]);
      var intervals = chordIntervals(d[1], variantId);
      var inversion = Math.min(rand([0, 1, 2, 3]), Math.max(0, intervals.length - 1));
      var midis = chordMidisFromIntervals(pc, intervals, inversion);
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
    function makeScaleTask() {
      var names = Object.keys(SCALES);
      var scaleName = rand(names);
      var rootPc = Math.random() < 0.65 ? k.pc : (k.pc + rand(degrees)[2]) % 12;
      var intervals = SCALES[scaleName];
      return {
        kind: "scale",
        prompt: "Odsviraj tonove skale",
        title: NOTE[rootPc] + " " + scaleName,
        answer: intervals.map(function (iv) { return NOTE[(rootPc + iv) % 12]; }).join(" "),
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
        title: NOTE[rootPc] + " + " + interval[0],
        answer: NOTE[rootPc] + " - " + NOTE[(rootPc + interval[1]) % 12],
        pcs: pcsFrom(rootPc, [0, interval[1]]),
        accumulate: true,
        midis: chordMidisFromIntervals(rootPc, [0, interval[1]], 0)
      };
    }
    function makeDegreeTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      return {
        kind: "degree",
        prompt: "Pronadji stepen tonaliteta",
        title: degreeName(d) + " u " + formatKey(k.pc, k.minor),
        answer: NOTE[pc],
        pcs: [pc],
        accumulate: true,
        midis: [selectedRootMidi(pc)]
      };
    }
    function makeTask() {
      var kind = rand(taskKinds());
      if (kind === "scale") return makeScaleTask();
      if (kind === "interval") return makeIntervalTask();
      if (kind === "degree") return makeDegreeTask();
      return makeChordTask();
    }
    function updateProgress() {
      if (!target) return;
      var done = target.pcs.filter(function (pc) { return inputHistory.has(pc); });
      $("vzProgress").textContent = target.accumulate && done.length
        ? "Pogodjeno: " + done.map(function (pc) { return NOTE[pc]; }).join(" ") + " (" + done.length + "/" + target.pcs.length + ")"
        : "";
    }
    function paintTask() {
      if (target.kind === "scale") {
        paintScale(target.rootPc, target.intervals, target.title, { allOctaves: prefs.scaleAllOctaves });
      } else {
        paintMidis(target.midis || target.pcs.map(selectedRootMidi), target.title);
      }
    }
    function newTask() {
      inputHistory = new Set();
      target = makeTask();
      lock = false;
      $("vzPrompt").textContent = target.prompt;
      $("vzTask").textContent = target.title;
      $("vzAnswer").textContent = target.answer;
      $("vzState").textContent = "ceka...";
      $("vzState").classList.remove("good", "bad");
      $("vzProgress").textContent = "";
      paintTask();
    }
    function markDone() {
      lock = true;
      streak++; good++; total++;
      $("vzStreak").textContent = streak;
      $("vzScore").textContent = good + "/" + total;
      $("vzState").textContent = "Tacno!";
      $("vzState").classList.remove("bad");
      $("vzState").classList.add("good");
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
          $("vzState").textContent = "probaj drugi hvat / obrt";
          $("vzState").classList.add("bad");
        }
      } else {
        ok = target.pcs.every(function (pc) { return inputHistory.has(pc); });
      }
      if (ok) markDone();
    }

    midiOnChord = check;
    modeSelect.addEventListener("change", newTask);
    $("vzNew").addEventListener("click", newTask);
    $("vzSkip").addEventListener("click", function () {
      streak = 0; total++;
      $("vzStreak").textContent = "0";
      $("vzScore").textContent = good + "/" + total;
      newTask();
    });
    connectMidi(true);
    newTask();
  };

  function renderTool() {
    if (!toolBody) return;
    if (!TOOLS[prefs.tool]) {
      prefs.tool = "akordi";
      save();
    }
    if (chipsWrap) {
      Array.prototype.forEach.call(chipsWrap.children, function (chip) {
        chip.classList.toggle("on", chip.dataset.m === prefs.tool);
      });
    }
    if (prefs.tool !== "vezba") midiOnChord = null;
    TOOLS[prefs.tool]();
  }
  function selectTool(name) {
    if (!TOOLS[name]) name = "akordi";
    prefs.tool = name;
    save();
    if (chipsWrap) {
      Array.prototype.forEach.call(chipsWrap.children, function (chip) {
        chip.classList.toggle("on", chip.dataset.m === name);
      });
    }
    clearScale();
    renderTool();
  }
  if (chipsWrap) chipsWrap.addEventListener("click", function (event) {
    var chip = event.target.closest(".chip");
    if (chip) selectTool(chip.dataset.m);
  });
  if ($("practiceSongButton")) $("practiceSongButton").addEventListener("click", function () { selectTool("vezba"); });

  /* ---------- desna kolona: mini chart + pracenje vremena ---------- */
  function renderMiniChart() {
    var wrap = $("miniChart");
    if (!wrap) return;
    var chords = currentSong && Array.isArray(currentSong.chords) ? currentSong.chords : [];
    if ($("learnChartInfo")) $("learnChartInfo").textContent = chords.length ? chords.length + " akorada" : "nema";
    if ($("learnProgressBar")) $("learnProgressBar").style.width = chords.length ? "100%" : "0%";
    if (!chords.length) {
      wrap.innerHTML = '<div class="mini-empty">Još nema akorda za ovu pesmu.<br>Upiši ih u <b>Chord chart</b> alatu dok pesma svira, ili sačekaj automatsko prepoznavanje.</div>';
      return;
    }
    wrap.innerHTML = "";
    chords.forEach(function (chord) {
      var item = document.createElement("div");
      item.className = "mini-cc";
      item.dataset.t = chord.t;
      item.innerHTML = '<span class="n">' + transposeChordName(chord.n) + '</span><span class="t">' + fmtTime(chord.t) + "</span>";
      item.addEventListener("click", function () {
        if (rec.playing) recSeek(chord.t);
        else if (window.FGRBridge) window.FGRBridge.seekTo(chord.t);
        paintChordName(transposeChordName(chord.n), false);
      });
      wrap.appendChild(item);
    });
  }

  var lastFollowedChord = null;
  window.setInterval(function () {
    if (!currentSong) return;
    var t = rec.playing ? recTime() : (window.FGRBridge ? window.FGRBridge.getTime() : 0);
    if (rec.playing) updateRecRow();
    if (!t) return;
    var currentName = null;
    ["miniChart", "ccStrip"].forEach(function (id) {
      var wrap = $(id);
      if (!wrap) return;
      var cells = wrap.querySelectorAll("[data-t]");
      var current = null;
      cells.forEach(function (cell) { if (Number(cell.dataset.t) <= t) current = cell; });
      cells.forEach(function (cell) {
        cell.classList.toggle("now", cell === current);
        cell.classList.toggle("on", cell === current);
      });
      if (current) {
        currentName = (current.querySelector(".n") || current).textContent.trim();
        if (id === "ccStrip") current.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }
    });
    /* pesma "vodi" klavir bledom bojom — osim kad Skale/Vezba drze klavir */
    if (currentName && currentName !== lastFollowedChord && prefs.tool !== "skale" && prefs.tool !== "vezba") {
      lastFollowedChord = currentName;
      paintChordName(currentName, true);
    }
  }, 600);

  /* ---------- Skidanje: snimi jednom + prepoznaj akorde ---------- */
  var DB_NAME = "fgr-capture", DB_STORE = "songs";
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        if (!e.target.result.objectStoreNames.contains(DB_STORE)) e.target.result.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }
  function dbPut(item) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(item);
        tx.oncomplete = resolve; tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }
  function dbGet(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(DB_STORE).objectStore(DB_STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }
  function recId() { return currentSong ? "song-" + currentSong.id : null; }
  function pipeStatus(text) { if ($("pipeStatus")) $("pipeStatus").textContent = text || ""; }

  function refreshPipe() {
    var recSt = $("pipeRecSt"), chSt = $("pipeChordsSt"), rdSt = $("pipeReadSt");
    var chords = currentSong && Array.isArray(currentSong.chords) ? currentSong.chords.length : 0;
    if (chSt) { chSt.textContent = chords ? "✓ " + chords : ""; chSt.classList.toggle("ok", chords > 0); }
    if (rdSt) { rdSt.textContent = chords ? "✓ spremno" : ""; rdSt.classList.toggle("ok", chords > 0); }
    if (!recSt) return;
    var id = recId();
    if (!id) { recSt.textContent = ""; return; }
    dbGet(id).then(function (item) {
      recSt.textContent = item ? "✓ " + fmtTime(item.dur) : "";
      recSt.classList.toggle("ok", !!item);
    }).catch(function () {});
  }
  window.addEventListener("fgr:songchange", refreshPipe);
  window.addEventListener("fgr:songchange", function () { if (typeof updateRecRow === "function") setTimeout(updateRecRow, 0); });

  var capStream = null, capRec = null, capChunks = [], capStart = 0, capTimer = null;
  function stopCapture() {
    if (capRec && capRec.state !== "inactive") capRec.stop();
    if (capStream) capStream.getTracks().forEach(function (t) { t.stop(); });
    if (capTimer) { clearInterval(capTimer); capTimer = null; }
    var btn = $("pipeRec");
    if (btn) { btn.classList.remove("rec"); btn.querySelector(".tt").textContent = "Snimi jednom"; }
  }
  if ($("pipeRec")) $("pipeRec").addEventListener("click", function () {
    if (capRec && capRec.state === "recording") { stopCapture(); return; }
    if (!currentSong) { pipeStatus("Prvo izaberi pesmu u repertoaru."); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { pipeStatus("Deljenje taba ne radi u ovom browseru (Chrome/Edge desktop)."); return; }
    navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: "include"
    }).then(function (stream) {
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        pipeStatus("Nema zvuka — pri deljenju čekiraj „Deli audio taba”.");
        return;
      }
      capStream = stream;
      var audioStream = new MediaStream([stream.getAudioTracks()[0]]);
      var mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      capRec = new MediaRecorder(audioStream, { mimeType: mime });
      capChunks = [];
      capRec.ondataavailable = function (e) { if (e.data.size) capChunks.push(e.data); };
      capRec.onstop = function () {
        var blob = new Blob(capChunks, { type: capChunks[0] ? capChunks[0].type : "audio/webm" });
        var dur = Math.round((Date.now() - capStart) / 1000);
        var id = recId();
        if (!id || dur < 3) { pipeStatus("Snimak prekratak — nije sačuvan."); return; }
        dbPut({ id: id, blob: blob, dur: dur, at: Date.now() }).then(function () {
          pipeStatus("Snimljeno " + fmtTime(dur) + " — sada klikni „3 Prepoznaj akorde”.");
          refreshPipe();
        }).catch(function (err) { pipeStatus("Greška pri čuvanju: " + err.message); });
      };
      capRec.start(1000);
      capStart = Date.now();
      var btn = $("pipeRec");
      btn.classList.add("rec");
      capTimer = setInterval(function () {
        btn.querySelector(".tt").textContent = "■ Zaustavi (" + fmtTime((Date.now() - capStart) / 1000) + ")";
      }, 500);
      if (window.FGRBridge && window.FGRBridge.playFromStart) {
        window.FGRBridge.playFromStart();
        pipeStatus("Snima… pesma je puštena od početka. Kad se završi, klikni „Zaustavi”.");
      } else {
        pipeStatus("Snima… pusti pesmu do kraja pa klikni „Zaustavi”.");
      }
      stream.getAudioTracks()[0].onended = stopCapture;
    }).catch(function (err) { pipeStatus("Otkazano: " + err.message); });
  });

  /* offline analiza: hromagram preko OfflineAudioContext suspend/resume */
  /* samo cesti akordi — bez sus/dim egzotike koja zbunjuje u auto-prepoznavanju */
  var AN_TEMPLATES = [["", [0, 4, 7]], ["m", [0, 3, 7]], ["7", [0, 4, 7, 10]], ["m7", [0, 3, 7, 10]]];
  var AN_VECS = [];
  AN_TEMPLATES.forEach(function (tpl) {
    for (var r = 0; r < 12; r++) {
      var vec = new Array(12).fill(0);
      tpl[1].forEach(function (iv) { vec[(r + iv) % 12] = 1; });
      AN_VECS.push({ name: NOTE[r] + tpl[0], vec: vec, norm: Math.sqrt(tpl[1].length) });
    }
  });
  function chromaFromSpectrum(dbArr, sampleRate, fftSize) {
    var chroma = new Array(12).fill(0);
    for (var i = 0; i < dbArr.length; i++) {
      var freq = i * sampleRate / fftSize;
      if (freq < 60) continue;
      if (freq > 2200) break;
      var mag = Math.pow(10, dbArr[i] / 20);
      if (!isFinite(mag) || mag < 1e-7) continue;
      var midi = 69 + 12 * Math.log2(freq / 440);
      chroma[((Math.round(midi) % 12) + 12) % 12] += mag;
    }
    return chroma;
  }
  function bestChord(chroma) {
    var max = Math.max.apply(null, chroma);
    if (!(max > 1e-4)) return null;
    var norm = chroma.map(function (v) { return v / max; });
    var len = Math.sqrt(norm.reduce(function (s, v) { return s + v * v; }, 0)) || 1;
    var best = null, bestScore = -1;
    AN_VECS.forEach(function (c) {
      var dot = 0;
      for (var i = 0; i < 12; i++) dot += norm[i] * c.vec[i];
      var score = dot / (len * c.norm);
      if (score > bestScore) { bestScore = score; best = c.name; }
    });
    return bestScore > 0.68 ? best : null;
  }
  function analyzeBuffer(buffer, onProgress) {
    var HOP = 0.25, FFT = 8192;
    var ctx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
    var source = ctx.createBufferSource();
    source.buffer = buffer;
    var analyser = ctx.createAnalyser();
    analyser.fftSize = FFT;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    source.start();
    var frames = [];
    var duration = buffer.duration;
    for (var t = HOP; t < duration; t += HOP) {
      (function (at) {
        ctx.suspend(at).then(function () {
          var arr = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(arr);
          frames.push({ t: at, chord: bestChord(chromaFromSpectrum(arr, buffer.sampleRate, FFT)) });
          if (onProgress && frames.length % 40 === 0) onProgress(at / duration);
          ctx.resume();
        });
      })(t);
    }
    return ctx.startRendering().then(function () {
      frames.sort(function (a, b) { return a.t - b.t; });
      /* stabilizacija: akord vazi tek kad traje >= 3 uzastopna okvira (0.75s) */
      var out = [], run = null;
      frames.forEach(function (frame) {
        if (!frame.chord) return;
        if (run && run.chord === frame.chord) { run.count++; run.end = frame.t; return; }
        if (run && run.count >= 3 && (!out.length || out[out.length - 1].n !== run.chord)) {
          out.push({ t: Math.round((run.start - HOP) * 10) / 10, n: run.chord });
        }
        run = { chord: frame.chord, count: 1, start: frame.t, end: frame.t };
      });
      if (run && run.count >= 3 && (!out.length || out[out.length - 1].n !== run.chord)) {
        out.push({ t: Math.round((run.start - HOP) * 10) / 10, n: run.chord });
      }
      return out;
    });
  }
  window.FGRAnalyzeBuffer = analyzeBuffer;

  if ($("pipeChords")) $("pipeChords").addEventListener("click", function () {
    if (!currentSong) { pipeStatus("Prvo izaberi pesmu."); return; }
    var id = recId();
    dbGet(id).then(function (item) {
      if (!item) { pipeStatus("Nema snimka za ovu pesmu — prvo „1 Snimi jednom”."); return; }
      pipeStatus("Analiziram snimak… (može potrajati)");
      var actx = new (window.AudioContext || window.webkitAudioContext)();
      return item.blob.arrayBuffer().then(function (data) {
        return actx.decodeAudioData(data);
      }).then(function (buffer) {
        return analyzeBuffer(buffer, function (p) { pipeStatus("Analiziram… " + Math.round(p * 100) + "%"); });
      }).then(function (chords) {
        actx.close().catch(function () {});
        if (!chords.length) { pipeStatus("Nisam uspeo da prepoznam akorde iz ovog snimka."); return; }
        if (currentSong.chords && currentSong.chords.length && !confirm("Pesma već ima " + currentSong.chords.length + " akorada u chartu. Da ih zamenim sa " + chords.length + " prepoznatih?")) {
          pipeStatus(""); return;
        }
        if (window.FGRBridge && window.FGRBridge.setChordsForSelected(chords)) {
          pipeStatus("Upisano " + chords.length + " akorada u chart. Proveri ih i ispravi po sluhu.");
          if (prefs.tool === "chart") renderTool();
          refreshPipe();
        }
      });
    }).catch(function (err) { pipeStatus("Greška: " + err.message); });
  });

  if ($("pipeRead")) $("pipeRead").addEventListener("click", function () { selectTool("chart"); });

  /* ---------- nas snimak: player sa transpozicijom (pitch prati transpose) ---------- */
  var rec = { ctx: null, buffer: null, bufferId: null, source: null, playing: false, offset: 0, startedAt: 0 };

  function recRate() { return Math.pow(2, transpose / 12); }
  function recTime() {
    if (!rec.playing) return rec.offset;
    return rec.offset + (rec.ctx.currentTime - rec.startedAt) * recRate();
  }
  function recStop(keepOffset) {
    if (rec.source) {
      rec.source.onended = null;
      try { rec.source.stop(); } catch (e) {}
      rec.source = null;
    }
    if (rec.playing && keepOffset) rec.offset = Math.min(recTime(), rec.buffer ? rec.buffer.duration : 0);
    if (!keepOffset) rec.offset = 0;
    rec.playing = false;
    if ($("recPlayBtn")) $("recPlayBtn").textContent = "▶ Pusti snimak";
  }
  function recPlayFrom(offset) {
    if (!rec.buffer) return;
    recStop(false);
    rec.offset = Math.max(0, Math.min(offset, rec.buffer.duration - 0.1));
    rec.source = rec.ctx.createBufferSource();
    rec.source.buffer = rec.buffer;
    rec.source.playbackRate.value = recRate();
    rec.source.connect(rec.ctx.destination);
    rec.source.onended = function () { if (rec.playing) recStop(false); updateRecRow(); };
    rec.source.start(0, rec.offset);
    rec.startedAt = rec.ctx.currentTime;
    rec.playing = true;
    if ($("recPlayBtn")) $("recPlayBtn").textContent = "■ Pauza";
  }
  function recLoad() {
    var id = recId();
    if (!id) return Promise.resolve(false);
    if (rec.buffer && rec.bufferId === id) return Promise.resolve(true);
    return dbGet(id).then(function (item) {
      if (!item) return false;
      if (!rec.ctx) rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
      return item.blob.arrayBuffer().then(function (data) {
        return rec.ctx.decodeAudioData(data);
      }).then(function (buffer) {
        rec.buffer = buffer;
        rec.bufferId = id;
        return true;
      });
    });
  }
  function updateRecRow() {
    var row = $("recPlayerRow");
    if (!row) return;
    var id = recId();
    if (!id) { row.hidden = true; return; }
    dbGet(id).then(function (item) { row.hidden = !item; }).catch(function () { row.hidden = true; });
    if ($("recTime")) $("recTime").textContent = fmtTime(recTime()) + (rec.buffer ? " / " + fmtTime(rec.buffer.duration) : "");
    if ($("recPitch")) {
      $("recPitch").textContent = transpose === 0 ? "" :
        (transpose > 0 ? "+" + transpose : transpose) + " (" + (transpose > 0 ? "brže" : "sporije") + ")";
    }
  }
  if ($("recPlayBtn")) $("recPlayBtn").addEventListener("click", function () {
    if (rec.playing) { recStop(true); updateRecRow(); return; }
    recLoad().then(function (ok) {
      if (!ok) { pipeStatus("Nema snimka za ovu pesmu."); return; }
      if (rec.ctx.state === "suspended") rec.ctx.resume();
      recPlayFrom(rec.offset);
      updateRecRow();
    });
  });
  window.addEventListener("fgr:songchange", function () { recStop(false); rec.buffer = null; rec.bufferId = null; updateRecRow(); });
  function recRetune() {
    /* promena transpozicije dok snimak svira: nastavi sa novim pitch-em */
    if (rec.playing) { var t = recTime(); recPlayFrom(t); }
    updateRecRow();
  }
  function recSeek(t) {
    recLoad().then(function (ok) {
      if (!ok) return;
      if (rec.playing) recPlayFrom(t); else { rec.offset = t; updateRecRow(); }
    });
  }

  /* ---------- start ---------- */
  applyTheme();
  updateToneCard();
  renderMiniChart();
  refreshPipe();
  initMetronome();
  if (chipsWrap) {
    Array.prototype.forEach.call(chipsWrap.children, function (chip) {
      chip.classList.toggle("on", chip.dataset.m === prefs.tool);
    });
  }
  renderTool();
})();
