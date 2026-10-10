// Map editor data model — pure, no three.js. Blocks are axis-aligned boxes
// snapped to a 0.5 m grid; the editor state (React) owns the CustomMapData
// and talks to the engine scene only through ids + serialized snapshots.
// Symmetry helpers mirror edits across the x = 0 plane so a map can stay
// duel-fair by construction. Validation reuses the shape of scripts/map-check.

import type { AABB } from '../game/types';
import {
  sanitizeCustom,
  emptyCustomMap,
  type CustomBlock,
  type CustomBlockKind,
  type CustomMapData,
} from '../game/maps/custom';

export type { CustomBlock, CustomBlockKind, CustomMapData };
export { emptyCustomMap, sanitizeCustom };

const SNAP = 0.5;

export function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

export function blockToAabb(b: CustomBlock): AABB {
  const x0 = snap(b.x - b.w / 2);
  const x1 = snap(b.x + b.w / 2);
  const z0 = snap(b.z - b.d / 2);
  const z1 = snap(b.z + b.d / 2);
  const y0 = snap(b.y);
  const y1 = snap(b.y + b.h);
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}

// Mirror a block across x = 0 (position flips, size stays).
export function mirrorBlock(b: CustomBlock): CustomBlock {
  return { ...b, id: `${b.id}m`, x: -b.x };
}

// Add the mirror of every (target-side) block to the map. `side` filters:
// 'x+' mirrors blocks with centre x > 0 into x < 0 (and vice versa by
// symmetry of the operation), 'all' mirrors everything including centre
// blocks onto themselves (no-op when x === 0 exactly).
export function applySymmetryX(data: CustomMapData): CustomMapData {
  const blocks: CustomBlock[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const b of data.blocks) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      blocks.push(b);
    }
    if (Math.abs(snap(b.x)) > 0.01) {
      const m = mirrorBlock(b);
      while (seen.has(m.id)) m.id = `${b.id}m${n++}`;
      seen.add(m.id);
      blocks.push(m);
    }
  }
  return { ...data, blocks };
}

// ── validation ─────────────────────────────────────────────────────────────
export type EditIssue = { level: 'error' | 'warn'; text: string };

export function validateMap(data: CustomMapData): EditIssue[] {
  const out: EditIssue[] = [];
  const b = data;
  if (b.cap < 10) out.push({ level: 'warn', text: 'Low ceiling: apex jumps (double jump ≈ 3.2 m, boost ≈ 8 m) need headroom.' });
  if (b.blocks.length > 220) out.push({ level: 'warn', text: `${b.blocks.length} blocks — big maps bake slower and can confuse reads.` });

  // Spawns: count + inside bounds + not merged inside a block.
  const bounds = { minX: -b.halfX, maxX: b.halfX, minZ: -b.halfZ, maxZ: b.halfZ };
  if (b.spawns.length < 4) out.push({ level: 'error', text: `Only ${b.spawns.length} spawn point(s) — 4+ spreads the fight.` });
  if (b.spawns.length > 32) out.push({ level: 'error', text: `${b.spawns.length} spawns is over the cap (32).` });
  const spawns = [...b.spawns];
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i];
    if (Math.abs(s.x) > b.halfX - 1 || Math.abs(s.z) > b.halfZ - 1) {
      out.push({ level: 'error', text: `Spawn ${i + 1} lies outside the play area.` });
    }
  }
  // Spread: an SV spawn jitter is ±0.5 m, so two spawns within 1 m of each
  // other can overlap after a jitter.
  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      const d = Math.hypot(spawns[i].x - spawns[j].x, spawns[i].z - spawns[j].z);
      if (d < 3) out.push({ level: 'warn', text: `Spawns ${i + 1} and ${j + 1} are only ${d.toFixed(1)} m apart.` });
    }
  }

  // Blocks: inside bounds; touching the floor; not silently inside another.
  for (const blk of b.blocks) {
    const a = blockToAabb(blk);
    if (a.min.x < bounds.minX - 0.01 || a.max.x > bounds.maxX + 0.01 ||
        a.min.z < bounds.minZ - 0.01 || a.max.z > bounds.maxZ + 0.01) {
      out.push({ level: 'warn', text: `A ${blk.kind} block pokes past the play-area walls.` });
      break;
    }
  }
  // Cover-heights sanity: nothing thinner than 0.4 m.
  for (const blk of b.blocks) {
    if (blk.kind === 'beacon') continue;
    if (blk.h < 0.4 && blk.kind !== 'deck') {
      out.push({ level: 'warn', text: `A ${blk.kind} is under 0.4 m tall — too thin to stand on.` });
      break;
    }
  }
  // Quick reach-hint: are any decks > 4.5 m above the surface below them
  // (needs a boost or a stair from something else)?
  let boosts = 0;
  for (const blk of b.blocks) if (blk.kind === 'boost') boosts++;
  const decks = b.blocks.filter((x) => x.kind === 'deck' || x.kind === 'tower');
  for (const d of decks) {
    const floorY = 0;
    if (d.y - floorY > 4.6 && boosts === 0) {
      out.push({ level: 'warn', text: `A deck tops out ${d.y.toFixed(1)} m up with no boost tower on the map — likely unreachable.` });
      break;
    }
  }
  return out;
}

// True when the two blocks overlap in x/z AND y (needed for the bury-check).
export function overlapXY(a: AABB, b: AABB): boolean {
  return (
    a.min.x < b.max.x && a.max.x > b.min.x &&
    a.min.z < b.max.z && a.max.z > b.min.z &&
    a.min.y < b.max.y && a.max.y > b.min.y
  );
}

// Does the player capsule (r 0.4, height 1.8) at (x, z) have any place to
// stand at or under y? For spawn placement: require the surface below to be
// within 3 m of the spawn's own y.
export function capsuleBlocked(data: CustomMapData, x: number, z: number): boolean {
  for (const blk of data.blocks) {
    const a = blockToAabb(blk);
    if (x > a.min.x - 0.4 && x < a.max.x + 0.4 && z > a.min.z - 0.4 && z < a.max.z + 0.4) {
      if (blk.y < 1.9) return true; // something tall enough to collide occupies this plan cell
    }
  }
  return false;
}

// A default name that never collides (v2, v3, …).
export function nextBlockId(data: CustomMapData): string {
  let n = data.blocks.length + 1;
  let id = `b${n}`;
  while (data.blocks.some((b) => b.id === id)) id = `b${++n}`;
  return id;
}
