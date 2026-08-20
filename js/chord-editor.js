const NOTE_NAMES = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];
const ROOT_ALIASES = new Map([
  ["C", 0], ["C#", 1], ["DB", 1], ["CIS", 1],
  ["D", 2], ["D#", 3], ["EB", 3], ["DIS", 3],
  ["E", 4], ["F", 5], ["F#", 6], ["GB", 6], ["FIS", 6],
  ["G", 7], ["G#", 8], ["AB", 8], ["GIS", 8],
  ["A", 9], ["A#", 10], ["BB", 10], ["AIS", 10], ["B", 10],
  ["H", 11]
]);
const QUALITY_INTERVALS = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  7: [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  m7b5: [0, 3, 6, 10],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  add9: [0, 4, 7, 14],
  9: [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  aug: [0, 4, 8],
  "+": [0, 4, 8]
};
const COMMON_QUALITIES = ["", "m", "7", "m7", "maj7", "sus2", "sus4", "dim", "m7b5", "6", "m6", "9"];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rootMatch(value) {
  const text = String(value || "").trim();
  return /^(Cis|Dis|Fis|Gis|Ais|C#|D#|F#|G#|A#|Db|Eb|Gb|Ab|Bb|C|D|E|F|G|A|B|H)(.*)$/i.exec(text);
}

function rootPc(value) {
  const match = rootMatch(value);
  if (!match) return null;
  return ROOT_ALIASES.get(match[1].toUpperCase()) ?? null;
}

export function normalizeChordSymbol(value) {
  const compact = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/♯/g, "#")
    .replace(/♭/g, "b")
    .replace(/min(or)?/gi, "m")
    .replace(/major/gi, "maj")
    .replace(/Δ/g, "maj")
    .replace(/ø/g, "m7b5")
    .replace(/°/g, "dim");
  const match = rootMatch(compact);
  if (!match) return "";
  const pc = rootPc(match[1]);
  if (pc === null) return "";
  const suffixAndBass = match[2] || "";
  const slashIndex = suffixAndBass.indexOf("/");
  const rawSuffix = slashIndex >= 0 ? suffixAndBass.slice(0, slashIndex) : suffixAndBass;
  let suffix = rawSuffix;
  if (suffix === "M7") suffix = "maj7";
  else if (suffix === "M9") suffix = "maj9";
  else if (/^mM7$/.test(suffix)) suffix = "mMaj7";
  else if (/^sus$/i.test(suffix)) suffix = "sus4";
  else suffix = suffix.replace(/^MAJ/i, "maj").replace(/^M(?=\d|$)/, "m").replace(/^DIM/i, "dim").replace(/^AUG/i, "aug");
  if (!/^(?:|m|7|m7|maj7|mMaj7|m7b5|dim|dim7|sus2|sus4|6|m6|add9|9|m9|maj9|aug|\+)$/.test(suffix)) return "";

  let slash = "";
  if (slashIndex >= 0) {
    const bassText = suffixAndBass.slice(slashIndex + 1);
    const bassPc = rootPc(bassText);
    if (bassPc === null || !rootMatch(bassText) || rootMatch(bassText)[2]) return "";
    slash = `/${NOTE_NAMES[bassPc]}`;
  }
  return `${NOTE_NAMES[pc]}${suffix}${slash}`;
}

export function parseChordSymbol(value) {
  const name = normalizeChordSymbol(value);
  if (!name) return null;
  const match = rootMatch(name);
  const pc = rootPc(match[1]);
  const suffix = (match[2] || "").split("/")[0];
  let intervals = QUALITY_INTERVALS[suffix];
  if (suffix === "mMaj7") intervals = [0, 3, 7, 11];
  if (!intervals) return null;
  const slashName = name.includes("/") ? name.split("/")[1] : "";
  return { name, pc, suffix, intervals: intervals.slice(), bassPc: slashName ? rootPc(slashName) : null };
}

export function chordPreviewMidis(value, baseOctaveMidi = 48) {
  const parsed = parseChordSymbol(value);
  if (!parsed) return [];
  const root = Math.round(Number(baseOctaveMidi) || 48) + parsed.pc;
  const midis = parsed.intervals.map((interval) => root + interval);
  if (parsed.bassPc !== null) {
    let bass = Math.round(Number(baseOctaveMidi) || 48) - 12 + parsed.bassPc;
    while (bass >= root) bass -= 12;
    midis.unshift(bass);
  }
  return [...new Set(midis)].sort((a, b) => a - b);
}

function parseKey(value) {
  const compact = String(value || "").trim().replace(/[\s_-]+/g, "");
  const match = rootMatch(compact);
  if (!match) return { pc: 9, minor: true };
  const pc = rootPc(match[1]);
  const tail = String(match[2] || "").toLowerCase();
  return { pc, minor: tail === "m" || tail.includes("mol") || tail.includes("minor") };
}

export function diatonicChordNames(keyValue) {
  const key = parseKey(keyValue);
  const degrees = key.minor
    ? [[0, "m"], [2, "dim"], [3, ""], [5, "m"], [7, "m"], [8, ""], [10, ""], [7, "7"]]
    : [[0, ""], [2, "m"], [4, "m"], [5, ""], [7, ""], [9, "m"], [11, "dim"], [7, "7"]];
  return degrees.map(([offset, suffix]) => `${NOTE_NAMES[(key.pc + offset) % 12]}${suffix}`);
}

function queryMatches(name, query) {
  if (!query) return true;
  const foldedName = String(name).toLowerCase().replace(/is/g, "#");
  const foldedQuery = String(query).toLowerCase().replace(/is/g, "#");
  return foldedName.includes(foldedQuery);
}

/** Rank a deliberately small, useful chord vocabulary for the picker. */
export function rankChordSuggestions(options = {}) {
  const chords = Array.isArray(options.chords) ? options.chords : [];
  const index = Number.isInteger(options.index) ? options.index : -1;
  const currentName = normalizeChordSymbol(options.currentName);
  const diatonic = diatonicChordNames(options.key);
  const near = [chords[index - 1]?.n, currentName, chords[index + 1]?.n]
    .map(normalizeChordSymbol)
    .filter(Boolean);
  const frequency = new Map();
  chords.forEach((chord) => {
    const name = normalizeChordSymbol(chord?.n);
    if (name) frequency.set(name, (frequency.get(name) || 0) + 1);
  });

  const candidates = new Set([...near, ...diatonic, ...frequency.keys()]);
  diatonic.forEach((name) => {
    const parsed = parseChordSymbol(name);
    if (!parsed) return;
    ["7", "m7", "maj7", "sus4"].forEach((suffix) => candidates.add(`${NOTE_NAMES[parsed.pc]}${suffix}`));
  });
  NOTE_NAMES.forEach((root) => COMMON_QUALITIES.forEach((suffix) => candidates.add(`${root}${suffix}`)));

  const query = String(options.query || "").trim();
  return [...candidates]
    .filter((name) => queryMatches(name, query))
    .map((name) => {
      let score = 0;
      let group = "Varijante";
      if (near.includes(name)) { score += 180 - near.indexOf(name) * 4; group = "Akordi pored"; }
      if (diatonic.includes(name)) { score += 120 - diatonic.indexOf(name); if (group === "Varijante") group = "U tonalitetu"; }
      if (frequency.has(name)) { score += Math.min(45, frequency.get(name) * 5); if (group === "Varijante") group = "Česti u pesmi"; }
      if (currentName === name) score += 40;
      if (query && name.toLowerCase().startsWith(query.toLowerCase())) score += 70;
      score -= name.length * 0.02;
      return { name, group, score };
    })
    .sort((first, second) => second.score - first.score || first.name.localeCompare(second.name))
    .slice(0, Math.max(1, Number(options.limit) || 24));
}

export function upsertChordAtTime(chords, name, time, toleranceSeconds = 0.05) {
  const chordName = String(name || "").trim();
  const timestamp = Math.max(0, Math.round((Number(time) || 0) * 1000) / 1000);
  const tolerance = Math.max(0, Number(toleranceSeconds) || 0);
  const list = Array.isArray(chords) ? chords.map((chord) => ({ ...chord })) : [];
  let existingIndex = -1;
  let existingDistance = Infinity;
  list.forEach((chord, index) => {
    const distance = Math.abs((Number(chord?.t) || 0) - timestamp);
    if (distance <= tolerance && distance < existingDistance) {
      existingIndex = index;
      existingDistance = distance;
    }
  });

  const replaced = existingIndex >= 0;
  const target = replaced
    ? { ...list[existingIndex], n: chordName }
    : { t: timestamp, n: chordName };
  if (replaced) list[existingIndex] = target;
  else list.push(target);
  list.sort((first, second) => (Number(first?.t) || 0) - (Number(second?.t) || 0));
  return {
    chords: list,
    replaced,
    index: list.indexOf(target),
    time: Math.max(0, Number(target.t) || 0)
  };
}

export function resolveChordEndTime(chords, duration, storedEndTime) {
  const list = Array.isArray(chords) ? chords : [];
  const lastStart = list.length ? Math.max(0, Number(list[list.length - 1]?.t) || 0) : 0;
  const songDuration = Math.max(lastStart, Number(duration) || 0);
  if (storedEndTime === null || storedEndTime === undefined || storedEndTime === "") return songDuration;
  const stored = Number(storedEndTime);
  if (!Number.isFinite(stored) || stored <= lastStart) return songDuration;
  return clamp(stored, lastStart, songDuration);
}

/**
 * Edit one contiguous chord segment without allowing overlaps.
 *
 * `move` translates both of the segment's boundaries and therefore preserves
 * its duration. `left` and `right` move just the selected edge. The terminal
 * boundary is explicit because the final chord has no following chord whose
 * start can otherwise represent its end.
 */
export function editChordSegment(chords, index, mode, deltaSeconds, options = {}) {
  const list = Array.isArray(chords)
    ? chords.map((chord) => ({ ...chord, t: Math.max(0, Number(chord?.t) || 0) }))
    : [];
  const selectedIndex = Number(index);
  const editMode = ["move", "left", "right"].includes(mode) ? mode : "move";
  const minimumGap = Math.max(0.001, Number(options.minimumGap) || 0.05);
  const requestedDelta = Number(deltaSeconds);
  const delta = Number.isFinite(requestedDelta) ? requestedDelta : 0;
  const roundTime = (value) => Math.round(Math.max(0, value) * 1000) / 1000;

  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= list.length) {
    return {
      chords: list,
      chordEndTime: resolveChordEndTime(list, options.duration, options.chordEndTime),
      appliedDelta: 0,
      changed: false
    };
  }

  const songDuration = Math.max(
    Number(options.duration) || 0,
    (Number(list[list.length - 1]?.t) || 0) + minimumGap
  );
  let chordEndTime = resolveChordEndTime(list, songDuration, options.chordEndTime);
  chordEndTime = Math.max(chordEndTime, (Number(list[list.length - 1]?.t) || 0) + minimumGap);
  chordEndTime = Math.min(songDuration, chordEndTime);

  const start = Number(list[selectedIndex].t) || 0;
  const end = selectedIndex + 1 < list.length
    ? Number(list[selectedIndex + 1].t) || start
    : chordEndTime;
  let appliedDelta = 0;

  if (editMode === "left") {
    const minimum = selectedIndex > 0
      ? (Number(list[selectedIndex - 1].t) || 0) + minimumGap
      : 0;
    const maximum = Math.max(minimum, end - minimumGap);
    const nextStart = clamp(start + delta, minimum, maximum);
    appliedDelta = nextStart - start;
    list[selectedIndex].t = roundTime(nextStart);
  } else if (editMode === "right") {
    const minimum = start + minimumGap;
    if (selectedIndex + 1 < list.length) {
      const followingEnd = selectedIndex + 2 < list.length
        ? Number(list[selectedIndex + 2].t) || end
        : chordEndTime;
      const maximum = Math.max(minimum, followingEnd - minimumGap);
      const nextEnd = clamp(end + delta, minimum, maximum);
      appliedDelta = nextEnd - end;
      list[selectedIndex + 1].t = roundTime(nextEnd);
    } else {
      const nextEnd = clamp(end + delta, minimum, songDuration);
      appliedDelta = nextEnd - end;
      chordEndTime = roundTime(nextEnd);
    }
  } else {
    const previousEnd = selectedIndex > 0 ? Number(list[selectedIndex - 1].t) || 0 : null;
    const followingEnd = selectedIndex + 1 < list.length
      ? (selectedIndex + 2 < list.length
          ? Number(list[selectedIndex + 2].t) || end
          : chordEndTime)
      : songDuration;
    const minimumDelta = (previousEnd === null ? 0 : previousEnd + minimumGap) - start;
    const maximumDelta = selectedIndex + 1 < list.length
      ? followingEnd - minimumGap - end
      : songDuration - end;
    appliedDelta = clamp(delta, minimumDelta, Math.max(minimumDelta, maximumDelta));
    list[selectedIndex].t = roundTime(start + appliedDelta);
    if (selectedIndex + 1 < list.length) {
      list[selectedIndex + 1].t = roundTime(end + appliedDelta);
    } else {
      chordEndTime = roundTime(end + appliedDelta);
    }
  }

  appliedDelta = Math.round(appliedDelta * 1000) / 1000;
  return {
    chords: list,
    chordEndTime: roundTime(chordEndTime),
    appliedDelta,
    changed: Math.abs(appliedDelta) >= 0.0005
  };
}

