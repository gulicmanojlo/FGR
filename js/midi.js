import { state, NOTE_NAMES } from "./state.js";

export const midiHeld = new Set();
let midiOnChordCallback = null;

const MIDI_TEMPLATES = [
  ["", [0, 4, 7]], 
  ["m", [0, 3, 7]], 
  ["dim", [0, 3, 6]], 
  ["sus4", [0, 5, 7]], 
  ["sus2", [0, 2, 7]],
  ["7", [0, 4, 7, 10]], 
  ["m7", [0, 3, 7, 10]], 
  ["maj7", [0, 4, 7, 11]], 
  ["m7b5", [0, 3, 6, 10]], 
  ["dim7", [0, 3, 6, 9]], 
  ["6", [0, 4, 7, 9]], 
  ["m6", [0, 3, 7, 9]]
];

export function setMidiOnChordCallback(cb) {
  midiOnChordCallback = cb;
}

export function midiPcSet() {
  const set = new Set();
  midiHeld.forEach((m) => {
    set.add(((m % 12) + 12) % 12);
  });
  return set;
}

export function detectMidiChord() {
  if (!midiHeld || midiHeld.size === 0) return null;
  const notes = Array.from(midiHeld).sort((a, b) => a - b);
  if (notes.length === 1) return NOTE_NAMES[notes[0] % 12];
  
  const pcs = Array.from(midiPcSet());
  const bassPc = notes[0] % 12;
  let best = null;
  
  for (let r = 0; r < pcs.length; r++) {
    const rootPc = pcs[r];
    const rel = pcs.map((pc) => (pc - rootPc + 12) % 12).sort((a, b) => a - b);
    
    for (let t = 0; t < MIDI_TEMPLATES.length; t++) {
      const tpl = MIDI_TEMPLATES[t][1];
      if (tpl.length !== rel.length) continue;
      const match = tpl.every((iv) => rel.indexOf(iv) !== -1);
      if (match) {
        const score = tpl.length * 10 + (rootPc === bassPc ? 5 : 0);
        if (!best || score > best.score) {
          best = { 
            rootPc: rootPc, 
            name: NOTE_NAMES[rootPc] + MIDI_TEMPLATES[t][0], 
            score: score 
          };
        }
      }
    }
  }
  
  if (!best) return pcs.map((pc) => NOTE_NAMES[pc]).join("·");
  return best.rootPc === bassPc ? best.name : best.name + "/" + NOTE_NAMES[bassPc];
}

function onMidiMessage(event) {
  const st = event.data[0], d1 = event.data[1], d2 = event.data[2];
  const cmd = st & 0xF0;
  let changed = false;
  const isDown = cmd === 0x90 && d2 > 0;
  
  if (isDown) {
    midiHeld.add(d1);
    changed = true;
  } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
    midiHeld.delete(d1);
    changed = true;
  }
  
  if (!changed) return;
  
  // Vizuelni feedback na klavijaturi se okida preko eventa
  const key = document.querySelector(`.key[data-midi="${d1}"]`);
  if (key) {
    key.classList.toggle("midi-held", midiHeld.has(d1));
  }
  
  // Obavestavamo sistem da osvezi prikaz akorda
  window.dispatchEvent(new CustomEvent("fgr:midichange"));
  
  if (midiOnChordCallback) {
    midiOnChordCallback(midiPcSet(), {
      down: isDown,
      midi: d1,
      pc: ((d1 % 12) + 12) % 12,
      midis: Array.from(midiHeld),
      source: "midi"
    });
  }
}

function bindMidi(access) {
  let first = null, count = 0;
  access.inputs.forEach((input) => {
    input.onmidimessage = onMidiMessage;
    if (!first) first = input;
    count++;
  });
  
  const led = document.getElementById("midiLed");
  const name = document.getElementById("midiName");
  const settingsStatus = document.getElementById("midiSettingsStatus");
  
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
  const el = document.getElementById("midiSettingsStatus");
  if (el) el.textContent = text;
}

export function connectMidi(silent) {
  if (!navigator.requestMIDIAccess) {
    midiStatusMsg("browser nema Web MIDI (koristi Chrome/Edge)");
    if (!silent) alert("Ovaj browser nema Web MIDI (koristi Chrome/Edge). Na iPad-u ne radi.");
    return;
  }
  if (!silent) midiStatusMsg("tražim uređaje…");
  
  navigator.requestMIDIAccess()
    .then((access) => {
      bindMidi(access);
      access.onstatechange = () => { bindMidi(access); };
      if (access.inputs.size === 0) {
        midiStatusMsg("0 uredjaja — proveri: klavijatura ukljucena? kabl u USB DEVICE port? zatvori druge programe/tabove koji drze MIDI, pa klikni ponovo");
      }
    })
    .catch((err) => {
      midiStatusMsg("pristup odbijen (" + err.message + ") — proveri dozvole sajta (katanac pored adrese)");
      if (!silent) alert("Pristup MIDI uređajima je odbijen. Klikni katanac pored adrese sajta i dozvoli MIDI.");
    });
}
