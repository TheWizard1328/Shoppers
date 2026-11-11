/**
 * sunTimes.jsx — local sunrise/sunset, no API call.
 *
 * OWNER SPEC (Nov 10 2026): the flashlight FAB appears at dusk. Asking HERE or
 * Google for sun times would burn a request per dashboard mount for a number
 * that is pure arithmetic, so this is a trimmed SunCalc-style solar position
 * calculation (NOAA algorithms): accurate to roughly a minute, which is far
 * more than a torch button needs.
 *
 * Returns null above the polar circles on days with no rise/set.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;

const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);

const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M) => {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;
  return M + C + P + Math.PI;
};
const declination = (l) => Math.asin(Math.sin(l) * Math.sin(RAD * 23.4397));
const julianCycle = (d, lw) => Math.round(d - 0.0009 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) =>
  J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

const hourAngle = (h, phi, d) => {
  const cosH =
    (Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d));
  if (cosH > 1 || cosH < -1) return NaN;
  return Math.acos(cosH);
};

/**
 * @param {Date} date local date/time to evaluate
 * @param {number} lat latitude in degrees
 * @param {number} lon longitude in degrees (negative = west)
 * @returns {{sunrise: Date, sunset: Date, solarNoon: Date}|null}
 */
export function computeSunTimes(date, lat, lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
  if (Math.abs(latNum) > 89 || Math.abs(lonNum) > 180) return null;

  const lw = RAD * -lonNum;
  const phi = RAD * latNum;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const Jnoon = solarTransitJ(ds, M, L);

  // -0.833 deg = refraction + solar radius (the standard sunrise/sunset height)
  const w = hourAngle(-0.833 * RAD, phi, dec);
  if (!Number.isFinite(w)) return null;

  const a = approxTransit(w, lw, n);
  const Jset = solarTransitJ(a, M, L);
  const Jrise = Jnoon - (Jset - Jnoon);

  return {
    sunrise: fromJulian(Jrise),
    sunset: fromJulian(Jset),
    solarNoon: fromJulian(Jnoon),
  };
}

export default computeSunTimes;