/**
 * Split one contiguous chord segment into two at `time`.
 *
 * The first part keeps the original name. The second part takes
 * `options.name` when provided (insert-at-playhead), otherwise it repeats the
 * original name. The split point is clamped inside the segment so neither
 * part becomes shorter than `minimumGap`; a segment too short to hold two
 * parts is returned unchanged.
 */
export function splitChordSegment(chords, index, time, options = {}) {
  const list = Array.isArray(chords)
    ? chords.map((chord) => ({ ...chord, t: Math.max(0, Number(chord?.t) || 0) }))
    : [];
  const selectedIndex = Number(index);
  const minimumGap = Math.max(0.001, Number(options.minimumGap) || 0.05);
  const roundTime = (value) => Math.round(Math.max(0, value) * 1000) / 1000;

  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= list.length) {
    return { chords: list, changed: false, newIndex: -1, time: 0 };
  }

  const start = Number(list[selectedIndex].t) || 0;
  const end = selectedIndex + 1 < list.length
    ? Math.max(start, Number(list[selectedIndex + 1].t) || start)
    : resolveChordEndTime(list, options.duration, options.chordEndTime);
  if (end - start < minimumGap * 2) {
    return { chords: list, changed: false, newIndex: -1, time: 0 };
  }

  const splitTime = roundTime(clamp(Number(time) || 0, start + minimumGap, end - minimumGap));
  const name = String(options.name || "").trim() || String(list[selectedIndex].n || "").trim();
  list.splice(selectedIndex + 1, 0, { t: splitTime, n: name });
  return { chords: list, changed: true, newIndex: selectedIndex + 1, time: splitTime };
}

