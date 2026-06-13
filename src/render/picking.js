// Click-to-pick vehicles (spec §3.6): raycast the three vehicle InstancedMeshes
// -> instanceId -> vehicle via instanceIdToVehicle (rebuilt per frame by
// vehiclesMesh.update). Distinguishes clicks from MapControls drags with a
// small movement threshold. Survives live network swaps by reading the
// current vehiclesMesh through a getter.
//
// V3 C1 obras mode: while opts.isObrasMode() is true, clicks raycast the road
// ribbon mesh instead — hit face vertex -> roads.edgeForVertex -> onRoadPick
// ({edge, twin, ...}). The vehicle path below is untouched.

import * as THREE from 'three';

const CLICK_SLOP_PX = 5;

/**
 * createPicking(view, getVehiclesMesh, onPick, opts)
 *   view            — {camera, renderer} from scene.js
 *   getVehiclesMesh — () => current vehiclesMesh (rebuilt on map swap)
 *   onPick(vehicle | null) — vehicle hit, or null for empty-space clicks
 *   opts (C1, optional) — { isObrasMode(), getRoads(), onRoadPick(range) }
 */
export function createPicking(view, getVehiclesMesh, onPick, opts = null) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dom = view.renderer.domElement;

  let downX = 0;
  let downY = 0;
  let downValid = false;

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    downX = ev.clientX;
    downY = ev.clientY;
    downValid = true;
  }

  function setRayFromEvent(ev) {
    const rect = dom.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, view.camera);
  }

  /** C1 obras mode: pick a road (closed or open) off the merged ribbon mesh. */
  function pickRoad(ev) {
    const roads = opts.getRoads ? opts.getRoads() : null;
    const mesh = roads ? roads.ribbonMesh : null;
    if (!roads || !mesh || !opts.onRoadPick) return;
    setRayFromEvent(ev);
    const hits = raycaster.intersectObject(mesh, false);
    for (let i = 0; i < hits.length; i++) {
      const face = hits[i].face;
      if (!face) continue;
      const range = roads.edgeForVertex(face.a); // {edge, twin, vertStart, ...}
      if (range) {
        opts.onRoadPick(range);
        return;
      }
    }
  }

  function onPointerUp(ev) {
    if (!downValid || ev.button !== 0) return;
    downValid = false;
    if (
      Math.abs(ev.clientX - downX) > CLICK_SLOP_PX ||
      Math.abs(ev.clientY - downY) > CLICK_SLOP_PX
    ) {
      return; // drag, not a click
    }
    if (opts && opts.isObrasMode && opts.isObrasMode()) {
      pickRoad(ev); // C1: obras mode swallows the click (no follow toggle)
      return;
    }
    const vm = getVehiclesMesh();
    if (!vm) return;
    setRayFromEvent(ev);
    // InstancedMesh caches its bounding sphere from whatever `count` it had
    // when first computed (0 at startup -> empty sphere -> every ray rejected).
    // Instances move every frame, so refresh it per click (rare, O(count)).
    for (let i = 0; i < vm.meshes.length; i++) vm.meshes[i].computeBoundingSphere();
    const hits = raycaster.intersectObjects(vm.meshes, false);
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (hit.instanceId === undefined) continue;
      const typeIndex = vm.meshes.indexOf(hit.object);
      if (typeIndex < 0) continue;
      const veh = vm.instanceIdToVehicle[typeIndex][hit.instanceId];
      if (veh && !veh._gone) {
        onPick(veh);
        return;
      }
    }
    onPick(null); // empty space
  }

  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointerup', onPointerUp);

  return {
    dispose() {
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointerup', onPointerUp);
    },
  };
}
