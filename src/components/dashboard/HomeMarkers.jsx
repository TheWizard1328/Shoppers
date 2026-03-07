import React from 'react';
import { Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { Home, Navigation } from 'lucide-react';
import { createHomeIcon } from './MapIcons';

export default function HomeMarkers({ driverHomeMarkers, map, isMobile, onMarkerClick }) {
  return driverHomeMarkers.map((home) => {
    if (!home.latitude || !home.longitude || typeof home.latitude !== 'number' || typeof home.longitude !== 'number' || isNaN(home.latitude) || isNaN(home.longitude)) return null;

    const handleClick = (e) => {
      if (onMarkerClick) onMarkerClick(home, 'home');
      if (!map) return;
      const targetZoom = isMobile ? 15 : 16;
      const statsCard = document.querySelector('[data-stats-card]');
      const statsCardHeight = statsCard ? statsCard.getBoundingClientRect().height : 0;
      const dynamicTopPadding = statsCardHeight + 20;
      const stopCardsEl = document.querySelector('.horizontal-cards-container');
      const balloonH = 120;
      let dynamicBottomPadding = balloonH + 20;
      if (stopCardsEl) dynamicBottomPadding = Math.max(stopCardsEl.getBoundingClientRect().height + balloonH + 20, balloonH + 20);
      const bounds = L.latLngBounds([[home.latitude, home.longitude], [home.latitude, home.longitude]]);
      map._loaded && map._mapPane?._leaflet_pos && map.fitBounds(bounds, { paddingTopLeft: [60, dynamicTopPadding + 50], paddingBottomRight: [60, dynamicBottomPadding], animate: true, duration: 0.6, maxZoom: targetZoom });
      setTimeout(() => {
        if (map._loaded && map._mapPane?._leaflet_pos && map.getZoom() < targetZoom) map.setZoom(targetZoom, { animate: true, duration: 0.3 });
        e.target.openPopup();
      }, 600);
    };

    return (
      <Marker key={home.id} position={[home.latitude, home.longitude]} icon={createHomeIcon(home.driverColor)} zIndexOffset={4000}
        eventHandlers={{ click: handleClick, mouseover: (e) => e.target.openPopup(), mouseout: (e) => e.target.closePopup() }}>
        <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
          <div className="min-w-[150px]">
            <div className="flex items-center gap-1.5">
              <Home className="w-3.5 h-3.5 text-emerald-600" />
              <h3 className="font-semibold text-xs">{home.driverName}</h3>
            </div>
            <p className="text-[11px] text-gray-600 mt-1">Final Destination (Home)</p>
            {home.isRouteComplete && (
              <button onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${home.latitude},${home.longitude}`, '_blank')}
                className="w-full mt-3 px-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded flex items-center justify-center gap-2 transition-colors">
                <Navigation className="w-3.5 h-3.5" />Go Home
              </button>
            )}
          </div>
        </Popup>
      </Marker>
    );
  });
}