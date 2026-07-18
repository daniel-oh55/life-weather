/**
 * Convert a Korean-peninsula latitude/longitude to the KMA (Korea Meteorological
 * Administration) 동네예보 forecast grid coordinate (`nx` / `ny`) used by the short-term
 * (`getVilageFcst`) and ultra-short-term (`getUltraSrtFcst`) endpoints.
 *
 * The projection is the official KMA **DFS Lambert Conformal Conic (LCC)** transform. Its
 * mathematical contract — Earth radius, grid spacing, the two standard latitudes, the origin
 * latitude/longitude, the origin grid cell, and the `floor(value + 0.5)` grid selection — comes
 * from the KMA guide for `기상청_단기예보 조회서비스` (공공데이터 ID `15084084`) and the KMA API
 * hub grid-conversion sections. The constants below transcribe that contract directly rather
 * than copying any one language's sample listing; see `docs/kma-grid-conversion.md` for the
 * source names, versions, verification date, and file hashes.
 *
 * This module is pure and deterministic: it never reads the system clock, the environment, or
 * the host locale/timezone; it performs no I/O and never calls the KMA coordinate-conversion
 * network service; it holds no mutable global state; it never mutates its input; and given the
 * same input it always returns a fresh, deep-equal result object. The only dependency is the
 * JavaScript standard `Math`. This is a forward conversion only — there is no reverse
 * (grid → latitude/longitude) conversion here, and results are never clamped into range.
 */

// --- Physical geospatial validity (a wrong caller value, not an unsupported place). ---
/** Smallest / largest physically meaningful latitude, in degrees. */
const MIN_PHYSICAL_LATITUDE_DEGREES = -90;
const MAX_PHYSICAL_LATITUDE_DEGREES = 90;
/** Smallest / largest physically meaningful longitude, in degrees. */
const MIN_PHYSICAL_LONGITUDE_DEGREES = -180;
const MAX_PHYSICAL_LONGITUDE_DEGREES = 180;

// --- Official KMA latitude/longitude coverage guidance (inclusive). ---
// From the official 동네예보 격자 변환 guidance: latitude 31.651814 ~ 43.393490, longitude
// 123.310165 ~ 132.774963. These endpoints are the center coordinates of the extreme grid
// cells, so a location outside this box cannot land on the 149 × 253 grid. This is a fast
// reject only — a location inside the box still has to project onto the grid (see below).
const MIN_SUPPORTED_LATITUDE_DEGREES = 31.651814;
const MAX_SUPPORTED_LATITUDE_DEGREES = 43.39349;
const MIN_SUPPORTED_LONGITUDE_DEGREES = 123.310165;
const MAX_SUPPORTED_LONGITUDE_DEGREES = 132.774963;

// --- Official KMA forecast grid extent (inclusive), 149 (E–W) × 253 (N–S) = 37,697 cells. ---
const MIN_GRID_NX = 1;
const MAX_GRID_NX = 149;
const MIN_GRID_NY = 1;
const MAX_GRID_NY = 253;

// --- Official KMA DFS LCC projection constants. ---
/** Earth radius used by the projection, in kilometres (`RE`). */
const EARTH_RADIUS_KM = 6371.00877;
/** Forecast grid spacing, in kilometres (`GRID`). */
const GRID_SPACING_KM = 5.0;
/** First standard parallel of the conic projection, in degrees (`SLAT1`). */
const STANDARD_LATITUDE_1_DEGREES = 30.0;
/** Second standard parallel of the conic projection, in degrees (`SLAT2`). */
const STANDARD_LATITUDE_2_DEGREES = 60.0;
/** Projection reference (origin) longitude, in degrees (`OLON`). */
const ORIGIN_LONGITUDE_DEGREES = 126.0;
/** Projection reference (origin) latitude, in degrees (`OLAT`). */
const ORIGIN_LATITUDE_DEGREES = 38.0;
/** Grid `nx` of the projection origin (`XO`). The origin lat/lon maps here. */
const ORIGIN_GRID_X = 43;
/** Grid `ny` of the projection origin (`YO`). The origin lat/lon maps here. */
const ORIGIN_GRID_Y = 136;

/** Degrees → radians factor (`DEGRAD`). */
const DEGREES_TO_RADIANS = Math.PI / 180.0;
/** Quarter turn in radians; `π/4 + φ/2` recurs throughout the conic formulae. */
const QUARTER_PI = Math.PI * 0.25;

