// MapLab — the in-browser map editor, mounted at /maplab.
//
// Left: the 3D workspace (the real renderer + arena build pipeline). Right:
// the drafting panel (block palette, block list, selected block props,
// spawn tools, settings). Bottom-left: live validation from maped-data
// (same rules family as scripts/map-check).
//
// Workflow: place blocks → dial them in → Test (installs into the 'custom'
// registry entry and rebuilds the arena mesh in place) → Play (a solo-vs-bots
// MatchConfig { mode: 'local', mapId: 'custom' } that the app's InstagibClient
// owns; the editor mounts standalone via /maplab, so Play links out).
// Persisted to localStorage on every edit; share strings round-trip the same
// data (deflate + base64url, matching the replay-codec style).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UtilButton } from '../deck';
import { toast } from '../deck-core';
import { installCustomMap, MAPS, customMapData, type CustomMapData } from '../game/arena-map-data';
import { CUSTOM_ACCENT_DEFAULT, emptyCustomMap, sanitizeCustom } from '../game/maps/custom';
import type { CustomBlock, CustomBlockKind } from '../game/maps/custom';
import {
  applySymmetryX,
  blockToAabb,
  nextBlockId,
  snap,
  validateMap,
  type EditIssue,
} from './maped-data';
import { MapEdScene } from './maped-scene';
import './maped.css';

const PLAY_LINK = '/play?editor=1';

const KINDS: Array<{ id: CustomBlockKind; label: string; blurb: string }> = [
  { id: 'deck', label: 'Deck', blurb: 'A fighting platform: the terrain you fight over. Deep decks ground to the floor.' },
  { id: 'wall', label: 'Wall', blurb: 'Tall sightline breaker. Full-height silhouettes make zones readable.' },
  { id: 'cover', label: 'Cover', blurb: 'Waist-height block. Breaks rail lanes on every tier.' },
  { id: 'boost', label: 'Boost pad', blurb: 'A tall block the boost can be played off (≈ 7.5 m reach).' },
  { id: 'spine', label: 'Bridge', blurb: 'A thin elevated walkway connecting decks.' },
  { id: 'tower', label: 'Tower', blurb: 'Sky-high perches are strong but must be answerable.' },
  { id: 'beacon', label: 'Beacon', blurb: 'Decorative glowing pillar (no gameplay effect).' },
];

const KIND_ORDER: CustomBlockKind[] = [
  'deck', 'wall', 'cover', 'boost', 'spine', 'tower', 'beacon',
];

const KIND_HEX: Record<CustomBlockKind, string> = {
  deck: '#64c8b4',
  wall: '#8a7cc8',
  cover: '#d8a04a',
  boost: '#40d0c0',
  spine: '#6aa8e8',
  tower: '#c86ac8',
  beacon: '#ffe066',
};

const STORAGE_KEY = 'instagib-maplab-v1';

function loadDraft(): CustomMapData | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizeCustom(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveDraft(data: CustomMapData) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota — ignore */
  }
}

// ── number field ──────────────────────────────────────────────────────────
function NumField({
  label, value, onChange, step = 1, min, max, suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <label className='me-field'>
      <span className='me-field-label'>{label}</span>
      <span className='me-field-input'>
        <input
          type='number'
          value={Number.isFinite(value) ? value : 0}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
        />
        {suffix && <span className='me-field-suffix'>{suffix}</span>}
      </span>
    </label>
  );
}