export function chordSegmentGeometry(chords, index, duration, pixelsPerSecond = 23, lastEndTime = duration) {
  const list = Array.isArray(chords) ? chords : [];
  const start = Math.max(0, Number(list[index]?.t) || 0);
  const timelineDuration = Math.max(start, Number(duration) || 0);
  const hasNext = index + 1 < list.length;
  const terminalEnd = resolveChordEndTime(list, timelineDuration, lastEndTime);
  const end = hasNext ? Math.max(start, Number(list[index + 1]?.t) || start) : terminalEnd;
  const pps = Math.max(0.001, Number(pixelsPerSecond) || 23);
  return {
    start,
    end,
    duration: Math.max(0, end - start),
    left: start * pps,
    width: Math.max(1, (end - start) * pps),
    canResizeLeft: true,
    canResizeRight: Boolean(list[index]),
    rightBoundaryIndex: hasNext ? index + 1 : null,
    usesTerminalEnd: !hasNext
  };
}

let activeMenu = null;
let activePicker = null;

function closeMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
}

function positionFloating(element, x, y) {
  const padding = 10;
  const width = element.offsetWidth || 190;
  const height = element.offsetHeight || 120;
  element.style.left = `${clamp(Number(x) || 0, padding, Math.max(padding, window.innerWidth - width - padding))}px`;
  element.style.top = `${clamp(Number(y) || 0, padding, Math.max(padding, window.innerHeight - height - padding))}px`;
}

