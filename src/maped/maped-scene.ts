// Map editor 3D engine ("MapLab"). A lean Three.js harness around the game's
// own builders so the editor renders the map EXACTLY as a match will:
// createRenderer / createScene (src/game/renderer.ts) for the pipeline and
// buildMapMesh + applyMapShadowFlags (src/game/map.ts) for the arena. Edited
// geometry is displayed as live wireframe boxes + translucent solid previews
// on top; "Test" installs the blocks into the 'custom' registry entry and the
// same buildMapMesh path the game uses renders the real thing.
//
// Orbit + pan + zoom camera (no pointer lock — this is a design tool), WASD
// fly-to-cursor optional. All interaction state lives in React; this module
// only draws and answers raycasts.

import * as THREE from 'three';
import { createRenderer, createScene } from '../game/renderer';
import { buildMapMesh, type ArenaMap } from '../game/map';
import { applyMapShadowFlags } from '../game/renderer';
import type { CustomBlock } from './maped-data';
import { blockToAabb } from './maped-data';

const ACCENT = 0x4fd8ff;
const HOVER = 0x7fe8ff;
const SELECT = 0xffc45e;

const KIND_COLOR: Record<CustomBlock['kind'], number> = {
  deck: 0x64c8b4,
  wall: 0x8a7cc8,
  cover: 0xd8a04a,
  boost: 0x40d0c0,
  spine: 0x6aa8e8,
  tower: 0xc86ac8,
  beacon: 0xffe066,
};

class EditMats {
  readonly solid = new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 0.55, metalness: 0.05 });
  readonly edge = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65 });
  dispose() {
    this.solid.dispose();
    this.edge.dispose();
  }
}

// One box's visual group: solid preview + 12-edge outline.
type BoxViz = {
  group: THREE.Group;
  solid: THREE.Mesh;
  edges: THREE.LineSegments;
};

function makeBoxViz(mats: EditMats, color: number): BoxViz {
  const group = new THREE.Group();
  const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats.solid.clone());
  (solid.material as THREE.MeshStandardMaterial).color = new THREE.Color(color);
  (solid.material as THREE.MeshStandardMaterial).transparent = true;
  (solid.material as THREE.MeshStandardMaterial).opacity = 0.42;
  (solid.material as THREE.MeshStandardMaterial).depthWrite = false;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), mats.edge.clone());
  (edges.material as THREE.LineBasicMaterial).color = new THREE.Color(color);
  group.add(solid, edges);
  return { group, solid, edges };
}

export type PickHit = { id: string; faceNormal: THREE.Vector3; point: THREE.Vector3 };