// --- Input-independent projection terms, computed once at module load from `Math` only. ---
// No environment, clock, network, mutable cache, or lazy initialization flag is involved; these
// are ordinary immutable constants that happen to be derived rather than written as literals.

/** Earth radius expressed in grid-spacing units (`re = RE / GRID`). */
const EARTH_RADIUS_IN_GRID_UNITS = EARTH_RADIUS_KM / GRID_SPACING_KM;

const STANDARD_LATITUDE_1_RADIANS = STANDARD_LATITUDE_1_DEGREES * DEGREES_TO_RADIANS;
const STANDARD_LATITUDE_2_RADIANS = STANDARD_LATITUDE_2_DEGREES * DEGREES_TO_RADIANS;
const ORIGIN_LONGITUDE_RADIANS = ORIGIN_LONGITUDE_DEGREES * DEGREES_TO_RADIANS;
const ORIGIN_LATITUDE_RADIANS = ORIGIN_LATITUDE_DEGREES * DEGREES_TO_RADIANS;

/**
 * Cone constant `sn` — the ratio that ties the two standard parallels to the developed cone:
 * `ln(cos φ1 / cos φ2) / ln(tan(π/4 + φ2/2) / tan(π/4 + φ1/2))`.
 */
const CONE_CONSTANT =
  Math.log(
    Math.cos(STANDARD_LATITUDE_1_RADIANS) /
      Math.cos(STANDARD_LATITUDE_2_RADIANS),
  ) /
  Math.log(
    Math.tan(QUARTER_PI + STANDARD_LATITUDE_2_RADIANS * 0.5) /
      Math.tan(QUARTER_PI + STANDARD_LATITUDE_1_RADIANS * 0.5),
  );

/**
 * Scale factor `sf` — `tan(π/4 + φ1/2)^sn · cos φ1 / sn` — sizing the projection so grid units
 * are consistent with `EARTH_RADIUS_IN_GRID_UNITS`.
 */
const SCALE_FACTOR =
  (Math.pow(Math.tan(QUARTER_PI + STANDARD_LATITUDE_1_RADIANS * 0.5), CONE_CONSTANT) *
    Math.cos(STANDARD_LATITUDE_1_RADIANS)) /
  CONE_CONSTANT;

/**
 * Radial distance `ro` from the cone apex to the origin latitude:
 * `re · sf / tan(π/4 + φ0/2)^sn`. The origin latitude's radius, against which every input
 * latitude's radius is measured to form the grid `y`.
 */
const ORIGIN_RADIAL_DISTANCE =
  (EARTH_RADIUS_IN_GRID_UNITS * SCALE_FACTOR) /
  Math.pow(Math.tan(QUARTER_PI + ORIGIN_LATITUDE_RADIANS * 0.5), CONE_CONSTANT);

/**
 * A latitude/longitude to convert to a KMA forecast grid coordinate. Field order is
 * `latitude`, then `longitude` — both in decimal degrees (WGS84), north and east positive.
 */
export interface ConvertKmaLatitudeLongitudeToGridInput {
  /** Latitude in decimal degrees, north positive. Physically valid within `[-90, 90]`. */
  readonly latitude: number;
  /** Longitude in decimal degrees, east positive. Physically valid within `[-180, 180]`. */
  readonly longitude: number;
}

/**
 * A KMA 동네예보 forecast grid cell. `nx` runs west→east within `[1, 149]`; `ny` runs
 * south→north within `[1, 253]`. Both are integers, ready to place into a KMA forecast request.
 */
export interface KmaForecastGridCoordinate {
  /** Grid column (east–west index), an integer within `[1, 149]`. */
  readonly nx: number;
  /** Grid row (north–south index), an integer within `[1, 253]`. */
  readonly ny: number;
}

/**
 * Convert a latitude/longitude to its KMA forecast grid coordinate.
 *
 * - Returns `{ nx, ny }` for a location the KMA 동네예보 grid supports.
 * - Returns `null` for a valid geographic coordinate the grid does **not** support: outside the
 *   official latitude/longitude coverage box, or inside that box yet projecting to a cell beyond
 *   the `[1, 149] × [1, 253]` grid (the coverage box is a rotated quadrilateral, so its corners
 *   fall off-grid). Off-grid results are returned as `null`, never clamped into range.
 * - Throws `RangeError` when the caller's numbers are not usable coordinates at all: a
 *   non-finite value (including a non-number passed at runtime, `NaN`, `Infinity`, `-Infinity`),
 *   a latitude outside `[-90, 90]`, or a longitude outside `[-180, 180]`.
 *
 * Pure and deterministic; does not read the clock, environment, or network; does not mutate
 * `input`; returns a fresh result object on every successful call.
 *
 * @throws RangeError if `latitude` or `longitude` is non-finite, or falls outside its physical
 *   range. Every message names only the offending field and its policy — it never echoes the
 *   raw input value nor serializes the input object, so an out-of-policy runtime value cannot
 *   leak through the error text.
 */
