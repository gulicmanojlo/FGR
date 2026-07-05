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

  applyTheme();
  selectTab(prefs.tab);
  applyPianoDock();
})();
