class FgrPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const requestedChannels = Number(options.processorOptions?.channelCount) || 2;
    const requestedFrames = Number(options.processorOptions?.chunkFrames) || 8192;
    this.channelCount = Math.max(1, Math.min(2, Math.round(requestedChannels)));
    this.chunkFrames = Math.max(2048, Math.min(32768, Math.round(requestedFrames)));
    this.channelData = this.createChannelData();
    this.offset = 0;
    this.totalFrames = 0;
    this.recording = false;
    // Position of the first captured frame on the context clock. Everything
    // about dropout detection is measured against this, because the processor
    // only ever counts frames it actually received: when the browser skips a
    // render quantum, nothing in this file would otherwise notice.
    this.originFrame = null;
    this.droppedFrames = 0;
    this.dropoutCount = 0;

    this.port.onmessage = (event) => {
      const command = event.data?.type;
      if (command === "reset") {
        this.channelData = this.createChannelData();
        this.offset = 0;
        this.totalFrames = 0;
        this.originFrame = null;
        this.droppedFrames = 0;
        this.dropoutCount = 0;
        this.recording = true;
      } else if (command === "stop") {
        this.flush();
        this.recording = false;
        this.port.postMessage({
          type: "stopped",
          totalFrames: this.totalFrames,
          droppedFrames: this.droppedFrames,
          dropoutCount: this.dropoutCount
        });
      }
    };
  }

  createChannelData() {
    return Array.from({ length: this.channelCount }, () => new Float32Array(this.chunkFrames));
  }

  flush() {
    if (!this.offset) return;
    const frameCount = this.offset;
    const chunks = this.channelData.map((source) => source.slice(0, frameCount));
    const buffers = chunks.map((chunk) => chunk.buffer);
    this.port.postMessage({
      type: "chunk",
      frameCount,
      startFrame: this.totalFrames - frameCount,
      droppedFrames: this.droppedFrames,
      channels: buffers
    }, buffers);
    this.channelData = this.createChannelData();
    this.offset = 0;
  }

  /**
   * Fill a gap with silence so the recording keeps real time.
   *
   * Dropping the frames instead would shorten the file by exactly the amount
   * lost, which silently drags every later moment earlier — a capture measured
   * on disk had lost 2.6 s this way, in about a thousand separate 2.7 ms gaps,
   * and nothing downstream could tell. Silence is audible damage; a shifted
   * timeline is invisible damage that ruins beats, chords and note timing.
   */
  appendSilence(frames) {
    let remaining = Math.max(0, Math.round(frames));
    while (remaining > 0) {
      const available = this.chunkFrames - this.offset;
      const count = Math.min(available, remaining);
      for (let channel = 0; channel < this.channelCount; channel += 1) {
        this.channelData[channel].fill(0, this.offset, this.offset + count);
      }
      this.offset += count;
      this.totalFrames += count;
      remaining -= count;
      if (this.offset >= this.chunkFrames) this.flush();
    }
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    const firstChannel = input?.[0];
    if (!firstChannel?.length) return true;

    if (this.originFrame === null) {
      this.originFrame = currentFrame;
    } else {
      // `currentFrame` advances with the context whether or not this processor
      // was called, so the difference is exactly what the capture missed.
      const missing = currentFrame - this.originFrame - this.totalFrames;
      if (missing > 0) {
        this.droppedFrames += missing;
        this.dropoutCount += 1;
        this.appendSilence(missing);
      }
    }

    let sourceOffset = 0;
    while (sourceOffset < firstChannel.length) {
      const available = this.chunkFrames - this.offset;
      const frameCount = Math.min(available, firstChannel.length - sourceOffset);
      for (let channel = 0; channel < this.channelCount; channel += 1) {
        const source = input[Math.min(channel, input.length - 1)] || firstChannel;
        this.channelData[channel].set(
          source.subarray(sourceOffset, sourceOffset + frameCount),
          this.offset
        );
      }
      this.offset += frameCount;
      this.totalFrames += frameCount;
      sourceOffset += frameCount;
      if (this.offset >= this.chunkFrames) this.flush();
    }
    return true;
  }
}

registerProcessor("fgr-pcm-capture", FgrPcmCaptureProcessor);
