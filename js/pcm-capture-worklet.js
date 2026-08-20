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

    this.port.onmessage = (event) => {
      const command = event.data?.type;
      if (command === "reset") {
        this.channelData = this.createChannelData();
        this.offset = 0;
        this.totalFrames = 0;
        this.recording = true;
      } else if (command === "stop") {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: "stopped", totalFrames: this.totalFrames });
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
      channels: buffers
    }, buffers);
    this.channelData = this.createChannelData();
    this.offset = 0;
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    const firstChannel = input?.[0];
    if (!firstChannel?.length) return true;

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
