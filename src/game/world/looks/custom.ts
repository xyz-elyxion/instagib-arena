// Look for the 'custom' arena (the map editor's workspace): "Workshop" —
// a bright, neutral grey deck under an open sky with a crisp cyan sun.
// Custom maps are authored as a list of boxes; this theme is fully
// GENERATIVE — every light, tint and inlay is derived from the CUSTOM map
// data (imported here), so user-made arenas look finished with zero
// per-map authoring: per-tier tints colour the levels apart, emissive
// nosing strips mark every climbable edge, cyan spawn rings paint the
// floor, and a warm sun + soft blue sky keys the whole scene.
import {
  FACE_NORMAL, band4, defaultSlot, downLight, norm, outline,
  type Face, type Inlay, type LightDef, type WorldTheme,
} from '../theme-kit';
import { R, bake, gratingField, panel, panelField, unusedCeiling } from '../../textures';
import { CUSTOM } from '../../maps/custom';
import type { MapBox } from '../../maps/kit';
import type { AABB } from '../../types';

// Tier colours (sRGB), keyed off the box's TOP height so every elevation
// reads as its own play level from anywhere in the map.
const TIER_0 = 0xb9c2cc; // ground (0–0.5 m above the floor top)
const TIER_1 = 0xd8b26a; // low decks (~1–3 m) — amber
const TIER_2 = 0x77c4a6; // mid decks (~3–7 m) — sea green
const TIER_3 = 0x7fa8e8; // high decks (~7–13 m) — cornflower blue
const TIER_4 = 0xd07ad0; // apex (13 m+) — orchid
const ACCENT = 0x4fd8ff;

// Emissive accents bright enough to always read as "climb here" markers.
const TAG_STEP = 0x36e0b0;

function tierOf(b: MapBox, floorTop: number): number {
  const h = b.max.y - floorTop;
  const tall = b.max.y - b.min.y > 3.2; // walls / towers use their own bands
  if (tall && b.max.y - b.min.y > 8) return TIER_3;
  if (h <= 0.6) return TIER_0;
  if (h <= 3) return TIER_1;
  if (h <= 7) return TIER_2;
  if (h <= 13) return TIER_3;
  return TIER_4;
}

// ── surfaces ───────────────────────────────────────────────────────────────
const TEXTURES: WorldTheme['textures'] = {
  // Polished concrete deck: 4 m bays, hairline joints.
  floor: () => bake(
    panelField({ size: R, cols: 2, rows: 2, seamHalf: 1, bevel: 1.5, depth: 1.2, inset: 6, rivets: 'none', wobble: 0.4, seed: 311 }),
    {
      base: 0x9aa0a8, seamDark: 0.72, toneNoise: 0.03, grain: 0.014,
      rough: { base: 0.5, seam: 0.22, centre: 0.08, blotch: 0.07, grain: 0.025 },
      ao: 0.5, aoBlur: 3, seed: 312,
      stain: { color: 0x9aa0a8, amount: 0.14, cell: 90, bias: 0.1, rough: 0.05, seed: 313 },
    },
    6,
  ),
  // Tall structural plates (perimeter / big blocks).
  wall: () => panel(0xaab2bc, 4, {
    cols: 2, rows: 1, seamHalf: 1.2, bevel: 2, depth: 2, rivets: 'none',
    rough: 0.55, tone: 0.025, grain: 0.012, seed: 321,
  }),
  ceiling: unusedCeiling, // never drawn (open sky)
  // Decks: pale plates with corner studs (tints carry the level colour).
  platform: () => panel(0xd4d7da, 2, { rivets: 'corners', rivetInset: 16, rivetR: 2.2, rivetH: 1, rough: 0.45, seamDark: 0.6, tone: 0.02, seed: 331 }),
  // Low cover / crates / steps: flat painted plate (tint = the paint).
  cover: () => panel(0xdadde0, 2, { cols: 1, rows: 1, bevel: 3, depth: 2.5, inset: 12, rough: 0.5, seamDark: 0.6, tone: 0.02, grain: 0.01, seed: 341 }),
  // Towers and spines: riveted structural bands.
  tower: () => panel(0xb4bcc6, 4, { cols: 1, rows: 2, seamHalf: 1, bevel: 1.5, depth: 1.5, rivets: 'bands', rivetInset: 8, rivetR: 1.8, rivetH: 0.8, rough: 0.5, seamDark: 0.7, tone: 0.02, seed: 351 }),
  // Unused on an open-sky map → the catwalk grating (matches the Lab range).
  grating: () => bake(
    gratingField({ size: R, pitch: 16, bar: 2.4, cross: 48, rod: 1.6, depth: 4, frame: 5, seed: 361 }),
    {
      base: 0xc4cad0, seamDark: 0.64, toneNoise: 0.02, grain: 0.015,
      rough: { base: 0.42, seam: 0.3, centre: 0, blotch: 0.05, grain: 0.03 },
      ao: 0.75, aoBlur: 3, seed: 362,
    },
    1.5,
  ),
} as unknown as WorldTheme['textures'];

