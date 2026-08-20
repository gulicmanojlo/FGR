const INSTRUMENTAL_STEMS = ["other", "piano", "guitar"];

const PHYSICAL_LABELS = {
  other: "Ostalo",
  piano: "Klavir",
  guitar: "Gitara"
};

const ACCOMPANIMENT_LABELS = {
  other: "Harmonija · ostalo",
  piano: "Harmonija · klavir",
  guitar: "Harmonija · gitara"
};

function normalizedAvailableStems(value) {
  const source = value instanceof Set ? [...value] : (Array.isArray(value) ? value : []);
  const available = new Set(source.map((name) => String(name || "").toLowerCase()));
  return INSTRUMENTAL_STEMS.filter((name) => !available.size || available.has(name));
}

function confirmedMelodyStem(noteTracks, available) {
  const melody = noteTracks?.melody;
  const source = String(melody?.sourceStems?.[0] || "").toLowerCase();
  if (melody?.status !== "ready" || !available.includes(source)) return "";
  return source;
}

export function resolveMixerControls(noteTracks, availableStems = []) {
  const available = normalizedAvailableStems(availableStems);
  const confirmedMelody = confirmedMelodyStem(noteTracks, available);
  const melodyKey = confirmedMelody
    || (available.includes("other") ? "other" : available[0])
    || "other";
  const remainder = INSTRUMENTAL_STEMS.filter((name) => name !== melodyKey);
  const usableRemainder = remainder.filter((name) => !available.length || available.includes(name));
  const accompanimentKey = usableRemainder.find((name) => name === "piano")
    || usableRemainder.find((name) => name === "other")
    || usableRemainder[0]
    || remainder[0];
  const physicalKey = INSTRUMENTAL_STEMS.find(
    (name) => name !== melodyKey && name !== accompanimentKey
  ) || "guitar";

  return [
    { suffix: "Bass", key: "bass", label: "Bas", role: "physical" },
    { suffix: "Drums", key: "drums", label: "Bubnjevi", role: "physical" },
    {
      suffix: "Guitar",
      key: physicalKey,
      label: PHYSICAL_LABELS[physicalKey],
      role: "physical"
    },
    {
      suffix: "Piano",
      key: melodyKey,
      label: "Melodija",
      role: "melody",
      confirmed: Boolean(confirmedMelody)
    },
    { suffix: "Vocals", key: "vocals", label: "Vokal", role: "physical" },
    {
      suffix: "Other",
      key: accompanimentKey,
      label: ACCOMPANIMENT_LABELS[accompanimentKey],
      role: "accompaniment"
    }
  ];
}
