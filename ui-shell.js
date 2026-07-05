/* FGR UI shell: tabs, theme, settings. Independent of app.js. */
(function () {
  "use strict";

  var STORAGE_KEY = "fgr-ui-v1";
  var prefs = { theme: "dark", tab: "sviranje", pianoCollapsed: false };
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved && typeof saved === "object") {
      if (saved.theme === "light" || saved.theme === "dark") prefs.theme = saved.theme;
      if (typeof saved.tab === "string") prefs.tab = saved.tab;
      if (typeof saved.pianoCollapsed === "boolean") prefs.pianoCollapsed = saved.pianoCollapsed;
    }
  } catch (e) {}

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  var root = document.documentElement;
  var themeToggle = document.getElementById("themeToggle");
  var themeToggleIcon = document.getElementById("themeToggleIcon");
  var settingsToggle = document.getElementById("settingsToggle");
  var settingsPanel = document.getElementById("settingsPanel");
  var themeRadios = Array.prototype.slice.call(document.querySelectorAll("input[name='uiTheme']"));
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll(".app-tabs [data-tab]"));
  var panels = Array.prototype.slice.call(document.querySelectorAll(".tab-panel[data-panel]"));

  var SUN_PATH = '<circle cx="12" cy="12" r="4"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4"/>';
  var MOON_PATH = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';

  function applyTheme() {
    root.setAttribute("data-theme", prefs.theme);
    if (themeToggleIcon) {
      themeToggleIcon.innerHTML = prefs.theme === "dark" ? SUN_PATH : MOON_PATH;
    }
    themeRadios.forEach(function (radio) {
      radio.checked = radio.value === prefs.theme;
    });
    var meta = document.querySelector("meta[name='theme-color']");
    if (meta) meta.setAttribute("content", prefs.theme === "dark" ? "#141009" : "#efe9dd");
  }

  function selectTab(name) {
    var known = tabButtons.some(function (button) { return button.dataset.tab === name; });
    if (!known) name = "sviranje";
    tabButtons.forEach(function (button) {
      button.setAttribute("aria-selected", button.dataset.tab === name ? "true" : "false");
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== name;
    });
    prefs.tab = name;
    save();
    window.dispatchEvent(new Event("resize"));
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      prefs.theme = prefs.theme === "dark" ? "light" : "dark";
      save();
      applyTheme();
    });
  }

  themeRadios.forEach(function (radio) {
    radio.addEventListener("change", function () {
      if (!radio.checked) return;
      prefs.theme = radio.value === "light" ? "light" : "dark";
      save();
      applyTheme();
    });
  });

  if (settingsToggle && settingsPanel) {
    settingsToggle.addEventListener("click", function () {
      var show = settingsPanel.hidden;
      settingsPanel.hidden = !show;
      settingsToggle.setAttribute("aria-expanded", show ? "true" : "false");
    });
  }

  tabButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      selectTab(button.dataset.tab);
    });
  });

  var pianoDock = document.getElementById("pianoDock");
  var pianoDockToggle = document.getElementById("pianoDockToggle");

  function applyPianoDock() {
    if (!pianoDock) return;
    pianoDock.classList.toggle("collapsed", prefs.pianoCollapsed);
    if (pianoDockToggle) {
      pianoDockToggle.setAttribute("aria-expanded", prefs.pianoCollapsed ? "false" : "true");
    }
    window.dispatchEvent(new Event("resize"));
  }

  if (pianoDockToggle) {
    pianoDockToggle.addEventListener("click", function () {
      prefs.pianoCollapsed = !prefs.pianoCollapsed;
      save();
      applyPianoDock();
    });
  }

  /* ---- Stage: mirror the active chord into the big display ---- */
  var activeChord = document.getElementById("activeChordDisplay");
  var stageChordName = document.getElementById("stageChordName");

  function syncStageChord() {
    if (!activeChord || !stageChordName) return;
    var text = (activeChord.textContent || "").trim();
    var idle = !text || text === "-";
    stageChordName.textContent = idle ? "—" : text;
    stageChordName.classList.toggle("idle", idle);
  }

  if (activeChord && stageChordName && typeof MutationObserver !== "undefined") {
    new MutationObserver(syncStageChord).observe(activeChord, {
      childList: true,
      characterData: true,
      subtree: true
    });
    syncStageChord();
  }

  /* ---- Ucenje: akordi tonaliteta (B1) ---- */
  var NOTE_NAMES = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];
  var MAJOR_DEGREES = [
    { deg: "I", offset: 0, type: "maj" },
    { deg: "ii", offset: 2, type: "min" },
    { deg: "iii", offset: 4, type: "min" },
    { deg: "IV", offset: 5, type: "maj" },
    { deg: "V", offset: 7, type: "maj" },
    { deg: "vi", offset: 9, type: "min" },
    { deg: "vii°", offset: 11, type: "dim" }
  ];
  var MINOR_DEGREES = [
    { deg: "i", offset: 0, type: "min" },
    { deg: "ii°", offset: 2, type: "dim" },
    { deg: "III", offset: 3, type: "maj" },
    { deg: "iv", offset: 5, type: "min" },
    { deg: "v", offset: 7, type: "min" },
    { deg: "VI", offset: 8, type: "maj" },
    { deg: "VII", offset: 10, type: "maj" },
    { deg: "V dur", offset: 7, type: "maj", alt: true, note: "harmonski" }
  ];
  var TRIAD = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6] };
  var SUFFIX = { maj: "", min: "m", dim: "°" };

  var learnRoot = document.getElementById("learnRoot");
  var learnChords = document.getElementById("learnChords");
  var learnQualityInputs = Array.prototype.slice.call(document.querySelectorAll("input[name='learnQuality']"));

  function chordMidis(rootPc, type) {
    var base = rootPc >= 8 ? 48 + rootPc : 60 + rootPc;
    return TRIAD[type].map(function (iv) { return base + iv; });
  }

  function playOnPiano(midis, card) {
    var keys = midis
      .map(function (m) { return document.querySelector('.key[data-midi="' + m + '"]'); })
      .filter(Boolean);
    if (!keys.length) return;
    if (card) card.classList.add("playing");
    keys.forEach(function (key) {
      key.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerId: 900 + key.dataset.midi * 1 }));
    });
    setTimeout(function () {
      keys.forEach(function (key) {
        key.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerId: 900 + key.dataset.midi * 1 }));
      });
      if (card) card.classList.remove("playing");
    }, 700);
  }

  function renderLearnChords() {
    if (!learnRoot || !learnChords) return;
    var rootPc = Number(learnRoot.value) || 0;
    var quality = "minor";
    learnQualityInputs.forEach(function (input) { if (input.checked) quality = input.value; });
    var degrees = quality === "major" ? MAJOR_DEGREES : MINOR_DEGREES;

    learnChords.innerHTML = "";
    degrees.forEach(function (d) {
      var pc = (rootPc + d.offset) % 12;
      var name = NOTE_NAMES[pc] + SUFFIX[d.type];
      var midis = chordMidis(pc, d.type);
      var notes = TRIAD[d.type].map(function (iv) { return NOTE_NAMES[(pc + iv) % 12]; }).join(" ");
      var card = document.createElement("button");
      card.type = "button";
      card.className = "deg-card" + (d.alt ? " alt" : "");
      card.innerHTML =
        '<span class="deg">' + d.deg + (d.note ? " · " + d.note : "") + "</span>" +
        '<span class="deg-name">' + name + "</span>" +
        '<span class="deg-notes">' + notes + "</span>";
      card.addEventListener("click", function () { playOnPiano(midis, card); });
      learnChords.appendChild(card);
    });
  }

  if (learnRoot) {
    NOTE_NAMES.forEach(function (name, pc) {
      var option = document.createElement("option");
      option.value = String(pc);
      option.textContent = name;
      if (pc === 9) option.selected = true; /* A-mol kao pocetni */
      learnRoot.appendChild(option);
    });
    learnRoot.addEventListener("change", renderLearnChords);
    learnQualityInputs.forEach(function (input) {
      input.addEventListener("change", renderLearnChords);
    });
    renderLearnChords();
  }

  applyTheme();
  selectTab(prefs.tab);
  applyPianoDock();
})();
