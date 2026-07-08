import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Module-level HERE API key cache — avoids an AppSettings query on every routing call.
// Cache TTL is 5 minutes so key rotation takes effect promptly without hammering the DB.
const _HERE_SECRET_MAP = { HERE_API_KEY: 'HERE_API_KEY', Here_API_Key_2: 'Here_API_Key_2', Here_API_Key_3: 'Here_API_Key_3' };
let _hereSecretName = null;
let _hereSecretExpiresAt = 0;
const _HERE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getHereApiKey(base44) {
  const now = Date.now();
  if (_hereSecretName && now < _hereSecretExpiresAt) {
    return Deno.env.get(_hereSecretName) || null;
  }
  const settings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }, '-updated_date', 1);
  const val = settings?.[0]?.setting_value || {};
  const selected = val.selected_api_key || val.selected_here_api_key || 'HERE_API_KEY';
  _hereSecretName = _HERE_SECRET_MAP[selected] || 'HERE_API_KEY';
  _hereSecretExpiresAt = now + _HERE_CACHE_TTL_MS;
  return Deno.env.get(_hereSecretName) || null;
}

const logApiUsage = async ({
  base44,
  appUserId,
  appUserName,
  provider,
  apiType,
  purpose,
  functionName,
  metadata = {},
  success,
  durationMs,
  errorMessage,
  callCount = 1,
}) => {
  if (!base44) return;

  try {
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: apiType,
      purpose,
      function_name: functionName,
      user_id: appUserId || null,
      user_name: appUserName || null,
      metadata: {
        api_provider: provider,
        call_count: Number(callCount) || 1,
        success: success === true,
        duration_ms: durationMs,
        error_message: errorMessage || undefined,
        ...metadata,
      },
    });
  } catch (error) {
    console.warn('[IntegrationUsageLogger] Failed to persist API usage log:', error?.message || error);
  }
};

const TIME_ZONE = 'America/Edmonton';
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const HERE_POLYLINE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_POLYLINE_DECODER = HERE_POLYLINE_ALPHABET.split('').reduce((acc, char, index) => {
  acc[char] = index;
  return acc;
}, {});

const buildFallbackSections = (origin, destination, waypoints = []) => {
  const points = [origin, ...waypoints, destination]
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  return points.slice(0, -1).map((point, index) => ({
    polyline: null,
    encoded_polyline: null,
    estimated_distance_km: 0,
    estimated_duration_minutes: 0,
    coordinates: [point, points[index + 1]].filter(Boolean)
  }));
};

const buildFallback = (origin, destination, extra = {}, waypoints = []) => Response.json({
  coordinates: [
    { lat: Number(origin?.lat), lng: Number(origin?.lng) },
    { lat: Number(destination?.lat), lng: Number(destination?.lng) }
  ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)),
  sections: buildFallbackSections(origin, destination, waypoints),
  estimated_distance_km: 0,
  estimated_duration_minutes: 0,
  polyline_format: 'fallback',
  usedFallbackPolyline: true,
  ...extra
});

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return (hours * 60) + minutes;
};

const formatMinutesToTime = (minutes) => {
  if (!Number.isFinite(minutes)) return null;
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const normalizeTimeString = (timeStr, fallback = '00:00:00') => {
  if (!timeStr || typeof timeStr !== 'string') return fallback;
  const parts = timeStr.split(':');
  if (parts.length < 2) return fallback;
  const hours = String(Number(parts[0]) || 0).padStart(2, '0');
  const minutes = String(Number(parts[1]) || 0).padStart(2, '0');
  const seconds = String(Number(parts[2]) || 0).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const getWeekdayCode = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  return WEEKDAY_CODES[utcDate.getUTCDay()];
};

const getTimeZoneOffset = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const sampleDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    timeZoneName: 'shortOffset',
    hour: '2-digit'
  }).formatToParts(sampleDate).find((part) => part.type === 'timeZoneName')?.value || 'GMT-07:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return '-07:00';
  const sign = match[1];
  const hours = String(match[2]).padStart(2, '0');
  const minutes = String(match[3] || '00').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
};

