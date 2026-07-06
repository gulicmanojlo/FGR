/* FGR UI shell v2: radni sto — tema, alati, transpozicija, MIDI, metronom.
   Nezavisno od app.js; sa playerom komunicira preko window.FGRBridge. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var NOTE = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];
  var TRIAD = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6] };
  var SUFFIX = { maj: "", min: "m", dim: "°" };
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
  var prefs = { theme: "dark", tool: "akordi" };
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved && typeof saved === "object") {
      if (saved.theme === "light" || saved.theme === "dark") prefs.theme = saved.theme;
      if (typeof saved.tool === "string") prefs.tool = saved.tool;
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

  function chordMidis(rootPc, type) {
    var base = rootPc >= 8 ? 48 + rootPc : 60 + rootPc;
    return TRIAD[type].map(function (iv) { return base + iv; });
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
  function paintScale(rootPc, intervals, label) {
    var keys = document.querySelectorAll("#keyboard .key");
    keys.forEach(function (key) {
      var pc = ((Number(key.dataset.midi) % 12) + 12) % 12;
      var rel = (pc - rootPc + 12) % 12;
      key.classList.toggle("root-hint", rel === 0);
      key.classList.toggle("scale-hint", rel !== 0 && intervals.indexOf(rel) !== -1);
    });
    if ($("dockScaleName")) $("dockScaleName").textContent = label || "";
  }
  function clearScale() {
    document.querySelectorAll("#keyboard .key.root-hint, #keyboard .key.scale-hint").forEach(function (key) {
      key.classList.remove("root-hint", "scale-hint");
    });
    if ($("dockScaleName")) $("dockScaleName").textContent = "";
  }

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
    if (prefs.tool === "akordi" || prefs.tool === "chart") renderTool();
    renderMiniChart();
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
    if (prefs.tool === "akordi" || prefs.tool === "chart" || prefs.tool === "vezba") renderTool();
  });

  /* ---------- "Svira se" ogledalo ---------- */
  var activeChord = $("activeChordDisplay");
  var stage = $("stageChordName");
  function syncStage() {
    if (!activeChord || !stage) return;
    var text = (activeChord.value || activeChord.textContent || "").trim();
    var idle = !text || text === "-";
    stage.textContent = idle ? "—" : text;
    stage.classList.toggle("idle", idle);
  }
  if (activeChord && stage && typeof MutationObserver !== "undefined") {
    new MutationObserver(syncStage).observe(activeChord, { childList: true, characterData: true, subtree: true });
    syncStage();
  }

  /* ---------- MIDI ---------- */
  var midiHeld = new Set();
  var midiOnChord = null; /* callback za vezbu */
  function midiPcSet() {
    var set = new Set();
    midiHeld.forEach(function (m) { set.add(((m % 12) + 12) % 12); });
    return set;
  }
  function onMidiMessage(event) {
    var st = event.data[0], d1 = event.data[1], d2 = event.data[2];
    var cmd = st & 0xF0;
    var changed = false;
    if (cmd === 0x90 && d2 > 0) { midiHeld.add(d1); changed = true; }
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) { midiHeld.delete(d1); changed = true; }
    if (!changed) return;
    var key = document.querySelector('.key[data-midi="' + d1 + '"]');
    if (key) key.classList.toggle("midi-held", midiHeld.has(d1));
    if (midiOnChord) midiOnChord(midiPcSet());
  }
  function bindMidi(access) {
    var first = null, count = 0;
    access.inputs.forEach(function (input) {
      input.onmidimessage = onMidiMessage;
      if (!first) first = input;
      count++;
    });
    var led = $("midiLed"), name = $("midiName");
    if (count && first) {
      if (led) led.classList.remove("off");
      if (name) name.textContent = first.name || "MIDI";
    } else {
      if (led) led.classList.add("off");
      if (name) name.textContent = "MIDI";
    }
  }
  function connectMidi(silent) {
    if (!navigator.requestMIDIAccess) {
      if (!silent) alert("Ovaj browser nema Web MIDI (koristi Chrome/Edge). Na iPad-u ne radi.");
      return;
    }
    navigator.requestMIDIAccess().then(function (access) {
      bindMidi(access);
      access.onstatechange = function () { bindMidi(access); };
    }).catch(function () {
      if (!silent) alert("Pristup MIDI uredjajima je odbijen.");
    });
  }
  if ($("midiBadge")) $("midiBadge").addEventListener("click", function () { connectMidi(false); });

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
            paintScale(pc, TRIAD[d[1]], name + " (akord)");
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
        var base = pc >= 8 ? 48 + pc : 60 + pc;
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
          cell.addEventListener("click", function () { if (window.FGRBridge) window.FGRBridge.seekTo(chord.t); });
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
    },

    metronom: function () {
      toolBody.innerHTML = '<div class="metro">' +
        '<div class="metro-bpm"><button id="mtDown" type="button">−</button>' +
        '<div class="metro-num"><span class="mv" id="mtVal">96</span><span class="metro-lab">BPM</span></div>' +
        '<button id="mtUp" type="button">+</button></div>' +
        '<div class="metro-beats" id="mtBeats"></div>' +
        '<div class="scale-head" style="margin:0"><label>Takt <select id="mtSig">' +
        '<option>2/4</option><option selected>4/4</option><option>3/4</option><option>6/8</option><option>7/8</option><option>9/8</option></select></label>' +
        '<button class="text-button mini" id="mtTap" type="button">Tap tempo</button>' +
        '<button class="text-button mini primary-button" id="mtPlay" type="button" style="margin-left:auto">▶ Start</button></div>' +
        '<p class="tool-note">Naglasen prvi tak. <b>Tap tempo</b>: klikni par puta u ritmu pesme.</p></div>';
      var beatsBySig = { "2/4": 2, "3/4": 3, "4/4": 4, "6/8": 6, "7/8": 7, "9/8": 9 };
      var bpm = 96, sig = "4/4", beatIndex = -1, timer = null, audio = null, taps = [];
      function drawBeats() {
        var n = beatsBySig[sig], wrap = $("mtBeats");
        wrap.innerHTML = "";
        for (var i = 0; i < n; i++) {
          var dot = document.createElement("span");
          dot.className = "beat" + (i === 0 ? " strong" : "") + (i === beatIndex ? " hit" : "");
          wrap.appendChild(dot);
        }
      }
      function click(accent) {
        if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
        var osc = audio.createOscillator(), gain = audio.createGain();
        osc.frequency.value = accent ? 1250 : 780;
        gain.gain.setValueAtTime(accent ? 0.5 : 0.3, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.07);
        osc.connect(gain); gain.connect(audio.destination);
        osc.start(); osc.stop(audio.currentTime + 0.08);
      }
      function stop() {
        if (timer) { window.clearInterval(timer); timer = null; }
        beatIndex = -1; drawBeats();
        $("mtPlay").textContent = "▶ Start";
      }
      $("mtUp").addEventListener("click", function () { bpm = Math.min(240, bpm + 1); $("mtVal").textContent = bpm; if (timer) restart(); });
      $("mtDown").addEventListener("click", function () { bpm = Math.max(30, bpm - 1); $("mtVal").textContent = bpm; if (timer) restart(); });
      $("mtSig").addEventListener("change", function (e) { sig = e.target.value; beatIndex = -1; drawBeats(); if (timer) restart(); });
      $("mtTap").addEventListener("click", function () {
        var now = performance.now();
        taps.push(now);
        taps = taps.filter(function (t) { return now - t < 3200; });
        if (taps.length > 1) {
          var avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
          bpm = Math.max(30, Math.min(240, Math.round(60000 / avg)));
          $("mtVal").textContent = bpm;
          if (timer) restart();
        }
      });
      function start() {
        $("mtPlay").textContent = "■ Stop";
        beatIndex = -1;
        timer = window.setInterval(function () {
          beatIndex = (beatIndex + 1) % beatsBySig[sig];
          click(beatIndex === 0);
          drawBeats();
        }, 60000 / bpm);
      }
      function restart() { window.clearInterval(timer); start(); }
      $("mtPlay").addEventListener("click", function () { if (timer) stop(); else start(); });
      drawBeats();
    }
  };

  function renderTool() {
    if (!toolBody) return;
    if (prefs.tool !== "vezba") midiOnChord = null;
    if (TOOLS[prefs.tool]) TOOLS[prefs.tool]();
    else { prefs.tool = "akordi"; TOOLS.akordi(); }
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
      item.addEventListener("click", function () { if (window.FGRBridge) window.FGRBridge.seekTo(chord.t); });
      wrap.appendChild(item);
    });
  }

  window.setInterval(function () {
    if (!window.FGRBridge || !currentSong) return;
    var t = window.FGRBridge.getTime();
    if (!t) return;
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
    });
  }, 600);

  /* ---------- start ---------- */
  applyTheme();
  updateToneCard();
  renderMiniChart();
  if (chipsWrap) {
    Array.prototype.forEach.call(chipsWrap.children, function (chip) {
      chip.classList.toggle("on", chip.dataset.m === prefs.tool);
    });
  }
  renderTool();
})();