function buildMenuItem(label, action, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chord-context-item${danger ? " is-danger" : ""}`;
  button.textContent = label;
  button.addEventListener("click", () => {
    closeMenu();
    action();
  });
  return button;
}

export function showChordContextMenu(options = {}) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "chord-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Akord ${options.name || ""}`);
  menu.append(buildMenuItem("Izmeni akord", () => options.onEdit?.()));
  if (typeof options.onSplit === "function") {
    menu.append(buildMenuItem(options.splitLabel || "Podeli akord ovde", options.onSplit));
  }
  if (typeof options.onAddAtPlayhead === "function") {
    menu.append(buildMenuItem(options.addAtPlayheadLabel || "Dodaj akord od plejheda", options.onAddAtPlayhead));
  }
  menu.append(buildMenuItem("Obriši akord", () => options.onDelete?.(), true));
  document.body.appendChild(menu);
  activeMenu = menu;
  positionFloating(menu, options.x, options.y);
  const dismiss = (event) => {
    if (activeMenu !== menu) {
      document.removeEventListener("pointerdown", dismiss, true);
      return;
    }
    if (menu.contains(event.target)) return;
    closeMenu();
    document.removeEventListener("pointerdown", dismiss, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
  menu.querySelector("button")?.focus({ preventScroll: true });
}

export function showTimelineContextMenu(options = {}) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "chord-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Timeline");
  menu.append(buildMenuItem(`Dodaj akord na ${options.timeLabel || "poziciji"}`, () => options.onAdd?.()));
  document.body.appendChild(menu);
  activeMenu = menu;
  positionFloating(menu, options.x, options.y);
  const dismiss = (event) => {
    if (activeMenu !== menu) {
      document.removeEventListener("pointerdown", dismiss, true);
      return;
    }
    if (menu.contains(event.target)) return;
    closeMenu();
    document.removeEventListener("pointerdown", dismiss, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
  menu.querySelector("button")?.focus({ preventScroll: true });
}

export function closeChordPicker() {
  if (!activePicker) return;
  const { shell, returnFocus } = activePicker;
  activePicker = null;
  shell.remove();
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function pickerGroup(container, label, suggestions, select) {
  if (!suggestions.length) return;
  const section = document.createElement("section");
  section.className = "chord-picker-group";
  const title = document.createElement("h3");
  title.textContent = label;
  const chips = document.createElement("div");
  chips.className = "chord-picker-chips";
  suggestions.forEach((suggestion) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chord-picker-chip";
    button.textContent = suggestion.name;
    button.addEventListener("click", () => select(suggestion.name));
    chips.appendChild(button);
  });
  section.append(title, chips);
  container.appendChild(section);
}

export function openChordPicker(options = {}) {
  closeMenu();
  closeChordPicker();
  const returnFocus = options.returnFocus || document.activeElement;
  const shell = document.createElement("div");
  shell.className = "chord-picker-shell";
  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "chord-picker-backdrop";
  backdrop.setAttribute("aria-label", "Odustani");
  const panel = document.createElement("section");
  panel.className = "chord-picker-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "chordPickerTitle");

  const header = document.createElement("header");
  const heading = document.createElement("div");
  const title = document.createElement("h2");
  title.id = "chordPickerTitle";
  title.textContent = options.mode === "edit" ? "Izmeni akord" : "Dodaj akord";
  const subtitle = document.createElement("p");
  subtitle.textContent = `${options.timeLabel || ""}${options.key ? ` · tonalitet ${options.key}` : ""}`;
  heading.append(title, subtitle);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mini-button";
  close.setAttribute("aria-label", "Zatvori");
  close.textContent = "×";
  header.append(heading, close);

  const form = document.createElement("form");
  form.className = "chord-picker-form";
  const inputRow = document.createElement("div");
  inputRow.className = "chord-picker-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 24;
  input.placeholder = "Upiši akord, npr. Am ili D7";
  input.setAttribute("aria-label", "Naziv akorda");
  input.value = normalizeChordSymbol(options.currentName) || "";
  const audition = document.createElement("button");
  audition.type = "button";
  audition.className = "chord-picker-audition";
  audition.textContent = "▶ Čuj";
  inputRow.append(input, audition);
  const suggestionBox = document.createElement("div");
  suggestionBox.className = "chord-picker-suggestions";
  const hint = document.createElement("p");
  hint.className = "chord-picker-hint";
  hint.textContent = "Klik na predlog odmah svira akord na klaviru. Možeš i direktno da upišeš naziv.";
  const actions = document.createElement("footer");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "text-button";
  cancel.textContent = "Odustani";
  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.className = "primary-button";
  confirm.textContent = options.mode === "edit" ? "Sačuvaj izmenu" : "Dodaj akord";
  actions.append(cancel, confirm);
  form.append(inputRow, suggestionBox, hint, actions);
  panel.append(header, form);
  shell.append(backdrop, panel);
  document.body.appendChild(shell);
  activePicker = { shell, returnFocus };

  let userFiltering = false;
  const preview = (value) => {
    const normalized = normalizeChordSymbol(value);
    if (!normalized) {
      input.setCustomValidity("Unesi ispravan akord, npr. Am, D7 ili Fis-mol kao Fism.");
      input.reportValidity();
      return false;
    }
    input.setCustomValidity("");
    input.value = normalized;
    options.onPreview?.(normalized);
    return true;
  };
  const renderSuggestions = () => {
    suggestionBox.replaceChildren();
    const ranked = rankChordSuggestions({
      key: options.key,
      chords: options.chords,
      index: options.index,
      currentName: options.currentName,
      query: userFiltering ? input.value : "",
      limit: userFiltering ? 18 : 24
    });
    if (userFiltering) {
      pickerGroup(suggestionBox, "Rezultati", ranked, preview);
      return;
    }
    const shown = new Set();
    ["Akordi pored", "U tonalitetu", "Česti u pesmi", "Varijante"].forEach((group) => {
      const items = ranked.filter((item) => item.group === group && !shown.has(item.name)).slice(0, group === "Varijante" ? 6 : 8);
      items.forEach((item) => shown.add(item.name));
      pickerGroup(suggestionBox, group, items, preview);
    });
  };

  input.addEventListener("input", () => {
    input.setCustomValidity("");
    userFiltering = true;
    renderSuggestions();
  });
  audition.addEventListener("click", () => preview(input.value));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const normalized = normalizeChordSymbol(input.value);
    if (!normalized) {
      input.setCustomValidity("Unesi ispravan akord, npr. Am, D7 ili Fism.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    options.onConfirm?.(normalized);
    closeChordPicker();
  });
  const dismiss = () => closeChordPicker();
  backdrop.addEventListener("click", dismiss);
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  shell.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    }
  });
  renderSuggestions();
  requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
}
