// "Custom" arena — the map editor's output, built from serialized editor
// data (localStorage / a share string). The boxes are whatever the user
// authored: a standard shell (floor / cap / perimeter) plus their blocks.
// Spawn points are snapped onto the highest supporting surface like the
// hand-made maps (spawnAt), so the server's spawn fairness checks see the
// same shape. Pure data at module eval (DEFAULT_CUSTOM below) — safe to
// import from server code via arena-map-data.ts.
import { C, shell, spawnAt, type MapBox } from './kit';
import type { AABB, Vec3 } from '../types';
import type { ArenaMap } from '../arena-map-data';

// ── serialized editor format ───────────────────────────────────────────────
// All units metres; the editor snaps to a 0.5 m grid and clamps extents.
// `y` is the block's BASE (underside); the top is at y + h.
export type CustomBlockKind = 'deck' | 'wall' | 'cover' | 'boost' | 'spine' | 'tower' | 'beacon';

export type CustomBlock = {
  id: string;
  x: number; // centre, east–west
  z: number; // centre, north–south
  y: number; // base height above the floor slab's top (0 = grounded)
  w: number; // size along x
  d: number; // size along z
  h: number;
  kind: CustomBlockKind;
};

export type CustomSpawn = { x: number; z: number };

export type CustomMapData = {
  v: 1;
  name: string;
  halfX: number; // play-area half extent along x (bounds derive from these)
  halfZ: number;
  cap: number; // play-volume ceiling (the invisible cap's underside)
  accent?: string; // sRGB '#rrggbb' trim colour
  blocks: CustomBlock[];
  spawns: CustomSpawn[];
};

export const CUSTOM_ACCENT_DEFAULT = '#4fd8ff';

// The editor's "New map" starting point: a small 3v3 practice layout.
export function emptyCustomMap(name = 'Untitled arena'): CustomMapData {
  return {
    v: 1,
    name,
    halfX: 30,
    halfZ: 24,
    cap: 18,
    accent: CUSTOM_ACCENT_DEFAULT,
    blocks: [
      { id: 'b1', kind: 'deck', x: -14, z: 0, y: 2.4, w: 10, d: 10, h: 1 },
      { id: 'b2', kind: 'deck', x: 14, z: 0, y: 2.4, w: 10, d: 10, h: 1 },
      { id: 'b3', kind: 'spine', x: 0, z: 0, y: 5, w: 6, d: 3, h: 0.8 },
      { id: 'b4', kind: 'boost', x: 8, z: 8, y: 0, w: 4, d: 4, h: 4 },
    ],
    spawns: [
      { x: -20, z: 16 },
      { x: 20, z: 16 },
      { x: -20, z: -16 },
      { x: 20, z: -16 },
    ],
  };
}

export const DEFAULT_CUSTOM: CustomMapData = emptyCustomMap('Workshop draft');

const KIND_TAG: Record<CustomBlockKind, string> = {
  deck: 'deck', wall: 'wall', cover: 'cover', boost: 'boost',
  spine: 'spine', tower: 'tower', beacon: 'beacon',
};

function blockToBox(blk: CustomBlock): MapBox {
  const kind = blk.kind;
  if (kind === 'deck') {
    // Decks read as rooms, so they're solid down to the floor: no under-deck
    // tunnel unless another block opens one. Thin (h ≤ 1 m) high decks ride
    // as slabs so they don't bury the space beneath.
    if (blk.h <= 1) return C(blk.x, blk.z, blk.w, blk.d, blk.y, blk.y + blk.h, 'spine');
    return C(blk.x, blk.z, blk.w, blk.d, blk.y, blk.y + blk.h, KIND_TAG.deck);
  }
  return C(blk.x, blk.z, blk.w, blk.d, blk.y, blk.y + blk.h, KIND_TAG[kind]);
}

// Highest box top strictly under `maxY` covering (x,z); the floor otherwise.
function surfaceUnder(boxes: MapBox[], x: number, z: number, bounds: AABB): number {
  let best = boxes[0]?.max.y ?? 0;
  const maxY = bounds.max.y - 2; // ignore the cap
  for (const b of boxes) {
    if (b.tag === 'cap' || b.tag === 'floor') continue;
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
    if (b.max.y > best && b.max.y < maxY) best = b.max.y;
  }
  return best;
}