// Repurpose the never-drawn ceiling slot as grating for thin walkways.
function slotFor(index: number, b: MapBox, k: ReturnType<typeof defaultSlot>): typeof k {
  if (index === 0 || index === 1) return k;
  const sy = b.max.y - b.min.y;
  const thin = sy <= 0.8 && b.min.y >= 0.9; // walkway slab
  if (thin && Math.max(b.max.x - b.min.x, b.max.z - b.min.z) >= 2) return 'ceiling'; // grating look
  return defaultSlot(index, b, k);
}

// ── tints ──────────────────────────────────────────────────────────────────
function tintFor(b: MapBox, floorTop: number): number | null {
  switch (b.tag) {
    case 'floor': return 0x9fa5ad;
    case 'perimeter': return 0x8f97a4;
    case 'wall': return TIER_3;
    case 'tower': return TIER_3;
    case 'spine': return 0xb8c2cc;
    case 'deck': return tierOf(b, floorTop);
    case 'cover': return tierOf(b, floorTop);
    case 'boost': return 0x5fd6c8; // teal = boostable marker, as the Lab range
    case 'spawn': return 0xf2f4f6;
  }
  return b.tag === 'steps' || b.tag === 'crate' ? tierOf(b, floorTop) : null;
}

// ── floor paint ────────────────────────────────────────────────────────────
function paint(): Inlay[] {
  const out: Inlay[] = [];
  // Cyan spawn rings + a bright pad under each spawn.
  for (const s of CUSTOM.spawns) {
    out.push(...outline({ min: { x: s.x - 1.4, y: 0, z: s.z - 1.4 }, max: { x: s.x + 1.4, y: 0, z: s.z + 1.4 } } as AABB, 0.16, ACCENT).map((i) => ({ ...i, glow: 0.7 })));
    out.push({ min: [s.x - 1, 0, s.z - 1], max: [s.x + 1, 0, s.z + 1], color: 0x3d4652 });
  }
  // Trim band along the floor's inner lip (a subtle wayfinding ring).
  const b = CUSTOM.bounds;
  out.push(...outline({ min: { x: b.min.x + 1.5, y: 0, z: b.min.z + 1.5 }, max: { x: b.max.x - 1.5, y: 0, z: b.max.z - 1.5 } } as AABB, 0.1, 0x8fa3b2));
  return out;
}

// ── lights (all generated from the map) ───────────────────────────────────
function insideAny(x: number, y: number, z: number, self: MapBox): boolean {
  return CUSTOM.boxes.some(
    (o) => o !== self && x > o.min.x && x < o.max.x && y > o.min.y && y < o.max.y && z > o.min.z && z < o.max.z,
  );
}

// Sun-style down-lights over the plate (the open-sky "streetlights"): one per
// ~18 m cell of footprint. Frame-rate/fixture budget stays small on big maps.
function deckLights(): LightDef[] {
  const b = CUSTOM.bounds;
  const w = b.max.x - b.min.x;
  const d = b.max.z - b.min.z;
  const nx = Math.max(2, Math.min(6, Math.round(w / 18)));
  const nz = Math.max(2, Math.min(6, Math.round(d / 18)));
  const out: LightDef[] = [];
  const y = Math.min(CUSTOM.boxes[1]?.min.y ?? b.max.y - 30, 24);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = b.min.x + ((i + 0.5) / nx) * w;
      const z = b.min.z + ((j + 0.5) / nz) * d;
      out.push(downLight([x, y, z], 0xe8f0ff, 240, 26, { size: [1.2, 2.2], angle: 0.75, out: 0.5, radius: 0.5, level: 0.85 }));
    }
  }
  return out;
}