const buildLocalIso = (dateStr, timeStr) => `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;

const buildAccessConstraint = (dateStr, startTime, endTime, currentDepartureTime) => {
  // Always emit a time window constraint when we have at least a startTime.
  // If endTime is missing, use current departure time + 120 min as the end window.
  // This prevents late-day deliveries (picked up in the AM, delivered in the PM) from
  // getting a window anchored to their start time, which was causing incorrect ordering.
  if (!startTime) return null;
  const startMinutes = parseTimeToMinutes(startTime);
  if (!Number.isFinite(startMinutes)) return null;
  let endMinutes;
  if (endTime) {
    endMinutes = parseTimeToMinutes(endTime);
  } else {
    const depMinutes = parseTimeToMinutes(currentDepartureTime);
    endMinutes = Number.isFinite(depMinutes) ? depMinutes + 120 : startMinutes + 120;
  }
  if (endMinutes <= startMinutes) return null;
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, '00:00:00');
  const end = normalizeTimeString(endTime || formatMinutesToTime(endMinutes), '23:59:59');
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};

const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const encodeSigned = (value) => {
  let signed = value << 1;
  if (value < 0) signed = ~signed;
  let encoded = '';
  while (signed >= 0x20) {
    encoded += String.fromCharCode((0x20 | (signed & 0x1f)) + 63);
    signed >>= 5;
  }
  encoded += String.fromCharCode(signed + 63);
  return encoded;
};

const encodeGooglePolyline = (points) => {
  let lastLat = 0;
  let lastLng = 0;
  let encoded = '';

  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat);
    encoded += encodeSigned(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }

  return encoded;
};

const decodeGooglePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push([lat / 1e5, lng / 1e5]);
  }

  return coordinates;
};

const decodeHereFlexiblePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];

  const values = [];
  let current = 0;
  let shift = 0;
  let charIndex = 0;

  for (const char of encoded) {
    const value = HERE_POLYLINE_DECODER[char];
    if (value == null) {
      console.warn('[getHereDirections] Invalid HERE polyline character', {
        char,
        charCode: char?.charCodeAt?.(0),
        charIndex,
        encodedLength: encoded.length,
        encodedPreview: encoded.slice(Math.max(0, charIndex - 12), Math.min(encoded.length, charIndex + 12))
      });
      return [];
    }
    current |= (value & 0x1f) << shift;
    if (value & 0x20) {
      shift += 5;
      charIndex += 1;
      continue;
    }
    values.push(current);
    current = 0;
    shift = 0;
    charIndex += 1;
  }

  if (shift > 0 || values.length < 2 || values[0] !== 1) {
    console.warn('[getHereDirections] Invalid HERE polyline header/termination', {
      shift,
      valuesLength: values.length,
      version: values[0],
      encodedLength: encoded.length,
      encodedStart: encoded.slice(0, 24),
      encodedEnd: encoded.slice(-24)
    });
    return [];
  }

  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (value) => ((value & 1) ? ~(value >> 1) : (value >> 1));

  let latitude = 0;
  let longitude = 0;
  let third = 0;
  const coordinates = [];

  for (let i = 2; i < values.length; i += dimension) {
    if (values[i] == null || values[i + 1] == null || (thirdDimension && values[i + 2] == null)) {
      console.warn('[getHereDirections] Incomplete HERE polyline payload', {
        valueIndex: i,
        valuesLength: values.length,
        dimension,
        encodedLength: encoded.length,
        decodedCoordinateCount: coordinates.length
      });
      return coordinates;
    }
    latitude += toSigned(values[i]);
    longitude += toSigned(values[i + 1]);
    if (thirdDimension) third += toSigned(values[i + 2]);
    coordinates.push([latitude / factor, longitude / factor]);
  }

  if (coordinates.length <= 1) {
    console.warn('[getHereDirections] HERE polyline decoded too short', {
      coordinatesLength: coordinates.length,
      valuesLength: values.length,
      encodedLength: encoded.length,
      encodedStart: encoded.slice(0, 24),
      encodedEnd: encoded.slice(-24)
    });
  }

  return coordinates;
};

const buildRoutingSections = async ({ hereApiKey, orderedStops, originLat, originLng, destinationLat, destinationLng, normalizedTransportMode }) => {
  // When called from getHereDirections with skipSequenceApi=true, orderedStops already
  // includes the destination as its last element (because sequenceStops = allStops.slice(1)
  // which contains all waypoints + destination).  If we blindly append the destination
  // again we get:  [origin, ...stops, dest, dest]  — destination is doubled in orderedPoints
  // AND sent as both a via waypoint AND as the destination parameter to HERE Router.
  // HERE either collapses the last section (returning it without a polyline) or returns an
  // extra zero-length section that shifts section→segment alignment, causing the last real
  // leg to get a straight-line fallback.
  // Strip the trailing duplicate: if the last stop is at the same coords as the destination,
  // it is already the destination — don't append a second copy.
  const round5Local = (v) => Number(Number(v).toFixed(5));
  const lastStop = orderedStops[orderedStops.length - 1];
  const lastIsDest = lastStop
    && round5Local(lastStop.lat) === round5Local(destinationLat)
    && round5Local(lastStop.lng) === round5Local(destinationLng);
  // Stops that are truly intermediate via points (everything except the destination if it's
  // already included as the final stop).
  const viaStops = lastIsDest ? orderedStops.slice(0, -1) : orderedStops;

  const orderedPoints = [
    { lat: originLat, lng: originLng },
    ...orderedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
    ...(lastIsDest ? [] : [{ lat: destinationLat, lng: destinationLng }])
  ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  if (orderedPoints.length < 2) return { sections: [], combinedEncodedPolyline: null, combinedCoordinates: null, usedCrowFliesFallback: false };

  const transportMode = normalizedTransportMode === 'cycling'
    ? 'bicycle'
    : normalizedTransportMode === 'pedestrian'
      ? 'pedestrian'
      : 'car';

  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('transportMode', transportMode);
  params.set('origin', `${originLat},${originLng}`);
  params.set('destination', `${destinationLat},${destinationLng}`);
  params.set('return', 'polyline,summary');

  // HERE Router v8: default 'via' is already a stop-over (passThrough=false by default),
  // which guarantees a section boundary at every waypoint. No extra parameter needed.
  viaStops.forEach((stop) => {
    params.append('via', `${stop.lat},${stop.lng}`);
  });

  const routeResp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    signal: AbortSignal.timeout(20000),
    headers: { accept: 'application/json' }
  });
  const routeData = await routeResp.json().catch(() => null);
  const hereRouteStatus = routeResp.status;
  const hereRoutesArray = routeData?.routes;
  const routeSections = Array.isArray(hereRoutesArray?.[0]?.sections) ? hereRoutesArray[0].sections : [];

  // Diagnostic logging: surface HERE API failures so they appear in function logs
  if (!routeResp.ok || !Array.isArray(hereRoutesArray) || hereRoutesArray.length === 0 || routeSections.length === 0) {
    console.warn('[getHereDirections] HERE Router returned no usable sections', {
      httpStatus: hereRouteStatus,
      routesCount: Array.isArray(hereRoutesArray) ? hereRoutesArray.length : 'non-array',
      sectionsCount: routeSections.length,
      expectedSections: orderedPoints.length > 1 ? orderedPoints.length - 1 : 0,
      viaCount: viaStops.length,
      transportMode: normalizedTransportMode,
      routeDataNotice: routeData?.notices ?? routeData?.title ?? routeData?.status ?? null,
      hereErrorCode: routeData?.code ?? null,
    });
  }

  // If multi-via call returned 0 sections, use crow-flies fallback immediately.
  // Do NOT attempt per-leg individual calls here — that causes 15-20 API hits per optimization.
  // Instead, bad segments are retried individually AFTER section matching below.
  const effectiveRouteSections = routeSections;

  // Pre-decode every HERE section polyline so we can do coordinate-based matching below.
  // HERE may return fewer sections than expected when consecutive vias are very close
  // together or snap to the same road node. Coordinate matching is immune to count mismatches.
  const decodedRouteSections = effectiveRouteSections.map((rs, rsIdx) => {
    let coords = null;
    if (typeof rs?.polyline === 'string' && rs.polyline) {
      const decoded = decodeHereFlexiblePolyline(rs.polyline);
      if (decoded.length > 1) coords = decoded;
    }
    if (!coords && typeof rs?.encoded_polyline === 'string' && rs.encoded_polyline) {
      const decoded = decodeGooglePolyline(rs.encoded_polyline);
      if (decoded.length > 1) coords = decoded;
    }
    return {
      rawSection: rs,
      coords,
      startLat: coords ? coords[0][0] : null,
      startLng: coords ? coords[0][1] : null,
      endLat: coords ? coords[coords.length - 1][0] : null,
      endLng: coords ? coords[coords.length - 1][1] : null,
      used: false,
      rsIdx
    };
  });

  // Helper to check if coordinates need reversal (if polyline is backwards)
  const shouldReverseCoords = (coords, expectedFromLat, expectedFromLng, expectedToLat, expectedToLng) => {
    if (!coords || coords.length < 2) return false;
    const [firstLat, firstLng] = coords[0];
    const [lastLat, lastLng] = coords[coords.length - 1];
    const distFirstToFrom = Math.abs(firstLat - expectedFromLat) + Math.abs(firstLng - expectedFromLng);
    const distFirstToTo = Math.abs(firstLat - expectedToLat) + Math.abs(firstLng - expectedToLng);
    // If first point is closer to destination than origin, coords are reversed
    return distFirstToTo < distFirstToFrom;
  };

  // Coordinate-based section matcher.
  // Finds the unused decodedRouteSection whose start is nearest to fromPoint and
  // whose end is nearest to toPoint.  Returns null if nothing is within threshold.
  const MATCH_THRESHOLD_DEG = 0.001; // ~111 m — generous but safe
  const findMatchingSection = (fromPoint, toPoint) => {
    let best = null;
    let bestScore = Infinity;
    for (const drs of decodedRouteSections) {
      if (drs.used || drs.coords == null) continue;
      const startDist = Math.abs(drs.startLat - fromPoint.lat) + Math.abs(drs.startLng - fromPoint.lng);
      const endDist = Math.abs(drs.endLat - toPoint.lat) + Math.abs(drs.endLng - toPoint.lng);
      const score = startDist + endDist;
      if (startDist < MATCH_THRESHOLD_DEG && endDist < MATCH_THRESHOLD_DEG && score < bestScore) {
        best = drs;
        bestScore = score;
      }
    }
    if (best) best.used = true;
    return best ? best : null;
  };

  const decodedSectionCoordinates = [];
  const sections = orderedPoints.slice(0, -1).map((fromPoint, index) => {
    const toPoint = orderedPoints[index + 1];

    let encodedPolyline = null;
    let decodedCoords = null;
    let matchedSection = null;

    // Skip polyline processing for zero-distance legs (from === to)
    const isZeroDistanceLeg = fromPoint.lat === toPoint.lat && fromPoint.lng === toPoint.lng;

    if (!isZeroDistanceLeg) {
      // Try coordinate-based match first; fall back to positional index as secondary.
      const coordMatch = findMatchingSection(fromPoint, toPoint);
      const positionalFallback = decodedRouteSections[index] || null;
      const candidate = coordMatch || (positionalFallback && !positionalFallback.used ? positionalFallback : null);
      if (candidate) {
        if (candidate !== coordMatch && positionalFallback) positionalFallback.used = true;
        matchedSection = candidate.rawSection;
        decodedCoords = candidate.coords;
        
        // Check if coordinates are reversed and flip if needed
        if (decodedCoords && decodedCoords.length > 1) {
          if (shouldReverseCoords(decodedCoords, fromPoint.lat, fromPoint.lng, toPoint.lat, toPoint.lng)) {
            decodedCoords = decodedCoords.reverse();
          }
          encodedPolyline = encodeGooglePolyline(decodedCoords);
        } else {
          // Section exists but polyline didn't decode — warn and fall through to straight-line
          console.warn('[getHereDirections] HERE section polyline decoded incompletely', {
            sectionIndex: index,
            rawLength: matchedSection?.polyline?.length ?? 0,
            decodedLength: decodedCoords?.length ?? 0,
          });
          matchedSection = candidate.rawSection;
          decodedCoords = null;
        }
      }
    }

    const fallbackDistanceKm = calculateCrowFliesDistance(fromPoint.lat, fromPoint.lng, toPoint.lat, toPoint.lng);

    // If no polyline from HERE, mark this segment for targeted retry
    // (handled below after the map — crow-flies used only if retry also fails)
    if (!encodedPolyline && !isZeroDistanceLeg) {
      // placeholder — will be filled in by targeted retry pass
      return {
        _needsRetry: true,
        _fromPoint: fromPoint,
        _toPoint: toPoint,
        polyline: null,
        encoded_polyline: null,
        estimated_distance_km: Number.isFinite(Number(matchedSection?.summary?.length)) ? Math.round((Number(matchedSection.summary.length) / 1000) * 10) / 10 : Math.round(fallbackDistanceKm * 10) / 10,
        estimated_duration_minutes: Number.isFinite(Number(matchedSection?.summary?.duration)) ? Math.round(Number(matchedSection.summary.duration) / 60) : Math.round((fallbackDistanceKm / 40) * 60),
        coordinates: [fromPoint, toPoint]
      };
    }

    const rs = matchedSection;
    // Push valid decoded coords into combined accumulator
    if (decodedCoords && decodedCoords.length > 1) {
      decodedSectionCoordinates.push(decodedCoords);
    }
    return {
      polyline: rs?.polyline || null,
      encoded_polyline: encodedPolyline,
      estimated_distance_km: Number.isFinite(Number(rs?.summary?.length)) ? Math.round((Number(rs.summary.length) / 1000) * 10) / 10 : Math.round(fallbackDistanceKm * 10) / 10,
      estimated_duration_minutes: Number.isFinite(Number(rs?.summary?.duration)) ? Math.round(Number(rs.summary.duration) / 60) : Math.round((fallbackDistanceKm / 40) * 60),
      coordinates: decodedCoords?.length > 1
        ? decodedCoords.map(([lat, lng]) => ({ lat, lng }))
        : [fromPoint, toPoint]
    };
  });

  // Targeted retry: only call HERE individually for segments that got no valid polyline.
  // This is far cheaper than retrying all legs — typically 0-1 retries per route.
  const transportModeParam = normalizedTransportMode === 'cycling' ? 'bicycle' : normalizedTransportMode === 'pedestrian' ? 'pedestrian' : 'car';
  for (let i = 0; i < sections.length; i++) {
    const seg = sections[i];
    if (!seg._needsRetry) continue;

    let retried = false;
    try {
      const legParams = new URLSearchParams();
      legParams.set('apiKey', hereApiKey);
      legParams.set('transportMode', transportModeParam);
      legParams.set('origin', `${seg._fromPoint.lat},${seg._fromPoint.lng}`);
      legParams.set('destination', `${seg._toPoint.lat},${seg._toPoint.lng}`);
      legParams.set('return', 'polyline,summary');
      const legResp = await fetch(`https://router.hereapi.com/v8/routes?${legParams.toString()}`, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json' }
      });
      const legData = await legResp.json().catch(() => null);
      const legSection = Array.isArray(legData?.routes?.[0]?.sections) ? legData.routes[0].sections[0] : null;
      if (legSection?.polyline) {
        let decoded = decodeHereFlexiblePolyline(legSection.polyline);
        if (decoded.length > 1) {
          // Check if coordinates are reversed and flip if needed
          if (shouldReverseCoords(decoded, seg._fromPoint.lat, seg._fromPoint.lng, seg._toPoint.lat, seg._toPoint.lng)) {
            decoded = decoded.reverse();
          }
          const ep = encodeGooglePolyline(decoded);
          decodedSectionCoordinates.push(decoded);
          sections[i] = {
            polyline: legSection.polyline,
            encoded_polyline: ep,
            estimated_distance_km: Number.isFinite(Number(legSection?.summary?.length)) ? Math.round((Number(legSection.summary.length) / 1000) * 10) / 10 : seg.estimated_distance_km,
            estimated_duration_minutes: Number.isFinite(Number(legSection?.summary?.duration)) ? Math.round(Number(legSection.summary.duration) / 60) : seg.estimated_duration_minutes,
            coordinates: decoded.map(([lat, lng]) => ({ lat, lng }))
          };
          retried = true;
          console.info(`[getHereDirections] Targeted retry succeeded for segment ${i}`);
        }
      }
    } catch (retryErr) {
      console.warn(`[getHereDirections] Targeted retry failed for segment ${i}:`, retryErr?.message);
    }

    // If retry also failed, fall back to crow-flies straight line
    if (!retried) {
      const fallbackCoords = [[seg._fromPoint.lat, seg._fromPoint.lng], [seg._toPoint.lat, seg._toPoint.lng]];
      const ep = encodeGooglePolyline(fallbackCoords);
      decodedSectionCoordinates.push(fallbackCoords);
      sections[i] = {
        ...seg,
        encoded_polyline: ep,
        coordinates: [seg._fromPoint, seg._toPoint],
        _needsRetry: false,
        _isCrowFliesFallback: true
      };
      console.info(`[getHereDirections] Segment ${i} fell back to crow-flies`);
    }
  }

  const combinedCoordinates = decodedSectionCoordinates.reduce((acc, coords) => {
    if (!Array.isArray(coords) || coords.length === 0) return acc;
    if (acc.length === 0) return [...coords];
    const [firstLat, firstLng] = coords[0];
    const [lastLat, lastLng] = acc[acc.length - 1] || [];
    if (lastLat === firstLat && lastLng === firstLng) {
      return [...acc, ...coords.slice(1)];
    }
    return [...acc, ...coords];
  }, []);

  const usedCrowFliesFallback = sections.some((s) => s && s._isCrowFliesFallback === true);

  return {
    sections,
    combinedEncodedPolyline: combinedCoordinates.length > 1 ? encodeGooglePolyline(combinedCoordinates) : null,
    combinedCoordinates: combinedCoordinates.length > 1 ? combinedCoordinates.map(([lat, lng]) => ({ lat, lng })) : null,
    usedCrowFliesFallback
  };
};

