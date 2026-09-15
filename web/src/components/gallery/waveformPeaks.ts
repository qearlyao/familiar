/** RMS energy per time bucket, normalized once for a readable whole-recording waveform. */
export function waveformPeaks(channels: readonly Float32Array[], bars = 64): number[] {
  const length = channels[0]?.length ?? 0;
  const peaks = Array.from({ length: bars }, (_, bar) => {
    const start = Math.floor(bar * length / bars);
    const end = Math.floor((bar + 1) * length / bars);
    if (end <= start || channels.length === 0) return 0;
    let energy = 0;
    for (const channel of channels) for (let i = start; i < end; i++) energy += channel[i] ** 2;
    return Math.sqrt(energy / ((end - start) * channels.length));
  });
  const maximum = Math.max(...peaks);
  return maximum > 0 ? peaks.map((peak) => peak / maximum) : peaks;
}
