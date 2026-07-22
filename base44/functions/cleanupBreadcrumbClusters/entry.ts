import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

// Haversine distance in meters between two [lat, lon] points
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Decode Google-encoded polyline string into [[lat, lng], ...]
function decodePolyline(encoded) {
  if (!encoded) return [];
  const poly = [];
  let index = 0, len = encoded.length, lat = 0, lng = 0;
  while (index < len) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
    poly.push([lat / 1e5, lng / 1e5]);
  }
  return poly;
}

// Encode [[lat, lng], ...] into Google-encoded polyline string
function encodePolyline(points) {
  const encodeValue = (val) => {
    let v = Math.round(val * 1e5);
    v = v < 0 ? ~(v << 1) : v << 1;
    let result = '';
    while (v >= 0x20) { result += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    result += String.fromCharCode(v + 63);
    return result;
  };
  let prevLat = 0, prevLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    encoded += encodeValue(lat - prevLat) + encodeValue(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return encoded;
}

/**
 * Stationary cluster filter:
 * Scans through points and identifies "clusters" where consecutive points
 * are within `radiusM` meters of the cluster centroid and the run is at least
 * `minClusterSize` points long. The entire cluster is replaced with just its
 * centroid (a single point), preserving the route entry and exit positions.
 *
 * The first and last point of the polyline are ALWAYS kept unchanged so the
 * route connection to the previous/next stop is never broken.
 */
function cleanStationaryClusters(points, radiusM = 30, minClusterSize = 5) {
  if (points.length < 3) return points;

  const result = [];
  let i = 0;

  // Always keep the first point
  result.push(points[0]);
  i = 1;

  while (i < points.length - 1) {
    const anchorLat = points[i][0];
    const anchorLon = points[i][1];

    // Look ahead: count how many consecutive points stay within radiusM of anchor
    let j = i + 1;
    while (j < points.length - 1 &&
           haversineM(anchorLat, anchorLon, points[j][0], points[j][1]) <= radiusM) {
      j++;
    }

    const clusterLen = j - i;

    if (clusterLen >= minClusterSize) {
      // Replace the cluster with its centroid
      let sumLat = 0, sumLon = 0;
      for (let k = i; k < j; k++) {
        sumLat += points[k][0];
        sumLon += points[k][1];
      }
      result.push([sumLat / clusterLen, sumLon / clusterLen]);
      i = j;
    } else {
      // Not a cluster — keep this point as-is
      result.push(points[i]);
      i++;
    }
  }

  // Always keep the last point
  result.push(points[points.length - 1]);

  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const {
      breadcrumbId,
      radiusM = 30,       // meters — points within this radius of cluster anchor are grouped
      minClusterSize = 5, // minimum run length to be considered a stationary cluster
      dryRun = false,     // if true, just return stats without saving
    } = body;

    if (!breadcrumbId) {
      return Response.json({ error: 'Missing required field: breadcrumbId' }, { status: 400 });
    }

    // Fetch the breadcrumb record
    const crumb = await base44.asServiceRole.entities.DeliveryBreadcrumbs.get(breadcrumbId);
    if (!crumb) {
      return Response.json({ error: `Breadcrumb ${breadcrumbId} not found` }, { status: 404 });
    }

    if (!crumb.encoded_polyline) {
      return Response.json({ error: 'Breadcrumb has no encoded_polyline to clean' }, { status: 400 });
    }

    const originalPoints = decodePolyline(crumb.encoded_polyline);
    const cleanedPoints = cleanStationaryClusters(originalPoints, radiusM, minClusterSize);
    const removedCount = originalPoints.length - cleanedPoints.length;
    const cleanedPolyline = encodePolyline(cleanedPoints);

    if (dryRun) {
      return Response.json({
        success: true,
        dryRun: true,
        originalPointCount: originalPoints.length,
        cleanedPointCount: cleanedPoints.length,
        removedCount,
        cleanedPolyline,
      });
    }

    // Save the cleaned polyline back to the breadcrumb
    await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(breadcrumbId, {
      encoded_polyline: cleanedPolyline,
      point_count: cleanedPoints.length,
    });

    return Response.json({
      success: true,
      breadcrumbId,
      originalPointCount: originalPoints.length,
      cleanedPointCount: cleanedPoints.length,
      removedCount,
      cleanedPolyline,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});