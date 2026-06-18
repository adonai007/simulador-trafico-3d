// Replay recorder (V5 E2b) — flat typed-array ring buffer over the last
// CONFIG.replay.windowS seconds of sim time. ALL storage is preallocated ONCE
// in createReplayRecorder (~10.4 MB at the default 720 × 600 × 6 layout); the
// per-frame record() does pure index math with ZERO allocations.
//
// Ring layout (3 parallel arrays + one big flat data block):
//   frameVehCount : Int32Array(frameCount)            — vehicles stored in frame f
//   frameTime     : Float32Array(frameCount)          — sim time of frame f (-1 = empty)
//   data          : Float32Array(frameCount*maxVehicles*stride)
//                   stride = [id, typeIndex, x, y, z, heading]
// Frame f occupies data[f*maxVehicles*stride .. +frameVehCount[f]*stride).
//
// record(time) is SIM-TIME gated (nextRecordT = time + 1/recordHz) so the
// capture cadence follows the simulation clock — fast-forwarding the sim
// records denser wall-clock frames but the SAME sim-time spacing, and pausing
// the sim freezes recording. main.js HARD-pauses both the sim AND record() while
// the user scrubs (replayMode ON), so the ring is a clean live-only history.
//
// reset() zeroes the ring on a world swap so the new world never scrubs into a
// previous world's frames.

import { CONFIG } from '../config.js';

export function createReplayRecorder(sim) {
  const cfg = CONFIG.replay;
  const recordHz = cfg.recordHz;
  const maxVehicles = cfg.maxVehicles;
  const stride = cfg.stride; // 6: [id, typeIndex, x, y, z, heading]
  // frameCount = ceil(windowS * recordHz). Default 180 * 4 = 720.
  const frameCount = Math.ceil(cfg.windowS * recordHz);
  const recordDt = 1 / recordHz;
  const frameStride = maxVehicles * stride; // floats per frame block

  // Preallocate ONCE. ~720*600*6*4 bytes ≈ 10.4 MB for `data`.
  const frameVehCount = new Int32Array(frameCount);
  const frameTime = new Float32Array(frameCount);
  const data = new Float32Array(frameCount * frameStride);
  frameTime.fill(-1); // -1 = never written (distinguishes from a real t=0 frame)

  // Module scratch for the per-vehicle world pose (stable shape, F1 y-aware).
  const _pos = { x: 0, y: 0, z: 0 };
  const _head = { x: 0, y: 0, z: 0 };

  let head = 0; // ring index of the NEXT frame to write
  let written = 0; // total frames written (capped at frameCount for the API)
  let nextRecordT = 0; // sim-time gate: record once time >= this
  let recording = true; // paused by main.js while scrubbing (replayMode ON)

  /**
   * Record one ring frame from sim.vehicles, SIM-TIME gated. Call at END of
   * step() (after the clock advanced). Phantoms are skipped; ambulances ARE
   * included (they live in sim.vehicles with isEmergency=true). Overflow past
   * maxVehicles is dropped. Zero allocations.
   */
  function record(time) {
    if (!recording) return;
    if (time < nextRecordT) return;
    nextRecordT = time + recordDt;
    const f = head;
    const base = f * frameStride;
    const vehicles = sim.vehicles;
    let n = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i];
      if (veh.isPhantom) continue; // never recorded (lives only in lane arrays anyway)
      if (n >= maxVehicles) break; // per-frame cap — drop the overflow
      const seg = veh.seg;
      const s = veh.s;
      seg.posAt(s, _pos); // {x,y,z} world position (y = elevation, F1)
      seg.headingAt(s, _head); // planar unit heading {x,_,z}
      const o = base + n * stride;
      data[o] = veh.id;
      data[o + 1] = veh.typeIndex;
      data[o + 2] = _pos.x;
      data[o + 3] = _pos.y;
      data[o + 4] = _pos.z;
      data[o + 5] = Math.atan2(_head.x, _head.z); // heading angle (radians)
      n++;
    }
    frameVehCount[f] = n;
    frameTime[f] = time;
    head = (head + 1) % frameCount;
    if (written < frameCount) written++;
  }

  /**
   * Clear the ring (world swap). Frames marked empty (-1) so a scrub before any
   * new frame is recorded renders nothing rather than stale geometry.
   */
  function reset() {
    head = 0;
    written = 0;
    nextRecordT = 0;
    frameTime.fill(-1);
    frameVehCount.fill(0);
    recording = true;
  }

  /** Oldest recorded sim time still in the ring (-1 when empty). */
  function minTime() {
    if (written === 0) return -1;
    // Oldest frame is the one head points at once the ring is full; before the
    // ring fills, the oldest is frame 0.
    const oldest = written < frameCount ? 0 : head;
    return frameTime[oldest];
  }

  /** Newest recorded sim time (-1 when empty). */
  function maxTime() {
    if (written === 0) return -1;
    const newest = (head - 1 + frameCount) % frameCount;
    return frameTime[newest];
  }

  return {
    record,
    reset,
    // ---- read API (consumed by vehiclesMesh.updateFromReplay) ----
    frameCount, // ring capacity (constant)
    maxVehicles,
    stride,
    frameStride,
    frameVehCount, // Int32Array
    frameTime, // Float32Array
    data, // Float32Array
    get head() {
      return head;
    },
    get written() {
      return written;
    },
    get recording() {
      return recording;
    },
    setRecording(b) {
      recording = !!b;
    },
    get windowS() {
      return CONFIG.replay.windowS;
    },
    minTime,
    maxTime,
  };
}