Deno.serve(async (req) => {
  let origin = null;
  let destination = null;
  let base44 = null;
  let appUser = null;
  let routeCallCount = 0;
  let caller = 'unknown_here_caller';
  let callerContext = null;
  const startedAt = Date.now();

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    origin = body?.origin || null;
    destination = body?.destination || null;
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1);
    appUser = appUsers?.[0] || null;
    // If a backend caller passed explicit user identity (e.g. optimizeRemainingStops), use that for logging
    if (!appUser && body?.callerUserId) {
      appUser = { id: body.callerUserId, user_id: body.callerUserId, user_name: body.callerUserName || null };
    }
    const waypoints = Array.isArray(body?.waypoints) ? body.waypoints : [];
    const routeContext = Array.isArray(body?.routeContext) ? body.routeContext : [];
    const preserveWaypointOrder = body?.preserveWaypointOrder === true;
    const skipSequenceApi = body?.skipSequenceApi === true;
    // When true, skip the HERE Router API call entirely — return only the sequenced waypoint order.
    // Used by optimizeRemainingStops which delegates polyline generation to purgeAndRegeneratePolylines.
    const skipRoutingApi = body?.skipRoutingApi === true;
    const requestedTransportMode = String(body?.transportMode || body?.transport_mode || 'driving').toLowerCase();
    const hereTransportMode = requestedTransportMode === 'cycling'
      ? 'bicycle'
      : requestedTransportMode === 'pedestrian'
        ? 'pedestrian'
        : 'car';
    const normalizedTransportMode = requestedTransportMode === 'cycling' || requestedTransportMode === 'pedestrian'
      ? requestedTransportMode
      : 'driving';
    caller = String(body?.caller || 'unknown_here_caller');
    callerContext = body?.caller_context || null;

    const originLat = Number(origin?.lat);
    const originLng = Number(origin?.lng);
    const destinationLat = Number(destination?.lat);
    const destinationLng = Number(destination?.lng);

    if (![originLat, originLng, destinationLat, destinationLng].every(Number.isFinite)) {
      return Response.json({ error: 'Missing origin or destination' }, { status: 400 });
    }

    const hereApiKey = await getHereApiKey(base44);
    if (!hereApiKey) {
      return Response.json({ error: 'HERE API key secret not configured' }, { status: 500 });
    }

    const dateStr = String(body?.deliveryDate || body?.date || new Date().toISOString().slice(0, 10));
    const departureTime = String(body?.departureTime || body?.currentLocalTime || '08:00');
    const allStops = [
      { lat: originLat, lng: originLng, id: 'origin', sequenceIndex: -1 },
      ...waypoints.map((point, index) => ({
        lat: Number(point?.lat),
        lng: Number(point?.lng),
        id: String(routeContext[index]?.id || routeContext[index]?.stop_id || routeContext[index]?.delivery_id || `waypoint_${index + 1}`),
        sequenceIndex: index
      })),
      { lat: destinationLat, lng: destinationLng, id: String(routeContext[waypoints.length]?.id || routeContext[waypoints.length]?.stop_id || routeContext[waypoints.length]?.delivery_id || 'destination'), sequenceIndex: waypoints.length }
    ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

    const sequenceStops = allStops.slice(1);
    let resp = { ok: true, status: 200 };
    let data = null;
    let result = null;
    let returnedWaypoints = [];
    let interconnections = [];

    if (preserveWaypointOrder || skipSequenceApi) {
      returnedWaypoints = sequenceStops.map((stop, index) => ({
        id: stop.id,
        sequence: index + 1
      }));
      interconnections = sequenceStops.map((stop, index) => {
        const fromPoint = index === 0 ? { lat: originLat, lng: originLng } : { lat: sequenceStops[index - 1].lat, lng: sequenceStops[index - 1].lng };
        const fallbackDistanceKm = calculateCrowFliesDistance(fromPoint.lat, fromPoint.lng, stop.lat, stop.lng);
        return {
          toWaypoint: stop.id,
          distance: Math.round(fallbackDistanceKm * 1000),
          time: Math.round((fallbackDistanceKm / 40) * 3600)
        };
      });

      result = { waypoints: returnedWaypoints, interconnections };
    } else {
      const params = new URLSearchParams();
      params.set('apiKey', hereApiKey);
      params.set('departure', buildLocalIso(dateStr, departureTime));
      params.set('mode', `fastest;${hereTransportMode};traffic:disabled`);
      // improveFor=time: reliable solver that always returns a result.
      // The acc: time-window constraints are the hard enforcement of stop ordering —
      // non-overlapping windows (e.g. 14:30-15:30 vs 16:00-18:00) leave only one
      // feasible sequence. improveFor=quality is stricter but returns empty on
      // infeasible inputs, silently falling through to the no-window retry.
      params.set('improveFor', 'time');
      params.set('start', `driverStart;${originLat},${originLng}`);

      // Separate the home destination (last stop) from the optimizable waypoints.
      // HERE findsequence2 requires `end` for the locked final destination.
      // Without `end`, HERE treats home as just another optimizable waypoint.
      const optimizableStops = sequenceStops.slice(0, -1);
      const endStop = sequenceStops[sequenceStops.length - 1];

      optimizableStops.forEach((stop, index) => {
        const routeItem = routeContext[stop.sequenceIndex] || {};
        const serviceDuration = Number(routeItem?.service_duration_minutes) || 5;
        const segments = [`${stop.id};${stop.lat},${stop.lng}`, `st:${serviceDuration}`];
        const accessConstraint = buildAccessConstraint(dateStr, routeItem?.time_window_start, routeItem?.time_window_end, departureTime);
        if (accessConstraint) segments.push(accessConstraint);
        params.set(`destination${index + 1}`, segments.join(';'));
      });

      // Lock the final destination (home) using `end` parameter so HERE never reorders it
      if (endStop) {
        params.set('end', `driverEnd;${endStop.lat},${endStop.lng}`);
      }

      routeCallCount += 1;
      resp = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`, {
        signal: AbortSignal.timeout(20000),
        headers: { accept: 'application/json' }
      });
      data = await resp.json().catch(() => null);

      result = Array.isArray(data?.results) ? data.results[0] : null;
      returnedWaypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
      interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];

      // ── Log primary call result (with time windows) ──────────────────────
      console.info(`[getHereDirections] PRIMARY (with windows): status=${resp.status}, waypoints=${returnedWaypoints.length}, result=${result ? 'ok' : 'null'}, caller=${caller}`);
      if (resp.ok && result) {
        console.info(`[getHereDirections] PRIMARY sequence: ${returnedWaypoints.map(w => `${w.id}(seq=${w.sequence})`).join(' → ')}`);
        // Log which stops got time windows applied
        const windowsApplied = sequenceStops.slice(0, -1).map((stop, index) => {
          const routeItem = routeContext[stop.sequenceIndex] || {};
          const constraint = buildAccessConstraint(dateStr, routeItem?.time_window_start, routeItem?.time_window_end, departureTime);
          return `${stop.id}:${constraint || 'NO_WINDOW'}`;
        });
        console.info(`[getHereDirections] Time windows sent: ${windowsApplied.join(' | ')}`);
      } else {
        console.warn(`[getHereDirections] PRIMARY FAILED — HTTP ${resp.status}, raw response: ${JSON.stringify(data || {}).slice(0, 1000)}`);
        // Log the exact params sent for debugging
        const windowsApplied = sequenceStops.slice(0, -1).map((stop, index) => {
          const routeItem = routeContext[stop.sequenceIndex] || {};
          const constraint = buildAccessConstraint(dateStr, routeItem?.time_window_start, routeItem?.time_window_end, departureTime);
          return `${stop.id}:${constraint || 'NO_WINDOW'}`;
        });
        console.warn(`[getHereDirections] Time windows that caused failure: ${windowsApplied.join(' | ')}`);
        console.warn(`[getHereDirections] departure=${buildLocalIso(dateStr, departureTime)}, stops=${sequenceStops.length}, origin=${originLat},${originLng}`);
      }

      if ((!resp.ok || !result || returnedWaypoints.length === 0) && sequenceStops.length > 0) {
        // ── Retry: drop time windows entirely — distance-only last resort ──
        // Primary call (improveFor=time + acc: windows) failed or returned empty.
        // The previous 3-attempt cascade had Retry 1 identical to the primary —
        // a wasted call. Now: one meaningful retry with no windows.
        console.warn(`[getHereDirections] time+windows failed (status=${resp.status}, waypoints=${returnedWaypoints.length}) — retry: no windows (caller=${caller})`);
        const retryParams = new URLSearchParams();
        retryParams.set('apiKey', hereApiKey);
        retryParams.set('departure', buildLocalIso(dateStr, departureTime));
        retryParams.set('mode', `fastest;${hereTransportMode};traffic:disabled`);
        retryParams.set('improveFor', 'time');
        retryParams.set('start', `driverStart;${originLat},${originLng}`);
        const retryOptimizableStops = sequenceStops.slice(0, -1);
        const retryEndStop = sequenceStops[sequenceStops.length - 1];
        retryOptimizableStops.forEach((stop, index) => {
          retryParams.set(`destination${index + 1}`, `${stop.id};${stop.lat},${stop.lng}`);
        });
        if (retryEndStop) retryParams.set('end', `driverEnd;${retryEndStop.lat},${retryEndStop.lng}`);
        routeCallCount += 1;
        resp = await fetch(`https://wps.hereapi.com/v8/findsequence2?${retryParams.toString()}`, {
          signal: AbortSignal.timeout(20000),
          headers: { accept: 'application/json' }
        });
        data = await resp.json().catch(() => null);
        result = Array.isArray(data?.results) ? data.results[0] : null;
        returnedWaypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
        interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];
        console.info(`[getHereDirections] RETRY (no-windows) result: status=${resp.status}, waypoints=${returnedWaypoints.length}, caller=${caller}`);
        if (returnedWaypoints.length > 0) {
          console.info(`[getHereDirections] RETRY sequence (distance-only): ${returnedWaypoints.map(w => `${w.id}(seq=${w.sequence})`).join(' → ')}`);
        } else {
          console.warn(`[getHereDirections] RETRY also failed — raw: ${JSON.stringify(data || {}).slice(0, 500)}`);
        }
      }
    }

    if (!resp.ok) {
      const details = JSON.stringify(data || {}).slice(0, 500);
      await logApiUsage({
        base44,
        appUserId: appUser?.id,
        appUserName: appUser?.user_name || user.full_name,
        provider: 'here',
        apiType: 'Directions (HERE)',
        purpose: 'Route optimization / ETA update / polyline update',
        functionName: 'HERE API call 1',
        success: false,
        durationMs: Date.now() - startedAt,
        errorMessage: details || `HTTP ${resp.status}`,
        callCount: routeCallCount,
        metadata: {
          api_provider: 'here',
          status_code: resp.status,
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: sequenceStops.length + 1,
          caller,
          caller_context: callerContext,
        },
      });
      return buildFallback(origin, destination, { provider_status: resp.status }, waypoints);
    }

    if (!result || returnedWaypoints.length === 0) {
      await logApiUsage({
        base44,
        appUserId: appUser?.id,
        appUserName: appUser?.user_name || user.full_name,
        provider: 'here',
        apiType: 'Directions (HERE)',
        purpose: 'Route optimization / ETA update / polyline update',
        functionName: 'HERE API call 2',
        success: false,
        durationMs: Date.now() - startedAt,
        errorMessage: 'No sequence returned',
        callCount: routeCallCount,
        metadata: {
          api_provider: 'here',
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: sequenceStops.length + 1,
          caller,
          caller_context: callerContext,
        },
      });
      return buildFallback(origin, destination, {}, waypoints);
    }

    const stopLookup = new Map(sequenceStops.map((stop) => [stop.id, stop]));
    const orderedWaypoints = returnedWaypoints
      .filter((waypoint) => waypoint.id !== 'driverStart' && waypoint.id !== 'driverEnd')
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    const orderedStops = orderedWaypoints
      .map((waypoint) => stopLookup.get(waypoint.id) || null)
      .filter(Boolean);

    const interconnectionByToWaypoint = new Map(interconnections.map((item) => [item.toWaypoint, item]));

    // skipRoutingApi=true: caller only needs the sequenced waypoint order (no polylines).
    // Return immediately with sequence data and crow-flies estimates — no Router API call.
    if (skipRoutingApi) {
      const sequenceOnlySections = orderedStops.map((stop, index) => {
        const leg = interconnectionByToWaypoint.get(stop.id);
        const fromPoint = index === 0 ? { lat: originLat, lng: originLng } : { lat: orderedStops[index - 1].lat, lng: orderedStops[index - 1].lng };
        const fallbackDistanceKm = calculateCrowFliesDistance(fromPoint.lat, fromPoint.lng, stop.lat, stop.lng);
        return {
          polyline: null,
          encoded_polyline: null,
          estimated_distance_km: Number.isFinite(Number(leg?.distance)) ? Math.round((Number(leg.distance) / 1000) * 10) / 10 : Math.round(fallbackDistanceKm * 10) / 10,
          estimated_duration_minutes: Number.isFinite(Number(leg?.time)) ? Math.round(Number(leg.time) / 60) : Math.round((fallbackDistanceKm / 40) * 60),
          sequence: index + 1,
          waypoint_id: stop.id,
          coordinates: [fromPoint, { lat: stop.lat, lng: stop.lng }]
        };
      });
      await logApiUsage({
        base44,
        appUserId: appUser?.id,
        appUserName: appUser?.user_name || user.full_name,
        provider: 'here',
        apiType: 'Directions (HERE)',
        purpose: `Sequence-only (no routing) — ${caller}`,
        functionName: `getHereDirections:${caller}`,
        success: true,
        durationMs: Date.now() - startedAt,
        callCount: routeCallCount,
        metadata: {
          api_provider: 'here',
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: sequenceStops.length + 1,
          skip_routing_api: true,
          optimized_sequence: orderedWaypoints.map((wp) => wp.id),
          caller,
          caller_context: callerContext
        },
      });
      return Response.json({
        polyline_format: 'google',
        coordinates: null,
        polyline: null,
        polylines: [],
        sections: sequenceOnlySections,
        estimated_distance_km: sequenceOnlySections.reduce((s, sec) => s + (sec.estimated_distance_km || 0), 0),
        estimated_duration_minutes: sequenceOnlySections.reduce((s, sec) => s + (sec.estimated_duration_minutes || 0), 0),
        transport_mode: normalizedTransportMode,
        optimized_waypoint_ids: orderedWaypoints.map((wp) => wp.id),
        used_time_windows: true,
        api_call_count: routeCallCount,
        skip_routing_api: true
      });
    }

    const routedGeometry = await buildRoutingSections({
      hereApiKey,
      orderedStops,
      originLat,
      originLng,
      destinationLat,
      destinationLng,
      normalizedTransportMode
    });
    if ((routedGeometry.sections || []).length > 0) {
      routeCallCount += 1;
    }
    const routedSections = routedGeometry.sections || [];

    const orderedPoints = [{ lat: originLat, lng: originLng }, ...orderedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng }))];
    const normalizedSections = orderedStops.map((stop, index) => {
      const leg = interconnectionByToWaypoint.get(stop.id);
      const fromPoint = orderedPoints[index];
      const toPoint = orderedPoints[index + 1];
      const fallbackDistanceKm = calculateCrowFliesDistance(fromPoint.lat, fromPoint.lng, toPoint.lat, toPoint.lng);
      const routedSection = routedSections[index] || null;
      const estimatedDistanceKm = routedSection?.estimated_distance_km ?? (Number.isFinite(Number(leg?.distance)) ? Math.round((Number(leg.distance) / 1000) * 10) / 10 : Math.round(fallbackDistanceKm * 10) / 10);
      const estimatedDurationMinutes = routedSection?.estimated_duration_minutes ?? (Number.isFinite(Number(leg?.time)) ? Math.round(Number(leg.time) / 60) : Math.round((fallbackDistanceKm / 40) * 60));
      return {
        polyline: routedSection?.polyline || null,
        encoded_polyline: routedSection?.encoded_polyline || null,
        estimated_distance_km: estimatedDistanceKm,
        estimated_duration_minutes: estimatedDurationMinutes,
        sequence: index + 1,
        waypoint_id: stop.id,
        coordinates: routedSection?.coordinates || [fromPoint, toPoint]
      };
    });

    const totalMeters = interconnections.reduce((sum, item) => sum + Number(item?.distance || 0), 0);
    const totalSeconds = interconnections.reduce((sum, item) => sum + Number(item?.time || 0), 0);
    const estimated_distance_km = totalMeters > 0
      ? Math.round((totalMeters / 1000) * 10) / 10
      : normalizedSections.reduce((sum, section) => sum + Number(section.estimated_distance_km || 0), 0);
    const estimated_duration_minutes = totalSeconds > 0
      ? Math.round(totalSeconds / 60)
      : normalizedSections.reduce((sum, section) => sum + Number(section.estimated_duration_minutes || 0), 0);

    await logApiUsage({
        base44,
        appUserId: appUser?.id,
        appUserName: appUser?.user_name || user.full_name,
        provider: 'here',
        apiType: 'Directions (HERE)',
        purpose: `Calculate route directions${caller !== 'unknown_here_caller' ? ` (${caller})` : ''}`,
        functionName: `getHereDirections:${caller}`,
        success: true,
        durationMs: Date.now() - startedAt,
        callCount: routeCallCount,
        metadata: {
          api_provider: 'here',
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: sequenceStops.length + 1,
          estimated_distance_km,
          estimated_duration_minutes,
          optimized_sequence: orderedWaypoints.map((waypoint) => waypoint.id),
          real_road_polylines: normalizedSections.filter((section) => !!section?.encoded_polyline).length,
          caller,
          caller_context: callerContext
        },
      });

    return Response.json({
      polyline_format: 'google',
      coordinates: routedGeometry.combinedCoordinates,
      polyline: routedGeometry.combinedEncodedPolyline || normalizedSections[0]?.encoded_polyline || null,
      polylines: normalizedSections.map((section) => section?.encoded_polyline).filter(Boolean),
      sections: normalizedSections,
      estimated_distance_km,
      estimated_duration_minutes,
      transport_mode: normalizedTransportMode,
      optimized_waypoint_ids: orderedWaypoints.map((waypoint) => waypoint.id),
      used_time_windows: preserveWaypointOrder ? false : true,
      api_call_count: routeCallCount,
      usedFallbackPolyline: routedGeometry.usedCrowFliesFallback === true
    });
  } catch (err) {
    console.error('[getHereDirections] unexpected error', err?.message || err);
    await logApiUsage({
      base44,
      appUserId: appUser?.id,
      appUserName: appUser?.user_name || null,
      provider: 'here',
      apiType: 'Directions (HERE)',
      purpose: `Calculate route directions${caller !== 'unknown_here_caller' ? ` (${caller})` : ''}`,
      functionName: `getHereDirections:${caller}`,
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: err?.message || 'Unknown error',
      callCount: routeCallCount || 1,
      metadata: {
        api_provider: 'here',
        caller,
        caller_context: callerContext
      }
    });
    return buildFallback(origin, destination, { error: err?.message || 'Unknown error' }, []);
  }
});