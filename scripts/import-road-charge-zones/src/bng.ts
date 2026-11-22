/**
 * British National Grid (EPSG:27700, Airy 1830 / OSGB36) to WGS84.
 *
 * The transverse Mercator inverse is the Ordnance Survey formulation.
 * The datum step is the 7-parameter Helmert transform from OSGB36 to WGS84
 * (the reverse of the published WGS84-to-OSGB36 parameter set), position
 * vector convention. This is the Helmert approximation, not the OSTN15 grid,
 * so a boundary can be a few metres off the deposited plan.
 *
 * Checked against the OS worked example:
 * easting 651409.903, northing 313177.270
 * -> 1.71605195 E, 52.65797860 N.
 */

const AIRY_A = 6377563.396;
const AIRY_B = 6356256.909;
const WGS_A = 6378137.0;
const WGS_B = 6356752.3142;
const F0 = 0.9996012717;
const LAT0 = 49 * Math.PI / 180;
const LON0 = -2 * Math.PI / 180;
const N0 = -100000;
const E0 = 400000;

const HELMERT = {
  tx: 446.448,
  ty: -125.157,
  tz: 542.060,
  rx: 0.1502,
  ry: 0.2470,
  rz: 0.8421,
  ppm: -20.4894,
};

function arcSeconds(value: number): number {
  return value * Math.PI / 180 / 3600;
}

export function bngToWgs84(easting: number, northing: number): [number, number] {
  if (easting < 0 || easting > 700000 || northing < 0 || northing > 1300000) {
    throw new Error("British National Grid coordinate is outside the national grid");
  }
  const a = AIRY_A;
  const b = AIRY_B;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;
  let phi = LAT0;
  let meridional = 0;
  for (let i = 0; i < 20; i += 1) {
    phi = (northing - N0 - meridional) / (a * F0) + phi;
    const ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (phi - LAT0);
    const mb = (3 * n + 3 * n * n + (21 / 8) * n3) * Math.sin(phi - LAT0) * Math.cos(phi + LAT0);
    const mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (phi - LAT0)) * Math.cos(2 * (phi + LAT0));
    const md = (35 / 24) * n3 * Math.sin(3 * (phi - LAT0)) * Math.cos(3 * (phi + LAT0));
    meridional = b * F0 * (ma - mb + mc - md);
    if (Math.abs(northing - N0 - meridional) < 0.00001) break;
    if (i === 19) throw new Error("British National Grid latitude did not converge");
  }

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const rho = a * F0 * (1 - e2) / (1 - e2 * sinPhi * sinPhi) ** 1.5;
  const eta2 = nu / rho - 1;
  const tanPhi = Math.tan(phi);
  const tan2 = tanPhi * tanPhi;
  const tan4 = tan2 * tan2;
  const tan6 = tan4 * tan2;
  const sec = 1 / cosPhi;
  const nu3 = nu ** 3;
  const nu5 = nu ** 5;
  const nu7 = nu ** 7;
  const vii = tanPhi / (2 * rho * nu);
  const viii = tanPhi / (24 * rho * nu3) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const ix = tanPhi / (720 * rho * nu5) * (61 + 90 * tan2 + 45 * tan4);
  const x = sec / nu;
  const xi = sec / (6 * nu3) * (nu / rho + 2 * tan2);
  const xii = sec / (120 * nu5) * (5 + 28 * tan2 + 24 * tan4);
  const xiia = sec / (5040 * nu7) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);
  const dE = easting - E0;
  const lat = phi - vii * dE ** 2 + viii * dE ** 4 - ix * dE ** 6;
  const lon = LON0 + x * dE - xi * dE ** 3 + xii * dE ** 5 - xiia * dE ** 7;
  return osgb36ToWgs84(lat, lon);
}

function osgb36ToWgs84(lat: number, lon: number): [number, number] {
  const e2 = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  const v = AIRY_A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const x = v * Math.cos(lat) * Math.cos(lon);
  const y = v * Math.cos(lat) * Math.sin(lon);
  const z = (1 - e2) * v * Math.sin(lat);
  const s = HELMERT.ppm * 1e-6;
  const rx = arcSeconds(HELMERT.rx);
  const ry = arcSeconds(HELMERT.ry);
  const rz = arcSeconds(HELMERT.rz);
  const x2 = HELMERT.tx + (1 + s) * x - rz * y + ry * z;
  const y2 = HELMERT.ty + rz * x + (1 + s) * y - rx * z;
  const z2 = HELMERT.tz - ry * x + rx * y + (1 + s) * z;
  const e2w = 1 - (WGS_B * WGS_B) / (WGS_A * WGS_A);
  const p = Math.hypot(x2, y2);
  let lat2 = Math.atan2(z2, p * (1 - e2w));
  for (let i = 0; i < 8; i += 1) {
    const vw = WGS_A / Math.sqrt(1 - e2w * Math.sin(lat2) ** 2);
    lat2 = Math.atan2(z2 + e2w * vw * Math.sin(lat2), p);
  }
  const lon2 = Math.atan2(y2, x2);
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}