export class MapEdScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mats = new EditMats();
  private arenaMesh: THREE.Group | null = null;
  private readonly vizRoot = new THREE.Group();
  private readonly viz = new Map<string, BoxViz>();
  private readonly grid: THREE.GridHelper; // floor grid at y=0
  private readonly boundsBox: THREE.LineSegments | null = null;
  private readonly preview: BoxViz;
  private readonly spawnMarkers = new THREE.Group();
  private raf = 0;
  private disposed = false;
  private last = 0;
  private dirty = true; // render only on change (idle editor = idle GPU)

  // Orbit state (set by the React layer).
  camTarget = new THREE.Vector3(0, 1, 0);
  camDist = 46;
  camYaw = Math.PI * 0.75;
  camPitch = 0.62;
  showGrid = true;

  // Current workspace map (registry 'custom' entry), for raycast targets and
  // block spawning. React sets this after each install.
  arena: ArenaMap | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = createRenderer(canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.scene = createScene(this.renderer);
    // Editor ambience: neutral blue-grey ground, no fog, soft sky tone.
    this.scene.background = new THREE.Color(0x141a22);
    this.scene.fog = null;

    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1200);
    this.scene.add(this.camera);

    // Floor plate under the arena (a place for the shadow to land).
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x1a2029, roughness: 0.95, metalness: 0 }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.02;
    plate.receiveShadow = true;
    this.scene.add(plate);

    this.grid = new THREE.GridHelper(120, 60, 0x3a4a5e, 0x243140);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);

    // Bounds cage (rebuilt on install).
    const cage = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x6a7686, transparent: true, opacity: 0.3 }),
    );
    this.boundsBox = cage;
    this.scene.add(cage);

    this.preview = makeBoxViz(this.mats, HOVER);
    this.preview.group.visible = false;
    this.scene.add(this.preview.group);

    this.scene.add(this.vizRoot);
    this.scene.add(this.spawnMarkers);
    this.resize();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  start() {
    if (this.raf || this.disposed) return;
    this.last = performance.now();
    const tick = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      // Long-input smoothing handled by the caller; here just breathe the
      // camera toward its orbit pose and render when anything changed.
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.updateCamera(dt);
      if (this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.viz.clear();
    this.mats.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.boundsBox?.geometry.dispose();
    if (this.boundsBox) (this.boundsBox.material as THREE.Material).dispose();
    this.preview.solid.geometry.dispose();
    this.preview.edges.geometry.dispose();
    if (this.arenaMesh) {
      this.scene.remove(this.arenaMesh);
      applyMapShadowFlags(this.arenaMesh, this.arena!);
      arenaDispose(this.arenaMesh);
      this.arenaMesh = null;
    }
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const m = mesh.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      }
    });
    this.renderer.dispose();
  }

  invalidate() {
    this.dirty = true;
  }

  // ── arena install (Test mode) ──────────────────────────────────────────
  setArena(map: ArenaMap) {
    if (this.arenaMesh) {
      this.scene.remove(this.arenaMesh);
      arenaDispose(this.arenaMesh);
      this.arenaMesh = null;
    }
    this.arena = map;
    const mesh = buildMapMesh(map);
    applyMapShadowFlags(mesh, map);
    this.scene.add(mesh);
    this.arenaMesh = mesh;
    this.dirty = true;
  }

  hideArena(hide: boolean) {
    if (this.arenaMesh) this.arenaMesh.visible = !hide;
    this.dirty = true;
  }

  // ── boxes ─────────────────────────────────────────────────────────────
  syncBoxes(blocks: CustomBlock[], selectedId: string | null, hoverId: string | null) {
    const seen = new Set<string>();
    for (const b of blocks) {
      seen.add(b.id);
      let v = this.viz.get(b.id);
      if (!v) {
        v = makeBoxViz(this.mats, KIND_COLOR[b.kind] ?? 0xffffff);
        this.viz.set(b.id, v);
        this.vizRoot.add(v.group);
      }
      const aabb = blockToAabb(b);
      const cx = (aabb.min.x + aabb.max.x) / 2;
      const cy = (aabb.min.y + aabb.max.y) / 2;
      const cz = (aabb.min.z + aabb.max.z) / 2;
      const sx = Math.max(0.05, aabb.max.x - aabb.min.x);
      const sy = Math.max(0.05, aabb.max.y - aabb.min.y);
      const sz = Math.max(0.05, aabb.max.z - aabb.min.z);
      v.group.position.set(cx, cy, cz);
      v.group.scale.set(sx, sy, sz);
      const selected = b.id === selectedId;
      const hovered = b.id === hoverId;
      const sm = v.solid.material as THREE.MeshStandardMaterial;
      sm.color = new THREE.Color(KIND_COLOR[b.kind] ?? 0xffffff);
      sm.opacity = selected ? 0.62 : hovered ? 0.55 : 0.35;
      const em = v.edges.material as THREE.LineBasicMaterial;
      em.color = new THREE.Color(selected ? SELECT : hovered ? HOVER : 0xffffff);
      em.opacity = selected ? 1 : hovered ? 0.9 : 0.55;
    }
    for (const [id, v] of this.viz) {
      if (seen.has(id)) continue;
      this.vizRoot.remove(v.group);
      v.solid.geometry.dispose();
      v.edges.geometry.dispose();
      (v.solid.material as THREE.Material).dispose();
      (v.edges.material as THREE.Material).dispose();
      this.viz.delete(id);
    }
    this.dirty = true;
  }

  syncSpawns(spawns: { x: number; z: number }[]) {
    this.spawnMarkers.clear();
    for (const s of spawns) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.1, 28),
        new THREE.MeshBasicMaterial({ color: ACCENT, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, 0.06, s.z);
      this.spawnMarkers.add(ring);
    }
    this.dirty = true;
  }

  showPreview(show: boolean, at?: { x: number; y: number; z: number }, size?: { w: number; d: number; h: number }, kind?: CustomBlock['kind']) {
    if (!show || !at || !size) {
      this.preview.group.visible = false;
      this.dirty = true;
      return;
    }
    this.preview.group.visible = true;
    const color = KIND_COLOR[kind ?? 'cover'];
    const sm = this.preview.solid.material as THREE.MeshStandardMaterial;
    sm.color = new THREE.Color(color);
    sm.opacity = 0.3;
    const em = this.preview.edges.material as THREE.LineBasicMaterial;
    em.color = new THREE.Color(HOVER);
    em.opacity = 0.95;
    this.preview.group.position.set(at.x, at.y + size.h / 2, at.z);
    this.preview.group.scale.set(Math.max(0.05, size.w), Math.max(0.05, size.h), Math.max(0.05, size.d));
    this.dirty = true;
  }

  setShowGrid(on: boolean) {
    this.showGrid = on;
    this.grid.visible = on;
    this.dirty = true;
  }

  updateBoundsCage(map: ArenaMap | null) {
    if (!this.boundsBox || !map) return;
    const b = map.bounds;
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    this.boundsBox.scale.set(sx, sy, sz);
    this.boundsBox.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    this.dirty = true;
  }

  // ── camera ───────────────────────────────────────────────────────────
  private updateCamera(_dt: number) {
    const cp = Math.max(-1.4, Math.min(1.45, this.camPitch));
    const y = this.camTarget.y + this.camDist * Math.sin(cp);
    const r = this.camDist * Math.cos(cp);
    this.camera.position.set(
      this.camTarget.x + Math.sin(this.camYaw) * r,
      Math.max(0.8, y),
      this.camTarget.z + Math.cos(this.camYaw) * r,
    );
    this.camera.lookAt(this.camTarget.x, Math.max(0.2, this.camTarget.y), this.camTarget.z);
    this.dirty = true;
  }

  // ── picking ──────────────────────────────────────────────────────────
  // Nearest viz box under the cursor (or null). Uses the meshes themselves.
  pickBox(clientX: number, clientY: number): { id: string; point: THREE.Vector3 } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes: THREE.Mesh[] = [];
    const ids: string[] = [];
    for (const [id, v] of this.viz) {
      meshes.push(v.solid);
      ids.push(id);
    }
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const id = ids[meshes.indexOf(hit.object as THREE.Mesh)] ?? null;
    if (!id) return null;
    return { id, point: hit.point.clone() };
  }

  // World point on the ground plane (or any arena surface) under the cursor.
  groundPoint(clientX: number, clientY: number, fallbackY = 0): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    // The arena already installed + visual boxes: use their drawn geometry.
    if (this.arenaMesh) {
      const hits = this.raycaster.intersectObject(this.arenaMesh, true);
      if (hits.length > 0) return hits[0].point.clone();
    }
    const vizMeshes = [...this.viz.values()].map((v) => v.solid);
    if (vizMeshes.length) {
      const hits = this.raycaster.intersectObjects(vizMeshes, false);
      if (hits.length > 0) return hits[0].point.clone();
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -fallbackY);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }
}

function arenaDispose(group: THREE.Object3D) {
  const geoms = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geoms.add(mesh.geometry);
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => mats.add(m));
    else if (mat) mats.add(mat);
  });
  geoms.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
}
