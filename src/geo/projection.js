// Equirectangular tangent-plane projection at the query center (lat0, lon0).
//
// THREE.JS MAPPING — #1 handedness bug source. Single convention, used everywhere:
//   three.js is RIGHT-handed, Y up.
//   x = east, z = -north  (+z = SOUTH), y = up.
//   With travel direction d = (dx, dz), the RIGHT side of travel
//   (right-hand traffic) is n = (-dz, dx).
//   Verify: heading east d=(1,0) -> n=(0,1) = +z = south = driver's right. Correct.
//
// Orientation: NEVER ad-hoc atan2 yaw. Build instance matrices from basis vectors:
//   forward = (dx, 0, dz); up = (0,1,0); right = cross(up, forward) // unit
//   matrix.makeBasis(right, up, forward); matrix.setPosition(x, y, z)
// Model all vehicle geometry with nose pointing +Z local.

const METERS_PER_DEG_LAT = 111320;

export function createProjection(lat0, lon0) {
  const mPerDegLat = METERS_PER_DEG_LAT;
  const mPerDegLon = METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0,
    lon0,
    /** lat/lon -> local meters {x, z} (x = east, z = -north). */
    toLocal(lat, lon, out) {
      const res = out || { x: 0, z: 0 };
      res.x = (lon - lon0) * mPerDegLon;
      res.z = -((lat - lat0) * mPerDegLat);
      return res;
    },
    /** local meters -> {lat, lon}. */
    toLatLon(x, z) {
      return {
        lat: lat0 + -z / mPerDegLat,
        lon: lon0 + x / mPerDegLon,
      };
    },
  };
}
