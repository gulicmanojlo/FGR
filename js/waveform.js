const DEFAULT_BINS = 320;
const DEFAULT_SAMPLES_PER_BIN = 192;

function finiteSample(value) {
  const sample = Number(value);
  return Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

/**
 * Down-sample an AudioBuffer into perceptual peak values. RMS keeps sustained
 * material visible while the peak component preserves attacks and transients.
 */
export function extractWaveformPeaks(audioBuffer, options = {}) {
  const bins = Math.max(16, Math.min(1200, Math.round(Number(options.bins) || DEFAULT_BINS)));
  const samplesPerBin = Math.max(32, Math.min(1024, Math.round(Number(options.samplesPerBin) || DEFAULT_SAMPLES_PER_BIN)));
  const channelCount = Math.max(0, Math.min(8, Math.round(Number(audioBuffer?.numberOfChannels) || 0)));
  const length = Math.max(0, Math.round(Number(audioBuffer?.length) || 0));
  if (!channelCount || !length || typeof audioBuffer?.getChannelData !== "function") return [];

  const channels = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    try {
      const data = audioBuffer.getChannelData(channel);
      if (data?.length) channels.push(data);
    } catch {
      // A malformed channel must not prevent the rest of the decoded audio
      // from producing a useful waveform.
    }
  }
  if (!channels.length) return [];

  const raw = new Array(bins).fill(0);
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin * length) / bins);
    const end = Math.max(start + 1, Math.floor(((bin + 1) * length) / bins));
    const step = Math.max(1, Math.floor((end - start) / samplesPerBin));
    let peak = 0;
    let squareSum = 0;
    let count = 0;

    channels.forEach((data) => {
      const channelEnd = Math.min(end, data.length);
      for (let index = start; index < channelEnd; index += step) {
        const sample = Math.abs(finiteSample(data[index]));
        if (sample > peak) peak = sample;
        squareSum += sample * sample;
        count += 1;
      }
    });

    const rms = count ? Math.sqrt(squareSum / count) : 0;
    raw[bin] = Math.max(peak * 0.62, rms * 1.7);
  }

  const reference = percentile(raw.filter((value) => value > 0), 0.97);
  if (!(reference > 0)) return raw.map(() => 0);
  const normalized = raw.map((value) => Math.min(1, value / reference));

  return normalized.map((value, index) => {
    const previous = normalized[index - 1] ?? value;
    const next = normalized[index + 1] ?? value;
    const smoothed = value * 0.62 + previous * 0.19 + next * 0.19;
    return Math.max(0, Math.min(1, smoothed));
  });
}

function point(x, y) {
  return `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
}

/** Build a closed, mirrored SVG area path from normalized waveform peaks. */
export function buildWaveformPath(peaks, options = {}) {
  const width = Math.max(1, Number(options.width) || 1000);
  const height = Math.max(4, Number(options.height) || 96);
  const center = height / 2;
  const halfHeight = height * 0.45;
  const values = Array.isArray(peaks) || ArrayBuffer.isView(peaks) ? [...peaks] : [];
  if (!values.length) {
    return `M ${point(0, center - 1)} L ${point(width, center - 1)} L ${point(width, center + 1)} L ${point(0, center + 1)} Z`;
  }

  const lastIndex = Math.max(1, values.length - 1);
  const top = values.map((value, index) => {
    const amplitude = Math.max(1, Math.min(1, Math.max(0, Number(value) || 0)) * halfHeight);
    return point((index / lastIndex) * width, center - amplitude);
  });
  const bottom = values.map((value, index) => {
    const amplitude = Math.max(1, Math.min(1, Math.max(0, Number(value) || 0)) * halfHeight);
    return point((index / lastIndex) * width, center + amplitude);
  }).reverse();

  return `M ${top[0]} L ${top.slice(1).join(" L ")} L ${bottom.join(" L ")} Z`;
}

export function createWaveformPath(audioBuffer, options = {}) {
  return buildWaveformPath(extractWaveformPeaks(audioBuffer, options), options);
}
