// Terrain mesh (F1): a displaced plane over the network bbox + margin, with a
// ROAD-SPLAT pass that pulls terrain under every road profile so ribbons never
// poke through where the real slope exceeds the road grade clamp (15%).
//   1. PlaneGeometry ~96x96 segments, vertices displaced by the elevation
//      sampler (already normalized: y = 0 at the query center).
//   2. Road splat: walk every undirected edge profile at ~3 m steps; terrain
//      vertices within (half road width + 6 m) are pulled DOWN to
//      min(y, roadElev - terrainDropM). Junction nodes get the same treatment
//      (edge walks stop at the trim radius, so discs need their own splat).
//   3. One 3x3 smoothing pass, then the splat constraint is re-applied so the
//      smoothed terrain still stays under the roads.
// Build-time only (allocations fine); per-world, disposed on swap.

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { cumulativeLengths, pointAtParam } from '../util/math2d.js';
import { profileAt } from '../network/elevation.js';
import { buildTerrainUVs } from './satellite.js'; // D1

export function createTerrainMesh(network) {
  const cfg = CONFIG.elevation;
  const sampler = network.elevation;
  const W = CONFIG.laneWidthM;
  const bbox = network.bbox;

  // Plane over bbox + 35% margin per side (fades into the fog).
  const spanX = Math.max(bbox.maxX - bbox.minX, 200);
  const spanZ = Math.max(bbox.maxZ - bbox.minZ, 200);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cz = (bbox.minZ + bbox.maxZ) / 2;
  const width = spanX * 1.7;
  const depth = spanZ * 1.7;
  const segs = cfg.terrainSegments;

  const geom = new THREE.PlaneGeometry(width, depth, segs, segs);
  geom.rotateX(-Math.PI / 2); // XY plane -> XZ ground, +Y up
  geom.translate(cx, 0, cz);
  geom.deleteAttribute('uv');

  // Vertices form a regular row-major grid over (x, z) after the rotation.
  const pos = geom.attributes.position;
  const count = pos.count; // (segs+1)^2
  const cols = segs + 1;
  const minX = cx - width / 2;
  const minZ = cz - depth / 2;
  const dx = width / segs;
  const dz = depth / segs;

  // 1) Displace by the sampler.
  for (let i = 0; i < count; i++) {
    pos.setY(i, sampler.elevAt(pos.getX(i), pos.getZ(i)));
  }

  // 2) Road splat. `limit[i]` keeps the strongest constraint so it can be
  // re-applied after smoothing.
  const limit = new Float32Array(count).fill(Infinity);
  const cellDiag = Math.sqrt(dx * dx + dz * dz);
  const drop = cfg.terrainDropM;

  function splatAt(x, z, elev, radius) {
    // Effective radius >= cell diagonal so the containing cell's corners are
    // always captured even on coarse grids.
    const r = Math.max(radius, cellDiag);
    const c0 = Math.max(0, Math.floor((x - r - minX) / dx));
    const c1 = Math.min(segs, Math.ceil((x + r - minX) / dx));
    const r0 = Math.max(0, Math.floor((z - r - minZ) / dz));
    const r1 = Math.min(segs, Math.ceil((z + r - minZ) / dz));
    const max2 = r * r;
    const cap = elev - drop;
    for (let rr = r0; rr <= r1; rr++) {
      const vz = minZ + rr * dz;
      for (let cc = c0; cc <= c1; cc++) {
        const vx = minX + cc * dx;
        const ddx = vx - x;
        const ddz = vz - z;
        if (ddx * ddx + ddz * ddz > max2) continue;
        const i = rr * cols + cc;
        if (cap < limit[i]) limit[i] = cap;
      }
    }
  }

  const p = { x: 0, z: 0 };
  for (const edge of network.edges.values()) {
    if (edge.twinId != null && edge.twinId < edge.id) continue; // one walk per pair
    const pts = edge.trimmedPoints || edge.points;
    if (pts.length < 2 || !edge.elevVals) continue;
    const twin = edge.twinId != null ? network.edges.get(edge.twinId) : null;
    const halfW = twin ? W * Math.max(edge.laneCount, twin.laneCount) : (W * edge.laneCount) / 2;
    const radius = halfW + 6;
    const cum = cumulativeLengths(pts);
    const total = cum[cum.length - 1];
    for (let s = 0; ; s += 3) {
      const sc = Math.min(s, total);
      pointAtParam(pts, cum, sc, p);
      splatAt(p.x, p.z, profileAt(edge.elevCum, edge.elevVals, sc), radius);
      if (sc >= total) break;
    }
  }
  // Junction discs (edge walks stop at the trim radius).
  for (const node of network.nodes.values()) {
    if (node.legCount < 2) continue;
    const radius = (network.nodeRadii.get(node.id) || 4) + 6;
    splatAt(node.x, node.z, node.elev, radius);
  }
  for (let i = 0; i < count; i++) {
    if (limit[i] < pos.getY(i)) pos.setY(i, limit[i]);
  }

  // 3) One 3x3 smoothing pass, then re-apply the splat constraint.
  const smoothed = new Float32Array(count);
  for (let rr = 0; rr <= segs; rr++) {
    for (let cc = 0; cc <= segs; cc++) {
      let sum = 0;
      let n = 0;
      for (let jr = Math.max(0, rr - 1); jr <= Math.min(segs, rr + 1); jr++) {
        for (let jc = Math.max(0, cc - 1); jc <= Math.min(segs, cc + 1); jc++) {
          sum += pos.getY(jr * cols + jc);
          n++;
        }
      }
      smoothed[rr * cols + cc] = sum / n;
    }
  }
  for (let i = 0; i < count; i++) {
    pos.setY(i, Math.min(smoothed[i], limit[i]));
  }

  pos.needsUpdate = true;
  geom.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ color: CONFIG.render.groundColor });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;

  // --- D1 --- the terrain plane rect in local meters (bbox + 35% margin), so
  // satellite.js can compute the tile cover over the SAME extent the UVs map to.
  const planeRect = {
    minX,
    maxX: minX + width,
    minZ,
    maxZ: minZ + depth,
  };
  // --- end D1 ---

  return {
    mesh,
    // --- D1 --- the terrain plane extent (bbox + margin) for tile-cover math.
    planeRect,
    /**
     * Drape Esri imagery on the displaced terrain, or remove it.
     *   sat present -> per-vertex Mercator UVs + mat.map=texture, color=white
     *                  (photo true colors; Lambert still composites sun/fog/night).
     *   sat null    -> mat.map=null, color back to the stylized groundColor.
     */
    setSatellite(sat) {
      if (sat && sat.texture) {
        buildTerrainUVs(geom, network, sat.geoBounds);
        mat.map = sat.texture;
        mat.color.setHex(0xffffff);
      } else {
        if (geom.attributes.uv) geom.deleteAttribute('uv');
        mat.map = null;
        mat.color.setHex(CONFIG.render.groundColor);
      }
      mat.needsUpdate = true;
    },
    // --- end D1 ---
    dispose() {
      geom.dispose();
      mat.dispose();
    },
  };
}
