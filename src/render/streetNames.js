// Floating map-style street-name labels (spec V2.1 B): one THREE.Sprite per
// unique edge.name, anchored at the midpoint of the longest same-name chain
// (same toNode->fromNode walk pattern as network/corridor.js, re-implemented
// here to keep modules independent), lifted CONFIG.streetNames.liftM above
// lane.posAt so labels follow the v2 terrain. Canvas-rendered text (white,
// dark outline), class-prioritized cap, distance fade bands + class LOD gated
// at ~CONFIG.streetNames.updateHz. Build-time allocations only —
// update(camera) is allocation-free. Built in makeWorld, disposed on swap.

import * as THREE from 'three';
import { CONFIG } from '../config.js';

// primary > secondary > tertiary > residential (spec). Everything not listed
// (residential, living_street, unclassified, *_link) shares the lowest band
// and obeys the residentialMaxM class-LOD cutoff.
const CLASS_PRIORITY = {
  motorway: 5,
  trunk: 5,
  primary: 4,
  secondary: 3,
  tertiary: 2,
};
const MINOR_PRIORITY = 1;

const FONT = '600 28px system-ui, "Segoe UI", sans-serif';
const FONT_PX = 28;
const PAD_X = 10; // canvas padding around the measured text width
const PAD_Y = 8;
const DPR = 2; // fixed supersampling for crisp glyphs

/** Offscreen canvas -> sprite with white text + dark 4px outline. */
function makeLabelSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = FONT;
  const textW = Math.max(Math.ceil(ctx.measureText(text).width), 8);
  const w = textW + PAD_X * 2;
  const h = FONT_PX + PAD_Y * 2;
  canvas.width = w * DPR;
  canvas.height = h * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); // resize reset the context
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(14, 19, 27, 0.95)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false, // map-style labels never z-fight buildings/terrain
    depthWrite: false,
    sizeAttenuation: true,
  });
  const sprite = new THREE.Sprite(mat);
  const hM = CONFIG.streetNames.labelHeightM;
  sprite.scale.set((w / h) * hM, hM, 1); // scale ∝ text length
  sprite.renderOrder = 10; // after opaque scene
  return sprite;
}

/**
 * Build street-name labels for a network.
 * Returns {group, update(camera), setVisible(v), dispose(), count, names}.
 */
