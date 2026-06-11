// Optional line overlays for lanes/connectors (dev flag). Spec §src/render/debug.js.
// Toggle via CONFIG.debug.{showLanes, showConnectors} or the returned setters.

import * as THREE from 'three';
import { CONFIG } from '../config.js';

const TURN_COLORS = {
  through: new THREE.Color(0x2ecc71),
  right: new THREE.Color(0xf39c12),
  left: new THREE.Color(0xe74c3c),
  uturn: new THREE.Color(0x9b59b6),
};

// `elev` per poly (F1, optional): parallel height array — vertex y = base y +
// elev[i] when provided (lane/connector elevation profiles).
function polylinesToSegments(polys, colorFor, y) {
  const positions = [];
  const colors = [];
  const c = new THREE.Color();
  for (const { points, item, elev } of polys) {
    c.copy(colorFor(item));
    for (let i = 1; i < points.length; i++) {
      const y0 = y + (elev ? elev[i - 1] : 0);
      const y1 = y + (elev ? elev[i] : 0);
      positions.push(points[i - 1].x, y0, points[i - 1].z);
      positions.push(points[i].x, y1, points[i].z);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

export function createDebugOverlay(network) {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ vertexColors: true });

  // Lane centerlines (cyan) + a short heading tick at each lane end.
  const lanePolys = [];
  const tick = (lane) => {
    const e = lane.posAt(lane.length);
    const h = lane.headingAt(lane.length);
    return {
      points: [
        { x: e.x - h.x * 1.5 - -h.z * 0.8, z: e.z - h.z * 1.5 - h.x * 0.8 },
        { x: e.x, z: e.z },
        { x: e.x - h.x * 1.5 + -h.z * 0.8, z: e.z - h.z * 1.5 + h.x * 0.8 },
      ],
      elev: lane.elev ? [e.y, e.y, e.y] : null,
    };
  };
  for (const lane of network.lanes.values()) {
    lanePolys.push({ points: lane.points, item: lane, elev: lane.elev });
    const t = tick(lane);
    lanePolys.push({ points: t.points, item: lane, elev: t.elev });
  }
  const laneGeom = polylinesToSegments(lanePolys, () => TURN_COLORS.through.clone().set(0x00d8ff), 0.15);
  const laneLines = new THREE.LineSegments(laneGeom, mat);
  laneLines.visible = !!CONFIG.debug.showLanes;
  group.add(laneLines);

  // Connector curves colored by turn type.
  const connPolys = [];
  for (const conn of network.connectors.values()) {
    connPolys.push({ points: conn.points, item: conn, elev: conn.elev });
  }
  const connGeom = polylinesToSegments(
    connPolys,
    (c) => TURN_COLORS[c.turnType] || TURN_COLORS.uturn,
    0.22
  );
  const connLines = new THREE.LineSegments(connGeom, mat);
  connLines.visible = !!CONFIG.debug.showConnectors;
  group.add(connLines);

  return {
    group,
    setLanesVisible(v) {
      laneLines.visible = v;
    },
    setConnectorsVisible(v) {
      connLines.visible = v;
    },
    dispose() {
      laneGeom.dispose();
      connGeom.dispose();
      mat.dispose();
    },
  };
}
