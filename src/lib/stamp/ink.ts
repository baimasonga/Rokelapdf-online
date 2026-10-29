// The "real ink" look of a rubber stamp, applied to a stamp drawn flat on a canvas. Every impression is different (a new
// seed each time): uneven ink, one side pressed harder, rough edges and small gaps where the rubber did not touch, and
// with rough edges turned up, specks and splashes of ink just past the lines.
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
  /** 0 = clean lines, 1 = rough, broken lines with ink splashed past them. */
  edgeWear?: number;
}

/**
 * Turns a flat stamp (any colour, alpha = shape) into an inked impression, in place. Wear only lightens: without rough
 * edges, fully transparent pixels stay transparent and no pixel becomes more opaque than it was. Rough edges also
 * splash ink, in the colour of the line it came from, onto the paper just beside the lines.
 */
export function inkify(rgba: Uint8ClampedArray, width: number, height: number, o: InkOptions): void {
  const wear = Math.min(1, Math.max(0, o.wear));
  const edgeWear = Math.min(1, Math.max(0, o.edgeWear ?? 0));
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
      const d = (1.6 * wear + 4 * edgeWear) * scale;
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
      if (fine < 0.12 * wear + 0.18 * edgeWear && big < 0.55) k *= 0.15;
      rgba[i * 4 + 3] = Math.round(a * Math.min(1, Math.max(0.12, k)));
    }
  }
  if (edgeWear > 0) splash(rgba, src, width, height, scale, edgeWear, rng(o.seed ^ 0x27d4eb2f));
}

/** Specks and small blots thrown just past the edges of the lines, now and then with a few droplets beyond them. */
function splash(rgba: Uint8ClampedArray, src: Uint8ClampedArray, width: number, height: number, scale: number, amount: number, r: () => number) {
  const inked = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && src[y * width + x]! > 0;
  const step = Math.max(1, Math.round(2 * scale));
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const dot = (cx: number, cy: number, rad: number, strength: number, from: number) => {
    for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(height - 1, Math.ceil(cy + rad)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(width - 1, Math.ceil(cx + rad)); x++) {
        const t = 1 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rad;
        if (t <= 0) continue;
        const a = Math.round(255 * strength * Math.min(1, t * 3));
        const i = y * width + x;
        if (a <= rgba[i * 4 + 3]!) continue;
        if (!src[i]) for (let c = 0; c < 3; c++) rgba[i * 4 + c] = rgba[from * 4 + c]!;
        rgba[i * 4 + 3] = a;
      }
    }
  };
  const count = Math.round(amount * 120 * scale);
  for (let n = 0; n < count; n++) {
    // Find a point on the edge of a line, and which way the paper lies from it.
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = Math.floor(r() * width);
      const y = Math.floor(r() * height);
      if (!inked(x, y)) continue;
      const open = dirs.filter(([dx, dy]) => !inked(x + dx * step, y + dy * step));
      if (!open.length) continue;
      const [dx, dy] = open[Math.floor(r() * open.length)]!;
      const out = (1 + r() * 4) * scale;
      const px = x + dx * out + (r() - 0.5) * 2 * scale;
      const py = y + dy * out + (r() - 0.5) * 2 * scale;
      // Mostly fine specks; now and then a bigger blot.
      const base = Math.max(0.8, (1 + r() * r() * 3.5) * scale);
      const from = y * width + x;
      dot(px, py, base, 0.6 + 0.35 * r(), from);
      if (r() < 0.5) {
        const drops = 1 + Math.floor(r() * 3);
        for (let k = 0; k < drops; k++) {
          const far = base * (1.5 + r() * 2);
          dot(px + dx * far + (r() - 0.5) * base * 2, py + dy * far + (r() - 0.5) * base * 2, Math.max(0.6, base * (0.3 + r() * 0.4)), 0.5 + 0.4 * r(), from);
        }
      }
      break;
    }
  }
}