function TabRow<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className='me-tabs' role='tablist'>
      {options.map((o) => (
        <button
          key={o.id}
          type='button'
          role='tab'
          aria-selected={o.id === value}
          className={`me-tab ${o.id === value ? 'me-tab-on' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function MapLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MapEdScene | null>(null);
  const [tab, setTab] = useState<'blocks' | 'arena' | 'spawns'>('blocks');
  const [data, setData] = useState<CustomMapData>(() => customMapData() ?? loadDraft() ?? emptyCustomMap());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tool, setTool] = useState<CustomBlockKind>('cover');
  const [rendered, setRendered] = useState(false); // arena mesh installed at least once
  const [testMode, setTestMode] = useState(false); // arena mesh supersedes viz boxes
  const [issues, setIssues] = useState<EditIssue[]>([]);
  const [showGrid, setShowGrid] = useState(true);

  const dataRef = useRef(data);
  dataRef.current = data;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const hoverRef = useRef(hoverId);
  hoverRef.current = hoverId;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // One-shot: boot the scene.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sc = new MapEdScene(canvas);
    sceneRef.current = sc;
    const onResize = () => sc.resize();
    window.addEventListener('resize', onResize);
    sc.start();
    // Initial install (so the arena shell is visible behind the grid).
    installDraft(dataRef.current);
    function installDraft(d: CustomMapData) {
      installCustomMap(d);
      sc.setArena(MAPS.find((m) => m.id === 'custom')!.map);
      sc.updateBoundsCage(MAPS.find((m) => m.id === 'custom')!.map);
      sc.syncBoxes(d.blocks, selectedRef.current, null);
      sc.syncSpawns(d.spawns);
      setRendered(true);
    }
    (window as unknown as { __maplab?: unknown }).__maplab = { scene: sc };
    return () => {
      window.removeEventListener('resize', onResize);
      sc.stop();
      sc.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Re-validate + persist on every data change.
  useEffect(() => {
    setIssues(validateMap(data));
    saveDraft(data);
  }, [data]);

  // Push edits into the 3D viz.
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc) return;
    sc.syncBoxes(data.blocks, selectedId, hoverId);
    sc.syncSpawns(data.spawns);
  }, [data.blocks, data.spawns, selectedId, hoverId, rendered]);

  // Grid toggle + bounds cage.
  useEffect(() => {
    sceneRef.current?.setShowGrid(showGrid);
  }, [showGrid]);

  // ── editing actions ──────────────────────────────────────────────────
  const mutate = useCallback((fn: (d: CustomMapData) => CustomMapData) => {
    setData((d) => fn(d));
  }, []);

  const addBlockAt = useCallback((x: number, y: number, z: number, kind: CustomBlockKind) => {
    let newId = '';
    mutate((d) => {
      newId = nextBlockId(d);
      const size = kind === 'wall' ? { w: 8, d: 1.5, h: 5 } : kind === 'tower' ? { w: 3, d: 3, h: 10 } : kind === 'boost' ? { w: 4, d: 4, h: 4 } : kind === 'spine' ? { w: 8, d: 2.5, h: 0.8 } : kind === 'beacon' ? { w: 0.8, d: 0.8, h: 6 } : { w: 4, d: 4, h: 1.4 };
      const y0 = Math.max(0, snap(y));
      return {
        ...d,
        blocks: [...d.blocks, {
          id: newId,
          x: snap(x), y: y0, z: snap(z),
          w: size.w, d: size.d, h: size.h,
          kind,
        }],
      };
    });
    if (newId) setSelectedId(newId);
  }, [mutate]);

  const updateBlock = useCallback((id: string, patch: Partial<CustomBlock>) => {
    mutate((d) => ({
      ...d,
      blocks: d.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    }));
  }, [mutate]);

  const deleteBlock = useCallback((id: string) => {
    mutate((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }));
    setSelectedId((s) => (s === id ? null : s));
  }, [mutate]);

  const duplicateBlock = useCallback((id: string) => {
    let nid = '';
    mutate((d) => {
      const src = d.blocks.find((b) => b.id === id);
      if (!src) return d;
      nid = nextBlockId(d);
      return { ...d, blocks: [...d.blocks, { ...src, id: nid, x: snap(src.x + 2) }] };
    });
    if (nid) setSelectedId(nid);
  }, [mutate]);

  const applySymmetry = useCallback(() => {
    mutate((d) => ({ ...applySymmetryX(d) }));
    toast('Mirrored across the centre');
  }, [mutate]);

  // ── pointer interactions on the workspace ────────────────────────────
  useEffect(() => {
    const sc = sceneRef.current;
    const canvas = canvasRef.current;
    if (!sc || !canvas) return;
    let dragMode: null | { start: { x: number; y: number }; dist: number } = null;

    const onPointerMove = (e: PointerEvent) => {
      if (dragMode) {
        const dx = e.clientX - dragMode.start.x;
        const dy = e.clientY - dragMode.start.y;
        sc.camYaw -= dx * 0.006;
        sc.camPitch = Math.max(-1.3, Math.min(1.42, sc.camPitch + dy * 0.004));
        dragMode.dist += Math.abs(dx) + Math.abs(dy);
        sc.camTarget.x = Math.max(-200, Math.min(200, sc.camTarget.x));
        return;
      }
      if (testMode) return; // the arena is live; no block picking
      const hit = sc.pickBox(e.clientX, e.clientY);
      const id = hit?.id ?? null;
      if (id !== hoverRef.current) {
        setHoverId(id);
      }
      if (!hit || !toolRef.current) {
        sc.showPreview(false);
        return;
      }
      // Ghost preview: new block stacked at the hover point snapped to grid.
      const p = hit.point;
      const gx = snap(p.x);
      const gz = snap(p.z);
      const top = Math.round(p.y * 2) / 2;
      sc.showPreview(true, { x: gx, y: top, z: gz },
        toolRef.current === 'wall' ? { w: 8, d: 1.5, h: 5 } : toolRef.current === 'tower' ? { w: 3, d: 3, h: 10 } : toolRef.current === 'boost' ? { w: 4, d: 4, h: 4 } : toolRef.current === 'spine' ? { w: 8, d: 2.5, h: 0.8 } : toolRef.current === 'beacon' ? { w: 0.8, d: 0.8, h: 6 } : { w: 4, d: 4, h: 1.4 },
        toolRef.current);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('[data-no-orbit]')) return; // UI overlay
      dragMode = { start: { x: e.clientX, y: e.clientY }, dist: 0 };
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragMode) return;
      const moved = dragMode.dist;
      dragMode = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* released */ }
      if (moved > 6) return; // an orbit drag, not a click
      // Click.
      if (testMode) return;
      const gx = e.clientX, gy = e.clientY;
      const hit = sc.pickBox(gx, gy);
      if (hit) {
        setSelectedId(hit.id);
        return;
      }
      // Empty space with an active tool → drop a block at the ground point
      // using the arena surface under the cursor (or the floor plate).
      const g = sc.groundPoint(gx, gy);
      if (g && toolRef.current) {
        addBlockAt(g.x, Math.max(0, snap(g.y)), g.z, toolRef.current);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      sc.camDist = Math.max(6, Math.min(220, sc.camDist * (1 + Math.sign(e.deltaY) * 0.09)));
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [addBlockAt, testMode]);

  // Re-center the orbit on the select.
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc || !selectedId) return;
    const b = data.blocks.find((x) => x.id === selectedId);
    if (!b) return;
    const a = blockToAabb(b);
    sc.camTarget.set((a.min.x + a.max.x) / 2, a.max.y, (a.min.z + a.max.z) / 2);
  }, [selectedId, data.blocks]);

  // ── Test + Play ──────────────────────────────────────────────────────
  const runTest = useCallback(() => {
    const d = sanitizeCustom(dataRef.current);
    setData(d);
    installCustomMap(d);
    const arena = MAPS.find((m) => m.id === 'custom')!.map;
    sceneRef.current?.setArena(arena);
    sceneRef.current?.updateBoundsCage(arena);
    sceneRef.current?.hideArena(false);
    sceneRef.current?.syncBoxes(d.blocks, null, null);
    setRendered(true);
    setTestMode(true);
    toast(`Test build: ${arena.boxes.length} collision boxes`, { tone: 'ok' });
  }, []);

  const backToEdit = useCallback(() => {
    setTestMode(false);
    sceneRef.current?.hideArena(true);
  }, []);

  const selected = useMemo(() => data.blocks.find((b) => b.id === selectedId) ?? null, [data.blocks, selectedId]);
  const errs = issues.filter((i) => i.level === 'error');

  return (
    <div className='menu-root fixed inset-0 z-50 flex text-white'>
      {/* ── Workspace ──────────────────────────────────────────────────── */}
      <div className='relative min-w-0 flex-1'>
        <canvas ref={canvasRef} className='absolute inset-0 h-full w-full' />

        {/* Floating top bar */}
        <div className='pointer-events-none absolute left-0 right-0 top-0 flex items-start justify-between gap-4 p-4'>
          <div data-no-orbit className='clip-deck-sm pointer-events-auto inline-flex items-center gap-3 border border-white/10 bg-black/55 px-3 py-2'>
            <span className='font-display text-[15px] font-bold uppercase tracking-[0.08em]'>
              MapLab
            </span>
            <span className='max-w-[16rem] truncate font-mono text-[11px] text-white/45'>
              {data.name}
            </span>
            {testMode && <span className='me-chip me-chip-ok'>test</span>}
          </div>
          <div data-no-orbit className='pointer-events-auto flex items-center gap-2'>
            {testMode ? (
              <UtilButton onClick={backToEdit}>Back to edit</UtilButton>
            ) : (
              <UtilButton onClick={runTest} tone='cyan' disabled={errs.length > 0} title={errs.length ? 'Fix the errors in the panel first' : undefined}>
                Test build
              </UtilButton>
            )}
            <a href={PLAY_LINK} {...{ onClickCapture: undefined }} className='me-play' title='Playtest offline vs bots (opens /play in editor mode)'>
              Playtest ▸
            </a>
          </div>
        </div>

        {/* Bottom-left hints */}
        <div data-no-orbit className='pointer-events-none absolute bottom-3 left-3 max-w-[19rem] font-mono text-[10.5px] leading-relaxed text-white/40'>
          {testMode
            ? 'Testing the collision + lighting exactly as a match sees it. "Back to edit" resumes drafting.'
            : 'Drag to orbit · wheel to zoom · click a block to select · pick a block from the palette and click empty space to place it.'}
        </div>

        {/* Live issues */}
        {issues.length > 0 && (
          <div data-no-orbit className='pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2'>
            <div className={`clip-deck-sm border px-3 py-2 font-mono text-[11px] ${errs.length ? 'border-rose-400/50 bg-rose-950/70 text-rose-100' : 'border-amber-400/40 bg-amber-950/60 text-amber-100'}`}>
              {issues[0].level === 'error' ? '✕ ' : '! '}
              {issues[0].text}
              {issues.length > 1 && <span className='ml-2 opacity-60'>+{issues.length - 1}</span>}
            </div>
          </div>
        )}
      </div>

      {/* ── The drafting panel ─────────────────────────────────────────── */}
      <aside data-no-orbit className='me-panel flex w-[21rem] shrink-0 flex-col'>
        <TabRow
          value={tab}
          options={[{ id: 'blocks', label: 'Blocks' }, { id: 'arena', label: 'Arena' }, { id: 'spawns', label: 'Spawns' }]}
          onChange={setTab}
        />

        <div className='deck-scroll me-body min-h-0 flex-1 overflow-y-auto'>
          {tab === 'blocks' && (
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-2'>
                <span className='me-h'>Palette</span>
                <div className='me-palette'>
                  {KINDS.map((k) => (
                    <button
                      key={k.id}
                      type='button'
                      title={k.blurb}
                      aria-pressed={tool === k.id}
                      className={`me-kind ${tool === k.id ? 'me-kind-on' : ''}`}
                      onClick={() => setTool(k.id)}
                    >
                      <span className='me-kind-swatch' style={{ background: KIND_HEX[k.id] }} aria-hidden='true' />
                      {k.label}
                    </button>
                  ))}
                </div>
                <span className='me-blurb'>{KINDS.find((k) => k.id === tool)?.blurb}</span>
              </div>

              <div className='flex flex-col gap-2'>
                <span className='me-h'>Blocks · {data.blocks.length}</span>
                <div className='flex flex-col gap-1'>
                  {data.blocks.length === 0 && <span className='me-empty'>Nothing placed yet.</span>}
                  {data.blocks.map((b) => (
                    <div
                      key={b.id}
                      className={`me-row ${selectedId === b.id ? 'me-row-on' : ''}`}
                      role='button'
                      tabIndex={0}
                      onClick={() => { setSelectedId(b.id); setTab('blocks'); }}
                      onKeyDown={(e) => e.key === 'Enter' && setSelectedId(b.id)}
                    >
                      <span className='me-kind-swatch' style={{ background: KIND_HEX[b.kind], width: 10, height: 10 }} aria-hidden='true' />
                      <span className='truncate font-mono text-[11px]'>
                        {KINDS.find((k) => k.id === b.kind)?.label ?? b.kind}
                      </span>
                      <span className='ml-auto font-mono text-[10px] text-white/35 tabular-nums'>
                        {`${b.x} ${b.y} ${b.z}`}
                      </span>
                      <button
                        type='button'
                        className='me-row-x'
                        aria-label={`Delete ${b.kind} ${b.id}`}
                        onClick={(e) => { e.stopPropagation(); deleteBlock(b.id); }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {selected && (
                <div className='me-card flex flex-col gap-2'>
                  <div className='flex items-center justify-between'>
                    <span className='me-h'>Selected · {selected.kind}</span>
                    <div className='flex gap-1'>
                      <UtilButton onClick={() => duplicateBlock(selected.id)} className='!px-2 !py-1'>Copy</UtilButton>
                      <UtilButton onClick={() => deleteBlock(selected.id)} tone='rose' className='!px-2 !py-1'>Delete</UtilButton>
                    </div>
                  </div>
                  <div className='grid grid-cols-2 gap-2'>
                    <NumField label='Center X' value={selected.x} onChange={(v) => updateBlock(selected.id, { x: snap(v) })} step={0.5} />
                    <NumField label='Center Z' value={selected.z} onChange={(v) => updateBlock(selected.id, { z: snap(v) })} step={0.5} />
                    <NumField label='Base Y' value={selected.y} onChange={(v) => updateBlock(selected.id, { y: Math.max(0, snap(v)) })} step={0.5} min={0} />
                    <NumField label='Height' value={selected.h} onChange={(v) => updateBlock(selected.id, { h: Math.max(0.4, snap(v)) })} step={0.5} min={0.4} suffix='m' />
                    <NumField label='Width' value={selected.w} onChange={(v) => updateBlock(selected.id, { w: Math.max(0.5, snap(v)) })} step={0.5} min={0.5} suffix='m' />
                    <NumField label='Depth' value={selected.d} onChange={(v) => updateBlock(selected.id, { d: Math.max(0.5, snap(v)) })} step={0.5} min={0.5} suffix='m' />
                  </div>
                  <div className='flex flex-wrap gap-1'>
                    {KIND_ORDER.map((k) => (
                      <button
                        key={k}
                        type='button'
                        className={`me-kind me-kind-sm ${selected.kind === k ? 'me-kind-on' : ''}`}
                        onClick={() => updateBlock(selected.id, { kind: k as CustomBlockKind })}
                      >
                        <span className='me-kind-swatch' style={{ background: KIND_HEX[k], width: 8, height: 8 }} aria-hidden='true' />
                        {KINDS.find((x) => x.id === k)?.label.slice(0, 5) ?? k}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className='flex flex-col gap-2'>
                <UtilButton onClick={applySymmetry} tone='cyan' className='w-full'>
                  Mirror mass × axis
                </UtilButton>
                <span className='me-note'>Mirrors every block with centre x ≠ 0 to the other side — duel fairness by construction.</span>
              </div>
            </div>
          )}

          {tab === 'arena' && (
            <ArenaSettings
              data={data}
              onChange={mutate}
              showGrid={showGrid}
              onToggleGrid={() => setShowGrid((g) => !g)}
            />
          )}

          {tab === 'spawns' && (
            <SpawnTools
              data={data}
              onChange={mutate}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>

        {/* Validation summary */}
        <div className='me-footer'>
          {errs.length === 0 ? (
            <span className='me-ok-text'>Ready to test</span>
          ) : (
            <span className='me-err-text'>{errs.length} error{errs.length > 1 ? 's' : ''} — see the ticker</span>
          )}
          <span className='me-hint-t'>{issues.filter((i) => i.level === 'warn').length} warnings</span>
        </div>
      </aside>
    </div>
  );
}

// ── arena tab ──────────────────────────────────────────────────────────────
function ArenaSettings({
  data, onChange, showGrid, onToggleGrid,
}: {
  data: CustomMapData;
  onChange: (fn: (d: CustomMapData) => CustomMapData) => void;
  showGrid: boolean;
  onToggleGrid: () => void;
}) {
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-col gap-2'>
        <label className='me-field'>
          <span className='me-field-label'>Map name</span>
          <input
            className='me-text'
            value={data.name}
            maxLength={40}
            onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))}
          />
        </label>
      </div>

      <div className='grid grid-cols-2 gap-2'>
        <NumField label='Half width' value={data.halfX} onChange={(v) => onChange((d) => ({ ...d, halfX: v }))} min={12} max={80} suffix='m' />
        <NumField label='Half depth' value={data.halfZ} onChange={(v) => onChange((d) => ({ ...d, halfZ: v }))} min={12} max={80} suffix='m' />
        <NumField label='Ceiling' value={data.cap} onChange={(v) => onChange((d) => ({ ...d, cap: v }))} min={9} max={60} suffix='m' />
        <label className='me-field'>
          <span className='me-field-label'>Accent</span>
          <span className='me-field-input'>
            <input
              type='color'
              value={data.accent ?? CUSTOM_ACCENT_DEFAULT}
              onChange={(e) => onChange((d) => ({ ...d, accent: e.target.value }))}
              className='me-color'
            />
          </span>
        </label>
      </div>

      <div className='me-card flex flex-col gap-2'>
        <span className='me-h'>Layout notes</span>
        <span className='me-note'>
          Players can't step up — every rise needs a jump (1.6 m), double jump (3.2 m) or boost (≤ 7.5 m, off a surface ≤ 4 m away). Bridges and decks connect tiers.
        </span>
        <label className='me-check'>
          <input type='checkbox' checked={showGrid} onChange={onToggleGrid} />
          <span>Show the 2 m workspace grid</span>
        </label>
      </div>
    </div>
  );
}

// ── spawns tab ─────────────────────────────────────────────────────────────
function SpawnTools({
  data, onChange, selectedId, onSelect,
}: {
  data: CustomMapData;
  onChange: (fn: (d: CustomMapData) => CustomMapData) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [sx, setSx] = useState(0);
  const [sz, setSz] = useState(0);
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-col gap-2'>
        <span className='me-h'>Spawn points · {data.spawns.length}</span>
        <div className='flex flex-col gap-1'>
          {data.spawns.map((s, i) => (
            <div key={`${s.x},${s.z},${i}`} className='me-row'>
              <span className='font-mono text-[11px]'>#{i + 1}</span>
              <span className='ml-auto font-mono text-[10px] text-white/45 tabular-nums'>{s.x} · {s.z}</span>
              <button
                type='button'
                className='me-row-x'
                aria-label={`Remove spawn ${i + 1}`}
                onClick={() => onChange((d) => ({ ...d, spawns: d.spawns.filter((_, j) => j !== i) }))}
              >
                ✕
              </button>
            </div>
          ))}
          {data.spawns.length === 0 && <span className='me-empty'>No spawns — add at least four.</span>}
        </div>
      </div>

      <div className='me-card flex flex-col gap-2'>
        <div className='grid grid-cols-2 gap-2'>
          <NumField label='X' value={sx} onChange={setSx} step={0.5} />
          <NumField label='Z' value={sz} onChange={setSz} step={0.5} />
        </div>
        <UtilButton
          tone='cyan'
          className='w-full'
          disabled={data.spawns.length >= 32 || Math.abs(sx) > data.halfX || Math.abs(sz) > data.halfZ}
          onClick={() => {
            onChange((d) => ({ ...d, spawns: [...d.spawns, { x: snap(sx), z: snap(sz) }] }));
            onSelect(selectedId);
          }}
        >
          Add spawn
        </UtilButton>
        <span className='me-note'>Spawns snap to the highest surface under them. Spread them across zones and tiers; the server jitters ±0.5 m.</span>
      </div>
    </div>
  );
}