export function createStreetNames(network) {
  const cfg = CONFIG.streetNames;
  const group = new THREE.Group();

  // --- 1. Group directed edges by OSM name (skip unnamed). Twins share. ---
  const groups = new Map();
  if (network && network.edges) {
    for (const edge of network.edges.values()) {
      if (!edge.name) continue;
      let arr = groups.get(edge.name);
      if (!arr) {
        arr = [];
        groups.set(edge.name, arr);
      }
      arr.push(edge);
    }
  }

  // --- 2. Longest single-direction chain per name -> anchor at midpoint. ---
  const candidates = []; // {name, priority, lengthM, x, y, z}
  const p = { x: 0, y: 0, z: 0 };
  for (const [name, arr] of groups) {
    const byFrom = new Map();
    for (const e of arr) {
      let list = byFrom.get(e.fromNode);
      if (!list) {
        list = [];
        byFrom.set(e.fromNode, list);
      }
      list.push(e);
    }
    const toNodes = new Set();
    for (const e of arr) toNodes.add(e.toNode);
    // Chain starts: edges no group edge feeds into; loops seed from anywhere.
    const starts = arr.filter((e) => !toNodes.has(e.fromNode));
    const seeds = starts.length ? starts : arr;
    const visited = new Set();
    let best = null;
    for (const seed of seeds) {
      if (visited.has(seed.id)) continue;
      const chain = [];
      let total = 0;
      let cur = seed;
      while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        chain.push(cur);
        total += cur.lengthM;
        const nexts = byFrom.get(cur.toNode);
        let nxt = null;
        if (nexts) {
          for (const cand of nexts) {
            if (visited.has(cand.id)) continue;
            if (cand.id === cur.twinId) continue; // no U-turn onto the twin
            nxt = cand;
            break;
          }
        }
        cur = nxt;
      }
      if (!best || total > best.total) best = { chain, total };
    }
    if (!best || !best.chain.length || best.total <= 0) continue;

    // Midpoint: find the chain edge containing half the total length, then
    // map the edge-local arc onto its (junction-trimmed) lane 0.
    const half = best.total / 2;
    let cum = 0;
    let anchor = best.chain[0];
    let sEdge = anchor.lengthM / 2;
    for (const e of best.chain) {
      if (cum + e.lengthM >= half) {
        anchor = e;
        sEdge = half - cum;
        break;
      }
      cum += e.lengthM;
    }
    const lane = anchor.lanes && anchor.lanes[0];
    if (!lane) continue;
    const t = sEdge / Math.max(anchor.lengthM, 1e-6);
    const sLane = Math.min(Math.max(t * lane.length, 0), lane.length);
    lane.posAt(sLane, p); // y included -> labels follow terrain (F1)

    let priority = MINOR_PRIORITY;
    for (const e of best.chain) {
      const pr = CLASS_PRIORITY[e.highwayClass] ?? MINOR_PRIORITY;
      if (pr > priority) priority = pr;
    }
    candidates.push({
      name,
      priority,
      lengthM: best.total,
      x: p.x,
      y: p.y + cfg.liftM,
      z: p.z,
    });
  }

  // --- 3. Class-prioritized cap (then chain length). ---
  candidates.sort((a, b) => b.priority - a.priority || b.lengthM - a.lengthM);
  const kept = candidates.slice(0, cfg.maxLabels);
  const n = kept.length;

  // --- 4. Sprites + flat arrays for the allocation-free update loop. ---
  const sprites = new Array(n);
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pz = new Float32Array(n);
  const minor = new Uint8Array(n);
  const names = new Array(n);
  for (let i = 0; i < n; i++) {
    const lab = kept[i];
    const sprite = makeLabelSprite(lab.name);
    sprite.position.set(lab.x, lab.y, lab.z);
    group.add(sprite);
    sprites[i] = sprite;
    px[i] = lab.x;
    py[i] = lab.y;
    pz[i] = lab.z;
    minor[i] = lab.priority <= MINOR_PRIORITY ? 1 : 0;
    names[i] = lab.name;
  }

  let visible = cfg.enabled !== false;
  group.visible = visible;

  const fadeNear = cfg.fadeNearM;
  const fadeFar = cfg.fadeFarM;
  const resMax = cfg.residentialMaxM;
  const invBand = 1 / Math.max(fadeFar - fadeNear, 1);
  let nextT = 0; // wall-clock gate (~updateHz)

  return {
    group,
    count: n,
    names,

    /** Distance fade bands + class LOD, gated at ~updateHz. No allocations. */
    update(camera) {
      if (!visible || n === 0) return;
      const now = performance.now();
      if (now < nextT) return;
      nextT = now + 1000 / (cfg.updateHz ?? 5);
      const cp = camera.position;
      for (let i = 0; i < n; i++) {
        const dx = px[i] - cp.x;
        const dy = py[i] - cp.y;
        const dz = pz[i] - cp.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let o;
        if (minor[i] === 1 && d > resMax) o = 0; // minor roads: near camera only
        else if (d <= fadeNear) o = 1;
        else o = (fadeFar - d) * invBand; // <= 0 beyond fadeFar
        const spr = sprites[i];
        if (o <= 0.02) {
          spr.visible = false;
        } else {
          spr.visible = true;
          spr.material.opacity = o > 1 ? 1 : o;
        }
      }
    },

    setVisible(v) {
      visible = !!v;
      group.visible = visible;
      nextT = 0; // re-apply fades on the next frame after re-enabling
    },

    dispose() {
      for (let i = 0; i < n; i++) {
        const mat = sprites[i].material;
        if (mat.map) mat.map.dispose();
        mat.dispose();
      }
    },
  };
}
