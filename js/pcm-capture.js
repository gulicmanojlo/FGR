const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_CHANNELS = 2;
const STOP_TIMEOUT_MS = 3000;

function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext || null;
}

function disconnectQuietly(node) {
  try { node?.disconnect(); } catch {}
}

function waitForWorkletStop(node) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, STOP_TIMEOUT_MS);
    node.__fgrResolveStop = finish;
    node.port.postMessage({ type: "stop" });
  });
}

/**
 * Captures the shared tab on the audio render thread. Chunks are transferred to
 * the UI thread in order, while the worklet keeps the authoritative frame
 * counter. This avoids ScriptProcessor timing jitter and dropped callbacks.
 */
export async function createPcmTabRecorder(audioStream, options = {}) {
  const AudioContext = audioContextConstructor();
  if (!AudioContext || typeof window.AudioWorkletNode !== "function") {
    throw new Error("AudioWorklet PCM snimanje nije dostupno u ovom browseru.");
  }

  const context = new AudioContext({
    sampleRate: Number(options.sampleRate) || DEFAULT_SAMPLE_RATE,
    latencyHint: "interactive"
  });
  if (!context.audioWorklet) {
    await context.close().catch(() => {});
    throw new Error("AudioWorklet PCM snimanje nije dostupno u ovom browseru.");
  }

  await context.audioWorklet.addModule(
    new URL("./pcm-capture-worklet.js?v=165", import.meta.url).href
  );

  const source = context.createMediaStreamSource(audioStream);
  const channels = Math.max(1, Math.min(2, Number(options.channels) || DEFAULT_CHANNELS));
  const worklet = new AudioWorkletNode(context, "fgr-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: channels,
    channelCountMode: "explicit",
    outputChannelCount: [channels],
    processorOptions: { channelCount: channels, chunkFrames: 8192 }
  });
  const silentOutput = context.createGain();
  silentOutput.gain.value = 0;
  const chunks = Array.from({ length: channels }, () => []);
  let frameCount = 0;
  // Frames the browser never delivered. The worklet fills them with silence so
  // the recording keeps real time; this is the count that says how much of the
  // song is missing, which the old code had no way of knowing.
  let droppedFrames = 0;
  let dropoutCount = 0;

  const recorder = {
    state: "recording",
    context,
    markOrigin() {
      if (this.state !== "recording") return;
      chunks.forEach((channelChunks) => { channelChunks.length = 0; });
      frameCount = 0;
      droppedFrames = 0;
      dropoutCount = 0;
      worklet.port.postMessage({ type: "reset" });
    },
    captureIntegrity() {
      const rate = context.sampleRate || 48000;
      const total = frameCount || 1;
      return {
        droppedFrames,
        dropoutCount,
        droppedSeconds: droppedFrames / rate,
        droppedRatio: droppedFrames / total,
        recordedSeconds: frameCount / rate
      };
    },
    async stop() {
      if (this.state !== "recording") return null;
      this.state = "inactive";
      await waitForWorkletStop(worklet);
      disconnectQuietly(source);
      disconnectQuietly(worklet);
      disconnectQuietly(silentOutput);

      if (!frameCount) {
        await context.close().catch(() => {});
        return null;
      }

      const output = context.createBuffer(channels, frameCount, context.sampleRate);
      for (let channel = 0; channel < channels; channel += 1) {
        const target = output.getChannelData(channel);
        let offset = 0;
        for (const chunk of chunks[channel]) {
          const available = Math.max(0, target.length - offset);
          if (!available) break;
          const slice = chunk.length > available ? chunk.subarray(0, available) : chunk;
          target.set(slice, offset);
          offset += slice.length;
        }
      }
      await context.close().catch(() => {});
      return output;
    }
  };

  worklet.port.onmessage = (event) => {
    if (event.data?.type === "chunk") {
      const channelBuffers = Array.isArray(event.data.channels) ? event.data.channels : [];
      const received = channelBuffers.map((buffer) => new Float32Array(buffer));
      const frames = Math.max(0, Number(event.data.frameCount) || received[0]?.length || 0);
      for (let channel = 0; channel < channels; channel += 1) {
        const chunk = received[Math.min(channel, received.length - 1)];
        if (chunk) chunks[channel].push(chunk);
      }
      frameCount += frames;
      droppedFrames = Math.max(droppedFrames, Number(event.data.droppedFrames) || 0);
      return;
    }
    if (event.data?.type === "stopped") {
      droppedFrames = Math.max(droppedFrames, Number(event.data.droppedFrames) || 0);
      dropoutCount = Math.max(dropoutCount, Number(event.data.dropoutCount) || 0);
      worklet.__fgrResolveStop?.();
      delete worklet.__fgrResolveStop;
    }
  };

  source.connect(worklet);
  worklet.connect(silentOutput);
  silentOutput.connect(context.destination);
  await context.resume();
  return recorder;
}

export function audioBufferSignalStats(audioBuffer) {
  if (!audioBuffer?.numberOfChannels || !audioBuffer.length) {
    return { peak: 0, rms: 0, silent: true };
  }
  let peak = 0;
  let squareSum = 0;
  let samples = 0;
  const stride = Math.max(1, Math.floor(audioBuffer.length / 480000));
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += stride) {
      const value = Number(data[index]) || 0;
      peak = Math.max(peak, Math.abs(value));
      squareSum += value * value;
      samples += 1;
    }
  }
  const rms = samples ? Math.sqrt(squareSum / samples) : 0;
  return { peak, rms, silent: peak < 0.0005 || rms < 0.00005 };
}
