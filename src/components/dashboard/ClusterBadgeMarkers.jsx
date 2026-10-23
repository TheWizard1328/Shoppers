import React from "react";
import { Marker } from "react-leaflet";
import L from "leaflet";

/**
 * ClusterBadgeMarkers (owner spec Oct 23 2026)
 *
 * ONE count badge per co-located marker group, centered on the cluster's
 * centroid — NOT attached to every marker at the location (the old per-marker
 * badges stacked into a messy blob). The badge is a standalone non-interactive
 * marker floating above the pins:
 *   - Collapsed: one badge sits on top of the stacked cluster.
 *   - Fanned: the badge STAYS at the cluster center point while the individual
 *     markers expand outward around it.
 *
 * The badge is informational only (pointer-events off) — taps pass through to
 * the markers beneath, so cluster-tap fanning behavior is unchanged.
 */

const badgeIconCache = new Map();

const badgeIcon = (count) => {
  if (badgeIconCache.has(count)) return badgeIconCache.get(count);
  // Same visual as the old per-marker cluster badge (red circle, white border)
  // so it reads as the same element — now single and centered.
  const icon = L.divIcon({
    html: `
      <div style="
        background: #EF4444;
        border: 2px solid white;
        border-radius: 50%;
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 8px;
        font-weight: bold;
        color: white;
        font-family: Arial, sans-serif;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
        pointer-events: none;
      " title="${count} stops at this location">${count}</div>
    `,
    className: "cluster-count-badge",
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  badgeIconCache.set(count, icon);
  return icon;
};

// Above every delivery marker tier (next-delivery 12000 / pending 11400 /
// active 11000) so the badge always crowns the cluster.
const BADGE_Z_INDEX = 13000;

export default function ClusterBadgeMarkers({ badges }) {
  if (!Array.isArray(badges) || badges.length === 0) return null;
  return badges.map((badge) => (
    <Marker
      key={`cluster-badge-${badge.key}`}
      position={[badge.lat, badge.lng]}
      icon={badgeIcon(badge.count)}
      zIndexOffset={BADGE_Z_INDEX}
      interactive={false}
      keyboard={false}
    />
  ));
}