// Glowing nosing on every exposed top edge of a climbable box: the tint of
// its tier, always emissive-only (fixture, no baked light) — the "climb here"
// signal maps like Causeway's strips, generated instead of hand-placed.
function nosing(): LightDef[] {
  const floorTop = CUSTOM.boxes[0]?.max.y ?? 0;
  const out: LightDef[] = [];
  const boxes = CUSTOM.boxes;
  for (const b of boxes) {
    if (b.tag === 'perimeter' || b.tag === 'floor' || b.tag === 'cap') continue;
    const sy = b.max.y - b.min.y;
    if (sy < 0.6) continue; // trim strips and pads don't need nosing
    const y = b.max.y - 0.28;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const color = b.tag === 'boost' ? TAG_STEP : tierOf(b, floorTop);
    const faces: Array<[Face, number, number, number]> = [
      ['+x', b.max.x, cz, b.max.z - b.min.z], ['-x', b.min.x, cz, b.max.z - b.min.z],
      ['+z', cx, b.max.z, b.max.x - b.min.x], ['-z', cx, b.min.z, b.max.x - b.min.x],
    ];
    for (const [face, px, pz, len] of faces) {
      const n = FACE_NORMAL[face];
      if (px < CUSTOM.bounds.min.x + 0.01 || px > CUSTOM.bounds.max.x - 0.01) continue;
      if (pz < CUSTOM.bounds.min.z + 0.01 || pz > CUSTOM.bounds.max.z - 0.01) continue;
      if (insideAny(px + n[0] * 0.06, y, pz + n[2] * 0.06, b)) continue;
      out.push({
        at: [px, y, pz], face, size: [Math.max(0.3, len - 0.3), 0.12], color,
        intensity: 0, range: 1, kind: 'strip', level: 0.72,
      });
    }
  }
  return out;
}

// Cyan glow band just under the top of each spawn pad's ring marker.
function spawnBeacons(): LightDef[] {
  const out: LightDef[] = [];
  for (const s of CUSTOM.spawns) {
    out.push({
      at: [s.x, 0.35, s.z], face: '+y', size: [2.6, 2.6], color: ACCENT,
      intensity: 0, range: 1, kind: 'strip', level: 0.9,
    });
  }
  return out;
}

const FLOOR_TOP = CUSTOM.boxes[0]?.max.y ?? 0;

export const WORKSHOP: WorldTheme = {
  id: 'workshop',
  textures: TEXTURES,
  openSky: true,
  perimeterTop: 3.2,
  slots: {
    floor: { metalness: 0.1, normalScale: 0.65, ao: 0.6 },
    ceiling: { metalness: 0.05, normalScale: 0.8, ao: 0.75 },
    wall: { metalness: 0.12, normalScale: 0.8, ao: 0.65 },
    cover: { metalness: 0.14, normalScale: 0.8, ao: 0.65 },
    platform: { metalness: 0.12, normalScale: 0.75, ao: 0.75 },
    tower: { metalness: 0.3, normalScale: 0.85, ao: 0.65 },
  },
  slotFor,
  tintFor: (_i, b) => tintFor(b, FLOOR_TOP),
  trim: { color: ACCENT, intensity: 1.15 },
  dress: {
    slot: 'platform', tint: 0xe2e5e8,
    baseboard: { h: 0.4, d: 0.08 },
    pilasters: { spacing: 12, w: 0.6, d: 0.1 },
    bands: [{ y: 10, h: 0.3, d: 0.08 }],
    collars: { h: 0.4, d: 0.1 },
    edges: { h: 0.16, d: 0.03 },
  },
  inlays: paint(),
  lights: [...deckLights(), ...nosing(), ...spawnBeacons(), ...bandLights()],
  bake: {
    ambientUp: 0x8f9aa8, ambientDown: 0x7a828c, ambient: 0.34,
    sky: { color: 0x9fb2d8, intensity: 0.6 },
    ao: { radius: 2.6, strength: 0.8 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.55,
    maxTexels: 120_000,
  },
  sun: { dir: norm([-0.35, 0.85, 0.4]), color: 0xfff2e6, intensity: 2.2, mapScale: 0.85 },
  hemi: { sky: 0xb8c4e0, ground: 0x50565e, intensity: 0.55, mapScale: 0.18 },
  fill: { dir: norm([0.55, 0.3, -0.75]), color: 0x9fd4ff, intensity: 0.45, mapScale: 0.3 },
  env: { intensity: 0.42, mapScale: 0.55 },
  worldSaturation: 0.92,
  satCap: 0.7,
  shadowBox: 90,
  exposure: 1.08,
  fog: { color: 0x0c1016, near: 80, far: 340 },
  background: 0x0a1018,
  sky: {
    mode: 'dusk', top: 0x24325c, mid: 0x4a6090, horizon: 0x8a6a58, ground: 0x181c24,
    sunColor: 0xffd8a8, sunSize: 0.024, sunGlow: 0.75, band: 0.24, stars: 0.4,
  },
};

// Emissive band4 rings around any box tagged 'beacon' (a user-dropped
// glowing pillar toy); harmless if the editor never emits the tag.
function bandLights(): LightDef[] {
  const out: LightDef[] = [];
  for (const b of CUSTOM.boxes) {
    if (b.tag !== 'beacon') continue;
    out.push(...band4(b, Math.max(0.2, b.max.y - 0.4), 0.22, ACCENT, 1.0));
  }
  return out;
}