function clampExtent(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v) || 0));
}

export function sanitizeCustom(data: unknown): CustomMapData {
  const d = (data ?? {}) as Partial<CustomMapData>;
  const blocks: CustomBlock[] = [];
  for (const raw of Array.isArray(d.blocks) ? d.blocks : []) {
    const b = raw as Partial<CustomBlock>;
    const w = Math.max(0.5, Math.min(60, Number(b.w) || 1));
    const dep = Math.max(0.5, Math.min(60, Number(b.d) || 1));
    const h = Math.max(0.4, Math.min(60, Number(b.h) || 1));
    const kind = (KIND_TAG as Record<string, string>)[String(b.kind)] ? (b.kind as CustomBlockKind) : 'cover';
    blocks.push({
      id: String(b.id ?? `b${blocks.length}`),
      x: Number.isFinite(b.x as number) ? (b.x as number) : 0,
      z: Number.isFinite(b.z as number) ? (b.z as number) : 0,
      y: Math.max(0, Number(b.y) || 0),
      w, d: dep, h, kind,
    });
  }
  const spawns: CustomSpawn[] = [];
  for (const raw of Array.isArray(d.spawns) ? d.spawns : []) {
    const s = raw as Partial<CustomSpawn>;
    if (!Number.isFinite(s.x as number) || !Number.isFinite(s.z as number)) continue;
    spawns.push({ x: s.x as number, z: s.z as number });
  }
  const accent = typeof d.accent === 'string' && /^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : CUSTOM_ACCENT_DEFAULT;
  return {
    v: 1,
    name: (typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Untitled arena').slice(0, 40),
    halfX: clampExtent(d.halfX as number, 12, 80),
    halfZ: clampExtent(d.halfZ as number, 12, 80),
    cap: clampExtent(d.cap as number, 9, 60),
    accent,
    blocks,
    spawns: spawns.slice(0, 32),
  };
}

export function buildCustomMap(data: CustomMapData): ArenaMap {
  const hx = clampExtent(data.halfX, 12, 80);
  const hz = clampExtent(data.halfZ, 12, 80);
  const cap = clampExtent(data.cap, 9, 60);
  const { boxes: base, bounds } = shell(hx, hz, cap);
  const boxes: MapBox[] = [...base, ...data.blocks.filter((b) => Number.isFinite(b.x + b.y + b.z)).map(blockToBox)];

  // Snap each spawn onto the highest supporting surface under it.
  const spawns: Vec3[] = data.spawns.slice(0, 32).map((s) => spawnAt(s.x, s.z, surfaceUnder(boxes, s.x, s.z, bounds)));
  if (spawns.length === 0) spawns.push(spawnAt(0, 0));

  const accent = /^#[0-9a-f]{6}$/i.test(data.accent ?? '') ? parseInt((data.accent ?? '').slice(1), 16) : 0x4fd8ff;

  return {
    name: data.name || 'Custom arena',
    boxes,
    spawns,
    spawn: spawns[0],
    bounds,
    accent,
    // Open-air arena: the cap still collides but the sky shows.
    openTop: true,
  };
}

// ── live registry slot ─────────────────────────────────────────────────────
// A single mutable ArenaMap object the registry (arena-map-data.ts) points
// at. `setCustomMap` overwrites its fields in place — the object identity is
// stable, so the registry never needs mutation, and Game.setMap's
// `map === this.map` guard only rejects a no-op rebuild. Callers must bust
// the engine's bake cache (map.ts invalidateMapBake) after swapping.
export const CUSTOM: ArenaMap = buildCustomMap(DEFAULT_CUSTOM);

export function setCustomMap(data: CustomMapData): void {
  const next = buildCustomMap(sanitizeCustom(data));
  CUSTOM.name = next.name;
  CUSTOM.boxes = next.boxes;
  CUSTOM.spawns = next.spawns;
  CUSTOM.spawn = next.spawn;
  CUSTOM.bounds = next.bounds;
  CUSTOM.accent = next.accent;
}
