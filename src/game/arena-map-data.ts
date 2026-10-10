// Shared collision geometry + the map registry. Pure data: safe to import on
// the game server. Each arena lives in its own module under ./maps/ (built
// with the helpers in ./maps/kit.ts); its look (materials, lights, sky) lives
// in ./world/looks/<id>.ts.
import type { AABB, Vec3 } from './types';
import type { MapBox } from './maps/kit';
import { CAUSEWAY } from './maps/causeway';
import { CONTAINERYARD } from './maps/containeryard';
import { CUSTOM, DEFAULT_CUSTOM, setCustomMap, type CustomMapData } from './maps/custom';
import { DERRICK } from './maps/derrick';
import { LOUNGE } from './maps/lounge';
import { NUKETOWN } from './maps/nuketown';
import { REACTOR } from './maps/reactor';
import { TRAINING } from './maps/training';

export type { MapBox };
export type { CustomMapData, CustomBlock, CustomBlockKind } from './maps/custom';

export type ArenaMap = {
  name: string;
  boxes: MapBox[];
  // Offline start position (solo vs bots / practice). Online spawns come
  // from `spawns` (arena-data.ts reads them for the server).
  spawn: Vec3;
  // Hand-placed spawn points: open, standing room (y = surface top + 0.05),
  // spread over the map so the server's pickSpawn always has a safe choice.
  spawns: Vec3[];
  bounds: AABB;
  // Open-air arena: the ceiling box (index 1) still collides but isn't drawn,
  // so the skybox shows. Use with tall perimeter walls + a high invisible cap.
  openTop?: boolean;
  // Emissive edge-light colour (trim bars on platforms + cover). Defaults to
  // the brand cyan.
  accent?: number;
};

export { CAUSEWAY, CONTAINERYARD, CUSTOM, DEFAULT_CUSTOM, DERRICK, LOUNGE, NUKETOWN, REACTOR, TRAINING };

// Selectable map registry — the competitive pool plus the single-player
// practice range. The large maps carry FFA/TDM; the duel maps carry 1v1.
// 'custom' (the map editor's output) is last: offline-only by convention —
// it is not in either online pool below, so matchmaking never rolls it.
export const MAPS: ReadonlyArray<{ id: string; label: string; map: ArenaMap }> = [
  // larger FFA / TDM maps
  { id: 'causeway', label: 'Causeway (FFA/TDM)', map: CAUSEWAY },
  { id: 'reactor', label: 'Reactor (FFA/TDM)', map: REACTOR },
  { id: 'lounge', label: 'Lounge (FFA/TDM)', map: LOUNGE },
  { id: 'nuketown', label: 'Nuketown (FFA/TDM)', map: NUKETOWN },
  // 1v1 duel maps
  { id: 'containeryard', label: 'Container Yard (1v1)', map: CONTAINERYARD },
  { id: 'derrick', label: 'Derrick (1v1)', map: DERRICK },
  // practice
  { id: 'training', label: 'Training Range', map: TRAINING },
  // the map editor's workspace (offline solo/bots only)
  { id: 'custom', label: 'Custom Map (Workshop)', map: CUSTOM },
];

export const DEFAULT_MAP: ArenaMap = CAUSEWAY;

// The editor state behind the 'custom' registry entry.
let customMapState: CustomMapData = DEFAULT_CUSTOM;

export function customMapData(): CustomMapData {
  return customMapState;
}

// Point the whole pipeline (registry entry + the data snapshot) at new
// editor content. PURE data: the caller (the editor, on the client) must
// bust the engine's per-map bake cache (invalidateMapBake in map.ts) after
// calling this, and pass the rebuilt ArenaMap to Game.setMap.
export function installCustomMap(data: CustomMapData, rebuild: (data: CustomMapData) => void = setCustomMap): void {
  customMapState = data;
  rebuild(data);
}

export function mapById(id: string): ArenaMap {
  return MAPS.find((m) => m.id === id)?.map ?? DEFAULT_MAP;
}
