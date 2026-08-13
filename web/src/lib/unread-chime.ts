/**
 * ⭐ W25 (R23) — the quiet arrival sound, and its personal switch's client-side cache.
 *
 * ── Why WebAudio and not an <audio> asset ────────────────────────────────────────────────────────
 * The operator's to-do is to pick the FILE himself («нужно какой-то звук подобрать») — until he
 * does, shipping some found-on-the-internet chime would put an asset nobody chose into the product.
 * A two-note synth IS the configurable seam: this module is the one place that makes sound, so
 * swapping to his file later is replacing one function body, and nothing else learns about it.
 *
 * ── Autoplay policy, respected rather than fought ────────────────────────────────────────────────
 * Browsers keep an AudioContext suspended until a user gesture. If it is suspended, we try resume()
 * and SKIP silently when refused — a badge that arrived without sound is the policy working, and
 * the number is still on screen. No retry queue: a sound played late is worse than none.
 */

let ctx: AudioContext | null = null;

/**
 * The `unread_sound` preference, cached so a toggle applies NOW (the settings page writes the server
 * AND this cache; the badge hook reads the server once per mount and keeps the cache warm).
 * `null` = not yet known — the hook treats that as the catalogue default ('on').
 */
let soundEnabled: boolean | null = null;

export function setUnreadSoundEnabled(on: boolean): void {
  soundEnabled = on;
}

export function unreadSoundEnabled(): boolean | null {
  return soundEnabled;
}

/** Two soft notes, ~220ms total, gain far below speech level — «не громкий, но слышный». */
export function playUnreadChime(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') {
      // A refused resume leaves the context suspended; the catch below swallows nothing else.
      void ctx.resume();
    }
    if (ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    for (const [freq, at] of [
      [880, 0],
      [1174.66, 0.09],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.06, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.14);
    }
  } catch {
    // No audio device, no permission, no AudioContext (jsdom) — silence is the correct output.
  }
}
