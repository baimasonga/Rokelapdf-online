// The "real ink" look of a rubber stamp, applied to a stamp drawn flat on a canvas. Every impression is different (a new
// seed each time): uneven ink, one side pressed harder, rough edges and small gaps where the rubber did not touch.
// Pure pixel work on RGBA bytes, so it runs the same in the browser, the Android app and tests.

/** A small, fast seeded random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2-D value noise in [0, 1], seeded. */
export function valueNoise(seed: number): (x: number, y: number) => number {
  const r = rng(seed);
  const SIZE = 256;
  const grid = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  const at = (x: number, y: number) => grid[((y & (SIZE - 1)) * SIZE + (x & (SIZE - 1))) as number]!;
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
}

export interface InkOptions {
  seed: number;
  /** 0 = clean and even, 1 = heavily hand-stamped. */
  wear: number;
}

/**
 * Turns a flat stamp (any colour, alpha = shape) into an inked impression, in place. Only alpha changes: fully
 * transparent pixels stay transparent, and no pixel becomes more opaque than it was.
 */
export function inkify(rgba: Uint8ClampedArray, width: number, height: number, o: InkOptions): void {
  const wear = Math.min(1, Math.max(0, o.wear));
  const r = rng(o.seed);
  const blotch = valueNoise(o.seed ^ 0x9e3779b9);
  const grain = valueNoise(o.seed ^ 0x85ebca6b);
  const edge = valueNoise(o.seed ^ 0xc2b2ae35);
  // Which way the hand leaned: that side prints lighter.
  const lean = r() * Math.PI * 2;
  const lx = Math.cos(lean);
  const ly = Math.sin(lean);
  const press = 0.15 + 0.35 * wear;
  const scale = Math.max(width, height) / 600;
  const src = new Uint8ClampedArray(width * height);
  for (let i = 0; i < src.length; i++) src[i] = rgba[i * 4 + 3]!;
  const alphaAt = (x: number, y: number) => {
    const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(height - 1, Math.max(0, Math.round(y)));
    return src[yi * width + xi]!;
  };
  const cx = width / 2;
  const cy = height / 2;
  const half = Math.max(width, height) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!src[i]) continue;
      // Rough edges: read the shape from a slightly displaced point (this only ever eats into the edge).
      const d = 1.6 * scale * wear;
      const ax = x + (edge(x / (5 * scale), y / (5 * scale)) - 0.5) * 2 * d;
      const ay = y + (edge((x + 97) / (5 * scale), (y + 31) / (5 * scale)) - 0.5) * 2 * d;
      const a = Math.min(alphaAt(ax, ay), src[i]!);
      if (!a) {
        rgba[i * 4 + 3] = 0;
        continue;
      }
      const big = blotch(x / (70 * scale), y / (70 * scale));
      const fine = grain(x / (3 * scale), y / (3 * scale));
      const side = ((x - cx) * lx + (y - cy) * ly) / half; // -1 … 1
      let k = 1 - wear * 0.55 * (1 - big) - press * (0.5 + 0.5 * side) * wear * 1.4;
      k *= 1 - wear * 0.35 * (1 - fine);
      // Small gaps where the rubber missed the paper.
      if (fine < 0.12 * wear && big < 0.55) k *= 0.15;
      rgba[i * 4 + 3] = Math.round(a * Math.min(1, Math.max(0.12, k)));
    }
  }
}
