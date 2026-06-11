// Renderer, camera, MapControls, lights, shadows, resize. Spec §3.1.

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CONFIG } from '../config.js';

export function createScene(container, bbox) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101720);
  scene.fog = new THREE.Fog(0x101720, 900, 2600);

  const camera = new THREE.PerspectiveCamera(
    55,
    container.clientWidth / container.clientHeight,
    1,
    5000
  );

  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 30;

  // Lights.
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a42, 2.1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sun.castShadow = true;
  sun.shadow.camera.near = 1;
  sun.shadow.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  // Ground plane (unit 1x1, scaled per network in frame()).
  const groundGeom = new THREE.PlaneGeometry(1, 1);
  groundGeom.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshLambertMaterial({ color: CONFIG.render.groundColor });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  /**
   * Fit camera / controls / sun shadow frustum / ground to a network bbox.
   * Called at startup and again on every live map swap (Phase 6).
   */
  function frame(b) {
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 200);

    // 45° tilt over the network bbox.
    const dist = span * 0.65;
    camera.position.set(cx, dist, cz + dist);
    camera.lookAt(cx, 0, cz);
    controls.target.set(cx, 0, cz);
    controls.maxDistance = span * 2.5;
    controls.update();

    sun.position.set(cx + span * 0.4, span * 0.7, cz - span * 0.3);
    sun.target.position.set(cx, 0, cz);
    const s = span * 0.65;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = span * 2.5;
    sun.shadow.camera.updateProjectionMatrix();

    ground.position.set(cx, 0, cz);
    ground.scale.set(span * 4, 1, span * 4);
  }
  frame(bbox);

  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  return {
    renderer,
    scene,
    camera,
    controls,
    sun,
    frame,
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('resize', onResize);
      groundGeom.dispose();
      groundMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
