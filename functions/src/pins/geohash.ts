const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Standard geohash. Precision 5 is the pin tile, about 5 km.
 * @param {number} lat latitude.
 * @param {number} lng longitude.
 * @param {number} precision character length.
 * @return {string} geohash.
 */
export function geohash(lat: number, lng: number, precision: number): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bit = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        value = (value << 1) + 1;
        lngMin = mid;
      } else {
        value = value << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        value = (value << 1) + 1;
        latMin = mid;
      } else {
        value = value << 1;
        latMax = mid;
      }
    }
    even = !even;
    bit += 1;
    if (bit === 5) {
      hash += BASE32[value];
      bit = 0;
      value = 0;
    }
  }
  return hash;
}

export function geohash5(lat: number, lng: number): string {
  return geohash(lat, lng, 5);
}
