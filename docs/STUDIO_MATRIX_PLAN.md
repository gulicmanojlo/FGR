# Studijska matrica — analiza i plan unapređenja

Datum: 2026-07-25. Analiza rađena nad `chord_pipeline.py`, `processing_service.py`,
`js/audio.js`, `js/ui-controller.js` i nad **stvarnim izlazom** pipeline-a
(`samples/luis-sve-se-osim-tuge-deli/note-tracks.json`, `playlists/feelgood.json`).

---

## 1. Izmereno stanje (ne procena — brojevi)

### Akordi ne padaju na ritmičku mrežu

Tempo detektovan iz `drums.mp3` (librosa beat_track): **152 BPM, 531 bit, bit = 0.395 s**.
Poređenje 63 granice akorda iz `feelgood.json` sa najbližim bitom:

| metrika | vrednost |
|---|---|
| medijana odstupanja | **117 ms** (~30 % bita) |
| p90 | 174 ms |
| max | 198 ms |
| granica unutar 50 ms od bita | **14 / 63 (22 %)** |

Pipeline nigde ne detektuje tempo, bit ni taktovu crtu — `grep beat_track\|tempo\|downbeat`
u `chord_pipeline.py`, `processing_service.py`, `process_stems.py` daje **0 pogodaka**.
Granice se traže isključivo iz onset/chroma funkcije u slobodnom vremenu
(`refine_boundary_index`, `chord_pipeline.py:402`).

### Rečnik akorda je premali — i to na pogrešnoj strani

`CHORD_TEMPLATES` na serveru (`chord_pipeline.py:37-45`) = **samo 24 šablona: dur i mol**.
Browser fallback (`js/chord-analysis.js:6-10`) ima **više** od servera: `7, m7, maj7, dim, sus4`.
Dakle kanal sa boljim materijalom (razdvojeni stemovi) ima siromašniji rečnik od fallbacka.