export function convertKmaLatitudeLongitudeToGrid(
  input: ConvertKmaLatitudeLongitudeToGridInput,
): KmaForecastGridCoordinate | null {
  const { latitude, longitude } = input;

  // 1–2. Reject non-finite numbers first. Number.isFinite does not coerce, so this also rejects
  // any non-number value forced in at runtime, plus NaN / Infinity / -Infinity. Value-free
  // messages: never echo the caller's raw (possibly secret-shaped) coordinate.
  if (!Number.isFinite(latitude)) {
    throw new RangeError('latitude must be a finite number');
  }
  if (!Number.isFinite(longitude)) {
    throw new RangeError('longitude must be a finite number');
  }

  // 3–4. Reject physically impossible coordinates. A value that is out of the physical range is
  // a caller error; a value that is physically valid but off the KMA grid is not (it yields
  // null below).
  if (
    latitude < MIN_PHYSICAL_LATITUDE_DEGREES ||
    latitude > MAX_PHYSICAL_LATITUDE_DEGREES
  ) {
    throw new RangeError('latitude must be within [-90, 90]');
  }
  if (
    longitude < MIN_PHYSICAL_LONGITUDE_DEGREES ||
    longitude > MAX_PHYSICAL_LONGITUDE_DEGREES
  ) {
    throw new RangeError('longitude must be within [-180, 180]');
  }

  // 5. Outside the official KMA coverage box -> unsupported location -> null. Doing this before
  // projecting also keeps pole and extreme-longitude values out of the conic formulae, whose
  // radius term is undefined at a pole.
  if (
    latitude < MIN_SUPPORTED_LATITUDE_DEGREES ||
    latitude > MAX_SUPPORTED_LATITUDE_DEGREES ||
    longitude < MIN_SUPPORTED_LONGITUDE_DEGREES ||
    longitude > MAX_SUPPORTED_LONGITUDE_DEGREES
  ) {
    return null;
  }

  // 6. Project. Radius from the cone apex to this input latitude.
  const latitudeRadialDistance =
    (EARTH_RADIUS_IN_GRID_UNITS * SCALE_FACTOR) /
    Math.pow(
      Math.tan(QUARTER_PI + latitude * DEGREES_TO_RADIANS * 0.5),
      CONE_CONSTANT,
    );

  // Longitude angle relative to the origin meridian, normalized into (−π, π] the official way,
  // then scaled by the cone constant. No clamping or modulo beyond this ±π normalization.
  let longitudeAngle = longitude * DEGREES_TO_RADIANS - ORIGIN_LONGITUDE_RADIANS;
  if (longitudeAngle > Math.PI) {
    longitudeAngle -= 2.0 * Math.PI;
  }
  if (longitudeAngle < -Math.PI) {
    longitudeAngle += 2.0 * Math.PI;
  }
  longitudeAngle *= CONE_CONSTANT;

  // 7. Nearest grid cell via the official floor(value + 0.5) selection (not a symmetric-rounding
  // helper). Math.floor yields an integer for the finite terms guaranteed by the checks above.
  const nx = Math.floor(
    latitudeRadialDistance * Math.sin(longitudeAngle) + ORIGIN_GRID_X + 0.5,
  );
  const ny = Math.floor(
    ORIGIN_RADIAL_DISTANCE -
      latitudeRadialDistance * Math.cos(longitudeAngle) +
      ORIGIN_GRID_Y +
      0.5,
  );

  // 8. A coverage-box location near a corner can still project off-grid. Return null rather than
  // clamp, and never emit a zero, negative, or over-max cell.
  if (
    nx < MIN_GRID_NX ||
    nx > MAX_GRID_NX ||
    ny < MIN_GRID_NY ||
    ny > MAX_GRID_NY
  ) {
    return null;
  }

  // 9. Fresh result object; only nx / ny, never any input-derived field.
  return { nx, ny };
}