`docs/PROCESSING_SERVICE.md:179` tvrdi da server ocenjuje „major/minor/**seventh**,
**suspended** and **diminished** templates" i koristi „song-key context" — ništa od toga
nije u kodu. Kompletan repertoar u `feelgood.json` ima samo dur/mol oznake.

Format akorda je `{t, n}` — bez trajanja, bez basa/inverzije, bez pozicije u taktu.

### Melodija nije transkripcija nego treperenje detektora pitch-a

Analiza `note-tracks.json` (stvarni izlaz):

| metrika | melodija | bas |
|---|---|---|
| nota | 641 | 507 |
| **nota kraćih od 120 ms** | **358 (56 %)** | 84 (17 %) |
| **zigzag artefakt a-b-a** | **98 (15 %)** | 29 (6 %) |
| koraci od poluteona | 27 % | 15 % |
| opseg | MIDI 50–86 (**3 oktave**) | 28–51 |

Tri oktave za jednu solo deonicu znači da detektor skače između instrumenata unutar
`other` stema. 56 % nota kraćih od 120 ms pri 152 BPM znači kraće od šesnaestine —
to nije fraziranje, to je cepanje jedne note na više njih.

Uzrok je segmentacija: `pitch_frames_to_events` (`processing_service.py:1003`) završava
notu **čim se promeni zaokruženi MIDI broj frejma**. Vibrato od ±50 centi oko granice
poluteona proizvodi 5 nota umesto jedne. Nema onset detekcije, nema note-level modela.

Bonus nalaz: demo traka je generisana sa `fgr-autocorrelation-python-v1` — najslabijim
fallbackom, ne sa pYIN-om, i nema `qa` blok.

### Klavir svira mehanički

1. **Nema audio scheduler-a.** `animLoop()` (`js/ui-controller.js:1993`) →
   `trackPlaybackAndHighlight()` → `updateTimedNoteTracking()` (`:6060`) →
   `setAssistedMidiSet()` → `startNote()` koji svira **odmah na `ctx.currentTime`**.
   Muzičko vreme je vezano za frejm brzinu ekrana: 16.7 ms u najboljem slučaju, 50–200 ms
   kad glavna nit crta talasni oblik ili timeline. Hack `catchUpHeldEvents`
   (`js/ui-controller.js:6098-6108`) koji hvata note propuštene između dva frejma je
   simptom, ne rešenje.
2. **Nema velocity.** `startSampleNote` (`js/audio.js:251`) uvek radi
   `gain.exponentialRampToValueAtTime(0.92, now + 0.008)`. Svaka nota jednake jačine.
   Semplovi su jedan velocity sloj (`*v12.mp3`), jedan sempl na malu tercu (A, C, D#, F#),
   pa se pitch-shiftuje do ±1.5 poluteona — formanti se pomeraju.
3. **Harmonija je blok akord u osnovnom položaju.** `getKeyboardChordMidis`
   (`js/ui-controller.js:6193`) uzima root u oktavi 4 i naslaže intervale. Nema basa,
   nema inverzija, nema vođenja glasova.
4. **Harmonija nema ritam.** `updateHarmonyPiano` se okine samo kad se promeni naziv
   akorda — jedan udar pa 2–4 s držanja. Nijedan pijanista tako ne svira.
5. Nema release semplova, pedala, rezonanse. Fiksni gain 0.92 × 5 glasova = 4.6 u
   kompresor.

---

## 2. Dijagnoza

Sva tri problema imaju isti koren: **ne postoji srednji sloj između audio analize i
sviranja.** Pipeline ide audio → labava lista događaja u sekundama → RAF sviranje.

Zbog toga:
- analiza nema muzička ograničenja (tempo, tonalitet, forma) koja bi je ispravila,
- kanali (melodija / bas / harmonija) ne dele zajedničku vremensku osu,
- renderer nema šta da zakaže unapred, pa svira „šta je aktivno baš sad".

To što traži korisnik — **studijska matrica** — je upravo taj sloj.

---

## 3. Studijska matrica (Score IR)

Jedan kanonski, simbolički, na mrežu vezan zapis pesme. I analiza i sviranje idu kroz njega.

```json
{
  "schemaVersion": 3,
  "songId": "luis-sve-se-osim-tuge-deli",
  "tempoMap":  [{ "t": 0.0, "bpm": 152.0, "beatsPerBar": 4 }],
  "beatGrid":  { "anchor": 4.213, "beats": [4.213, 4.608, "..."], "downbeats": [4.213, 5.79] },
  "key":       [{ "b": 0, "tonic": "A", "mode": "minor", "conf": 0.86 }],
  "sections":  [{ "id": "A1", "b": 8,  "lenBeats": 64, "repeatOf": null, "label": "strofa" },
                { "id": "A2", "b": 72, "lenBeats": 64, "repeatOf": "A1", "label": "strofa" }],
  "channels": {
    "harmony": { "chords": [
      { "b": 8.0, "lenBeats": 4, "root": "D", "quality": "m7", "bass": "F",
        "conf": 0.81, "source": "ai", "locked": false }
    ]},
    "melody": { "role": "lead", "sourceStem": "other", "notes": [
      { "b": 8.0, "lenBeats": 0.5, "midi": 62, "vel": 78, "conf": 0.92,
        "tRaw": 4.998, "dRaw": 0.131, "artic": "legato" }
    ]},
    "bass": { "role": "bass", "sourceStem": "bass", "notes": ["..."] }
  },
  "qa": { "beatFMeasure": 0.94, "chordConf": 0.78, "melodyFragmentation": 0.11 }
}
```

Ključne odluke:

- **Primarno vreme je bit (`b`), sekunde su izvedene** iz `tempoMap`. Sve tri deonice
  dele istu mrežu → kvantizacija, loop po taktovima, promena tempa i transponovanje
  postaju trivijalni.
- **`tRaw`/`dRaw` se čuvaju** — korisnik može da bira „kvantizovano" (studijski čisto)
  ili „kako je odsvirano" (originalno fraziranje). Ovo je „studijska matrica" u pravom
  smislu: ista pesma u dva pogleda.
- **`vel` je obavezan** na svakoj noti — bez njega klavir ne može zvučati verodostojno.
- **`locked`** označava šta je korisnik ručno ispravio; ponovna analiza to nikad ne gazi.
- Matrica je nadskup postojećih `chords` i `noteTracks`, pa se stari format može
  generisati iz nje (kompatibilnost sa playlistama i `PATCH /chords`).

Novi fajl: `.fgr-processing/songs/<id>/matrix.json`, izložen kao
`GET /v1/songs/:id/matrix`, `PATCH /v1/songs/:id/matrix`.

---

## 4. Faze

### Faza 0 — Ritmička mreža (temelj) — ✅ URAĐENO 2026-07-25

Implementirano u `beat_grid.py`, `js/beat-grid.js`, integrisano u
`processing_service.py` (faza `beat-grid` na 72 %) i prikazano na timeline-u.

Rezultat na demo pesmi (`samples/luis-sve-se-osim-tuge-deli/`):

| | |
|---|---|
| tempo | **76 BPM**, 4/4, `halfTimeApplied: true` (tracker je hvatao osmine na 152) |
| pouzdanost | puls 1.0, takt 1.0, ukupno **1.0** |
| mreža | 267 bitova, 67 taktova |

Dve stvari koje su otkrivene tek merenjem, a ne bi se pogodile:

1. **Fiksni ponder cue-ova je bio pogrešan.** Prvo sam dao 66 % harmonijskom
   novelty-ju i 34 % perkusiji. Mereno: perkusivni cue razlikuje taktove
   odnosom 3.88, harmonijski samo 1.10 — mreža je ispadala 3/4 umesto 4/4.
   Rešenje nije novi fiksni ponder nego **adaptivno ponderisanje**: svaki cue
   dobija težinu prema sopstvenoj metričkoj salijentnosti
   (`cue_metric_salience`), pa kanal bez informacije ne razblažuje jak kanal.
2. **Puls i takt moraju da otkažu nezavisno.** Stabilan puls bez akcenata i
   dalje ispravno kvantizuje note; samo prva doba nije poznata. Otuda odvojeni
   `status` i `meterStatus`.

Takođe: jitter od jednog analiznog frejma (23.2 ms na hop 512) više se ne
naplaćuje kao nestabilnost tempa — to je artefakt rezolucije, ne izvođenja.

**Baseline za Fazu 1** (postojeći akordi naspram nove mreže, demo pesma):

| tolerancija | granica na mreži |
|---|---|
| 50 ms | **9 / 63 (14 %)** |
| 100 ms | 10 / 63 (16 %) |
| 150 ms | 22 / 63 (35 %) |

Medijana odstupanja **244 ms** = 31 % bita (bit = 0.789 s). Ovo je broj koji
Faza 1 mora da popravi; `gridAlignmentReport()` u `js/beat-grid.js` je merna
funkcija za regresiju.

Preostalo iz ove faze (namerno odloženo, nije blokada za Fazu 1): ručna
korekcija tempa i prve dobe u UI-u.

---

Originalni plan faze, radi konteksta:

- Novi modul `beat_grid.py`: `librosa.beat.beat_track` na `drums.mp3` (potvrđeno da radi
  na demo pesmi), plus procena taktove crte — najjača harmonijska promena + bas onset
  padaju na prvu dobu. Alternativa je `madmom` DBN downbeat tracker (bolji, ali dodaje
  tešku zavisnost — prvo probati sopstvenu procenu).
- Dvostruko/polovično tempo: proveriti 76 vs 152 preko gustine harmonijskih promena.
- Rezultat u `tempoMap` + `beatGrid`. Prikazati mrežu na timeline-u (koristan feedback:
  korisnik odmah vidi da li je mreža pogrešna, i može ručno da pomeri anchor/tempo).
- Test: `tests/test_beat_grid.py` — beat F-measure protiv ručno tapkane reference.

Procena: 1–2 dana. **Najveći odnos efekta i cene u celom planu.**

### Faza 1 — Akordi na mreži — ✅ URAĐENO 2026-07-25

Rečnik proširen sa **24 na 156 šablona** (13 kvaliteta × 12 osnova), dodati
`estimate_key` + dijatonski prior, i nov beat-sinhroni put: hromagrama se svede
na jednu kolonu po dobi (medijana), pa Viterbi odlučuje po dobi sa kaznom
prelaza koja zavisi od mesta u taktu (promena na prvu dobu jeftina, van dobe
skupa).

Mereno na stvarnoj pesmi iz repertoara:

| | akorada | na mreži (±50 ms) | medijana odstupanja |
|---|---|---|---|
| staro | 88 | 16 / 88 (18 %) | **127 ms** |
| novo | 66 | 66 / 66 (100 %) | **0 ms** |

Granice sada po konstrukciji leže na dobama. Rečnik više nije samo dur/mol —
javljaju se 7, m7, sus4.

**Priori kvaliteta su kalibrisani na stvarnim kanalima, ne procenjeni.** Sa
prvobitnim vrednostima septakordi su izlazili na 46–52 % svih akorada, a maj7
na 10–19 % — to nisu bili akordi nego prolazni tonovi melodije koji ostaju u
harmonijskim kanalima. Posle kalibracije (×1.8): septakordi 8–14 %, maj7 0 %.

### Faza 2 — Melodija i bas — ✅ URAĐENO 2026-07-25

Segmentacija više ne prekida notu kad se promeni zaokružen MIDI. Visina se
drži u centima, nota traje dok se ne udalji preko 62 centa i tako **ostane**
bar tri frejma, a visina note je medijana njenog trajanja. Dodata je izmerena
dinamika iz jačine napada (`vel` na svakoj noti, kroz ceo lanac do klavira).

| | nota | < 120 ms | zigzag | dinamika |
|---|---|---|---|---|
| melodija staro | 286 | 52 % | 16 % | ne |
| melodija novo | 205 | **35 %** | **11 %** | da (140 nivoa) |
| bas staro | 351 | 17 % | 14 % | ne |
| bas novo | 289 | **0 %** | **8 %** | da (197 nivoa) |

**Onset deljenje je probano i odbačeno na osnovu merenja.** Delovalo je kao
očigledno rešenje, ali je na svakom pragu strogosti *pogoršavalo* udeo kratkih
nota (54 % bez onseta naspram 56–59 % sa njima): „other" kanal nosi perkusivno
curenje pa detektor okida i tamo gde vodeća deonica samo drži ton.

Ono što je stvarno pomoglo je prag trajanja od 90 ms (šesnaestina na 152 BPM).
Opravdanje je mereno, ne pretpostavljeno: kratke note imaju osetno nižu
pouzdanost detekcije (0.55 naspram 0.66), dakle jesu artefakti.

### Faza 1 — originalni plan

- **Beat-sinhroni hromagram**: medijana chroma po bitu umesto po frejmu od 11.6 ms.
  Standardna MIR tehnika, drastično smanjuje šum pre dekodiranja.
- **Rečnik**: `maj, min, 7, maj7, m7, m7b5, dim, aug, sus2, sus4, 6, m6` = 144 šablona,
  plus slash akordi iz bass chroma. Uskladiti sa `js/chord-analysis.js` da server i
  browser koriste isti rečnik i iste srpske nazive.
- **Tonalitet**: Krumhansl-Schmuckler profili nad prosečnom chromom → prior koji favorizuje
  dijatonske akorde. Rešava tipične greške tipa `Dis` umesto `D#dim`/`Gm6`.
- **Viterbi po bitu, ne po frejmu**, sa kaznom prelaza zavisnom od pozicije u taktu:
  promena na 1. dobu jeftina, na 3. srednja, van dobe skupa. Ovo direktno rešava izmerenih
  117 ms odstupanja.
- **Forma**: self-similarity matrica nad beat-chromom → detekcija ponavljanja.
  Prosečiti chroma preko ponovljenih sekcija pre dekodiranja → isti refren dobija
  **isti** akord svaki put. Trenutno se svako ponavljanje analizira nezavisno.
- Opciono kasnije: pretrenirani CRNN (BTC / Chordino) kao drugi glas, pa fuzija.

Izmene: `chord_pipeline.py` (`CHORD_TEMPLATES`, `chord_score_matrix`,
`build_chord_chart_from_features`), `js/chord-analysis.js`.

### Faza 2 — Melodija i bas kao note

- **Zameniti frame-run segmentaciju** (`pitch_frames_to_events`): onset detekcija
  (spectral flux po stemu) daje početke, pYIN daje f0, nota = medijana f0 između dva
  onseta uz voicing. Vibrato više ne cepa notu. Ovo je najveći pojedinačni popravak —
  ciljano obara 56 % kratkih nota ispod 15 %.
- **Velocity** iz RMS envelope stema u prozoru note → prava dinamika u `vel`.
- **Kvantizacija** na mrežu iz Faze 0, sa swing tolerancijom; `tRaw` se čuva.
- **Harmonijski filter**: nota koja je van akorda i van skale, kraća od 1/16, sa niskim
  `conf` → artefakt. Spustiti joj `conf` ili je ukloniti.
- **Anti-skakanje između instrumenata**: kazniti skokove > oktave u kratkom vremenu
  (Viterbi nad kandidatima, ne post-hoc `stabilize_note_event_octaves`), i meriti da li
  je opseg deonice realan za jedan instrument.
- **Guardrail**: ako je > 40 % nota kraće od šesnaestine na detektovanom tempu, traka je
  `low-confidence` — ne prikazivati je kao tačnu transkripciju.
- Regenerisati `samples/.../note-tracks.json` — trenutna verzija je od najslabijeg
  detektora.

### Faza 3 — Verodostojno sviranje — ✅ URAĐENO 2026-07-25

Novi moduli: [`js/score-player.js`](../js/score-player.js) (zakazivanje unapred),
[`js/piano-voice.js`](../js/piano-voice.js) (dinamika i otpuštanje),
[`js/voicing.js`](../js/voicing.js) (raspored akorda i ritam pratnje).

Šta se promenilo:

| | pre | posle |
|---|---|---|
| tajming | RAF, 16–200 ms džitera | zakazano 150 ms unapred na WebAudio satu |
| dinamika | fiksnih `0.92` za svaki ton | velocity → pojačanje + svetlina filtra |
| harmonija | blok akord, osnovni položaj, oktava 4 | bas + 3-4 tona sa vođenjem glasova |
| ritam pratnje | jedan udar držan 2-4 s | 6 obrazaca vezanih za taktove iz mreže |
| kanali | sve u master | zasebne sabirnice melodija/bas/harmonija |
| otpuštanje | fiksno | zavisno od registra, duže sa pedalom |

Na demo pesmi: 63 akorda daju **536 tonova pratnje** (ranije 63 blok akorda),
prosečan pomeraj ruke između akorada **2.63 poluteona** (max 5), desna ruka
ostaje u 57–70.

Uklonjen je `catchUpHeldEvents` krpež iz RAF petlje — postojao je samo da hvata
tonove propuštene između frejmova, što scheduler čini nemogućim po konstrukciji.

**Tri greške istog tipa, nađene merenjem a ne čitanjem koda.** `Number(null)`
je `0`, pa `Number.isFinite(Number(x))` prihvata „nema vrednosti" kao nulu:

1. `voicing.js` — plafon desne ruke se spuštao ispod *nepostojeće* melodije na
   fiksnih 62, što je onemogućavalo ispravno vođenje glasova. Uhvaćeno tek kad
   sam izmerio da izabrani raspored košta 7.98 a odbačeni 5.40.
2. `voicing.js` — prvi akord nema prethodni bas, pa je ciljni registar ispadao
   MIDI 20 i bas je guran na dno klavijature.
3. `piano-voice.js` — ton bez zadate dinamike svirao bi na 0.05 umesto 0.78,
   dakle praktično nečujno.

Svaka od tri sada koristi strogu proveru tipa i ima regresioni test.

Preostalo iz ove faze: pravi velocity slojevi semplova (sada je jedan sloj
`v12`, dinamika se gradi iz pojačanja i filtra) i klizači po kanalima u UI-u.

---

Originalni plan faze, radi konteksta:

Ovo je deo koji korisnik najbrže čuje i **ne zavisi ni od kakvog ML-a.**

1. **Lookahead scheduler** (novi `js/score-player.js`). Tajmer na 25 ms gleda 150 ms
   unapred i zakazuje `source.start(exactTime)` na WebAudio satu; RAF ostaje samo za
   vizuelno. Mapiranje mix vreme → `ctx.currentTime` se re-sinhronizuje jednom po ciklusu
   uz kompenzaciju drifta. Jitter pada sa 16–200 ms na < 1 ms. `catchUpHeldEvents` hack
   nestaje.
2. **Velocity slojevi.** Minimum 3 sloja (p / mf / f) umesto današnjeg jednog (`v12`),
   i sempl na pola oktave umesto na malu tercu. Čak i pre nabavke novih semplova:
   gain po `vel` + lowpass cutoff po `vel` (jače = svetlije) daje veliki skok realizma.
3. **Release i pedal.** Release zavisan od registra (bas duže), sustain pedal produžava
   release i otvara blagi resonance bus.
4. **Voicing engine** (novi `js/voicing.js`) — ovo pretvara harmoniju iz „MIDI orgulja"
   u klavir:
   - leva ruka: bas ton (root ili `bass` iz slash akorda), desna ruka 3–4 tona u C3–C5;
   - **vođenje glasova**: minimizovati kretanje između susednih akorada — isti DP pristup
     koji već postoji u `js/melody-fingering.js`;
   - izbeći sudar sa melodijom (ako se poklapaju registri, spustiti voicing za oktavu);
   - kvinta se izostavlja u četvorozvucima, tercа i septima su obavezne.
5. **Comping šabloni** vezani za `tempoMap`: cela nota / na 1 i 3 / osminski arpeggio /
   valcer 1-2-3 / balada. Izbor po žanru ili ručno u UI. Jedan udar koji traje 4 s je
   glavni razlog zašto trenutno „ne zvuči kao klavir".
6. **Humanizacija**: mikro-timing ±8 ms, veći `vel` na jakoj dobi, roll akorda 8–15 ms.
7. **Miks**: zaseban gain bus po kanalu (melodija / bas / harmonija) povezan sa postojećim
   `js/mixer-routing.js`, i normalizacija po broju glasova umesto fiksnog 0.92.

### Faza 4 — Merenje (radi se paralelno od početka)

Bez ovoga svaka izmena algoritma je nagađanje.

- `tests/fixtures/matrix/` — 10–15 pesama iz repertoara sa ručno ispravljenom matricom.
  Korisnik ih pravi u postojećem chord-editoru + novom note-editoru; `locked: true`
  označava referencu.
- `python -m tests.benchmark_matrix` → izveštaj po pesmi i zbirno:
  - akordi: weighted chord symbol recall (`mir_eval.chord` — **već je u
    `requirements-processing.txt`**, trenutno neiskorišćen),
  - note: onset F1 + pitch accuracy (`mir_eval.transcription`),
  - bit: F-measure (`mir_eval.beat`).
- Svaka promena algoritma se meri pre i posle. Korisničke ispravke automatski postaju
  regresioni podaci.

---

## 5. Redosled

| # | Faza | Efekat | Cena |
|---|---|---|---|
| 1 | ✅ **Faza 0** — beat grid | otključava sve ostalo | urađeno |
| 2 | ✅ **Faza 3.1** — lookahead scheduler | tačan timing | urađeno |
| 3 | ✅ **Faza 3.4–3.6** — voicing + comping + velocity | zvuči kao klavir | urađeno |
| 4 | **Faza 4** — benchmark korpus | bez njega nema merljivog napretka | 1 dan + anotacije |
| 5 | **Faza 1** — akordi na mreži + rečnik | tačnost akorda | 3–4 dana |
| 6 | **Faza 2** — onset-bazirana melodija | tačnost melodije | 3–4 dana |

**Važno za očekivanja:** faze 0 i 3 popravljaju *kako se svira* i daju
zajedničku mrežu. **Tačnost prepoznavanja akorada i melodije još nije dirana**
— to su faze 1 i 2. Pesma će zvučati bitno bolje, ali ako je akord pogrešno
prepoznat, sada će biti pogrešan lepšim klavirom.

Faze 3.1 i 3.4–3.6 su namerno pomerene ispred analize: korisnik odmah čuje razliku, a rade
i nad postojećim (nesavršenim) podacima.

---

## 6. Rizici

- **Beat tracking greši na rubato/slobodnim uvodima.** Rešenje: mreža važi po sekcijama,
  a delovi bez pouzdanog bita ostaju u slobodnom vremenu (`tRaw`).
- **Kvantizacija može da ubije fraziranje.** Zato se `tRaw` uvek čuva i postoji prekidač
  „kvantizovano / kako je odsvirano".
- **Prošireni rečnik akorda povećava broj grešaka tipa 7 vs trozvuk** ako nema key priora
  i beat-sinhronizacije. Zato Faza 1 mora ići cela, ne parcijalno.
- **Više velocity slojeva = veći download.** Trenutno 30 MP3 semplova; 3 sloja = 90.
  Ublažiti lenjim učitavanjem po registru i OGG/Opus formatom.
- **Migracija podataka.** Matrica mora da se generiše i iz postojećih pesama bez ponovne
  Demucs separacije (`chords` + `noteTracks` → matrica sa procenjenom mrežom).
- **Dokumentacija trenutno tvrdi funkcije kojih nema** (`PROCESSING_SERVICE.md:179`).
  Ispraviti odmah, nezavisno od ovog plana.
