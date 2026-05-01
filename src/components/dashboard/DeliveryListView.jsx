import { useState, useMemo, useCallback, memo, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { format, differenceInMinutes } from 'date-fns';
import { CheckCircle, Clock, Package, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { FixedSizeList as List } from 'react-window';
import { RouteManagementStopDetailsOverlay } from '../deliveries/RouteManagementHeader';
import BarcodeThumb from '../deliveries/BarcodeThumb';
import { getCodSymbolColorClass } from '../utils/SpecialSymbolsBadges';
import { isAppOwner } from '../utils/userRoles';

// Memoized row component to prevent re-renders
const DeliveryRow = memo(({
  delivery,
  patient,
  store,
  isSelected,
  onSelect,
  getStatusBadge,
  getTimeDisplay,
  getCODDisplay,
  onOpenMedia,
  isMobile,
  bulkEditMode,
  isBulkSelected,
  onBulkToggle,
  currentUser
}) => {
  const isPickup = !delivery.patient_id;
  const isNextDelivery = delivery.isNextDelivery === true;

  const desktopGridClass = bulkEditMode ?
  'grid min-w-max grid-cols-[44px_120px_120px_90px_minmax(300px,1fr)_minmax(200px,1fr)_100px_100px_40px_100px_120px] gap-2' :
  'grid min-w-max grid-cols-[120px_120px_90px_minmax(300px,1fr)_minmax(200px,1fr)_100px_100px_40px_100px_120px] gap-2';

  const handleRowClick = () => {
    if (bulkEditMode) {
      onBulkToggle(delivery.id);
      return;
    }
    onSelect(delivery.id);
  };

  return (
    isMobile ?
    <div
      onClick={handleRowClick}
      className={`flex h-full flex-col rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
      isNextDelivery ? 'bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/40 dark:hover:bg-blue-900/50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'} ${
      isSelected || isBulkSelected ? 'bg-slate-100 dark:bg-slate-800' : ''}`}
      style={{ borderColor: 'var(--border-slate-200)' }}>
      
        <div className="flex items-start gap-3">
          {bulkEditMode &&
        <div className="pt-1" onClick={(event) => event.stopPropagation()}>
              <Checkbox checked={isBulkSelected} onCheckedChange={() => onBulkToggle(delivery.id)} />
            </div>
        }
          <div className="flex-1">
        {/* Rows 1-2: Structured two-column layout */}
        <div className="grid grid-cols-[1fr_auto] gap-x-3">
          {/* Row 1 Left: Stop/TR */}
          <div className="flex items-center gap-2 min-w-0">
            <span className={`font-mono text-sm ${isNextDelivery ? 'font-bold text-blue-700' : 'text-slate-700'}`}>#{delivery.display_stop_order || delivery.stop_order || '—'}</span>
            <span className="font-mono text-[11px] text-slate-500">{delivery.tracking_number || '—'}</span>
          </div>

          {/* Row 1 Right: Store + Status */}
          <div className="flex flex-col items-end">
            <div className="flex flex-col items-center gap-1">
              {getStatusBadge(delivery.status)}
              {store?.abbreviation &&
                <Badge variant="outline" className="rounded-full text-[11px] px-2 py-0.5 max-w-full whitespace-normal break-words text-center" style={{ background: 'var(--bg-white)', color: store.color || 'var(--text-slate-600)', borderColor: store.color || 'var(--border-slate-300)' }}>
                  {store.abbreviation}{isAppOwner(currentUser) && delivery?.puid ? ` • ${delivery.puid}` : ''}
                </Badge>
                }
            </div>
          </div>

          {/* Row 2 Left: Patient/Pickup */}
          <div className="min-w-0 mt-1">
            <span className={`font-medium whitespace-normal break-words ${isPickup ? 'text-blue-600 dark:text-blue-300' : 'text-slate-900 dark:text-slate-100'}`}>
              {patient?.full_name || delivery.patient_name || (store?.name ? `${store.name} Pickup` : 'Store Pickup')}
            </span>
          </div>

          {/* Row 2 Right: Time centered under status */}
          <div className="mt-1 flex justify-center text-xs text-slate-600 dark:text-slate-300">
            {getTimeDisplay(delivery)}
          </div>
        </div>

        {/* Row 3: Address & Unit */}
        <div className="mt-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {patient?.address &&
              <span className="text-xs text-slate-500 truncate">{patient.address}</span>
              }
            {(patient?.unit_number || delivery.unit_number) &&
              <Badge variant="secondary" className="text-[10px] px-2 py-0.5" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                Unit {patient?.unit_number || delivery.unit_number}
              </Badge>
              }
          </div>
        </div>

        {/* Media + COD */}
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {delivery.signature_image_url ?
              <img src={delivery.signature_image_url} alt="Signature" className="w-7 h-7 rounded-sm object-cover border" style={{ borderColor: 'var(--border-slate-200)' }} /> :

              <span className="text-slate-400 text-sm">—</span>
              }
            {Array.isArray(delivery.proof_photo_urls) && delivery.proof_photo_urls.length > 0 ?
              <div className="flex -space-x-2">
                {delivery.proof_photo_urls.slice(0, 2).map((url, i) =>
                <img key={i} src={url} alt={`POD ${i + 1}`} className="w-7 h-7 rounded-md object-cover ring-2 ring-white" />
                )}
                {delivery.proof_photo_urls.length > 2 &&
                <div className="w-7 h-7 rounded-md bg-slate-200 text-slate-700 text-[10px] flex items-center justify-center ring-2 ring-white">+{delivery.proof_photo_urls.length - 2}</div>
                }
              </div> :

              <span className="text-slate-400 text-sm">—</span>
              }
            {Array.isArray(delivery.receipt_barcode_values) && delivery.receipt_barcode_values.length > 0 &&
              <div className="flex items-center gap-1">
                <div className="w-10 h-6 bg-white border rounded-sm overflow-hidden flex items-center" style={{ borderColor: 'var(--border-slate-200)' }}>
                  <BarcodeThumb value={delivery.receipt_barcode_values[0]} height={24} className="w-full h-6" />
                </div>
                <span className="text-[10px] text-slate-600">x{delivery.receipt_barcode_values.length}</span>
              </div>
              }
            {Array.isArray(delivery.barcode_values) && delivery.barcode_values.length > 0 &&
              <div className="flex items-center gap-1">
                <div className="w-10 h-6 bg-white border rounded-sm overflow-hidden flex items-center" style={{ borderColor: 'var(--border-slate-200)' }}>
                  <BarcodeThumb value={delivery.barcode_values[0]} height={24} className="w-full h-6" />
                </div>
                <span className="text-[10px] text-slate-600">x{delivery.barcode_values.length}</span>
              </div>
              }
          </div>
          <div>{getCODDisplay(delivery)}</div>
        </div>
          </div>
        </div>
      </div> :

    <div
      onClick={handleRowClick} className="py-2 grid min-w-max grid-cols-[80px_100px_90px_minmax(300px,1fr)_minmax(200px,1fr)_100px_100px_40px_100px_120px] gap-1 border-b cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"



      style={{ borderColor: 'var(--border-slate-200)' }}>
      
        {bulkEditMode &&
      <div className="flex items-center justify-center" onClick={(event) => event.stopPropagation()}>
            <Checkbox checked={isBulkSelected} onCheckedChange={() => onBulkToggle(delivery.id)} />
          </div>
      }
        <div className="flex items-center justify-center">
          <div className="flex flex-col leading-tight">
            <span className={`font-mono text-sm ${isNextDelivery ? 'font-bold text-blue-700' : 'text-slate-700'}`}>#{delivery.display_stop_order || delivery.stop_order || '—'}</span>
            <span className="font-mono text-[11px] text-slate-500">{delivery.tracking_number || '—'}</span>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center gap-1">
          {getStatusBadge(delivery.status)}
          {store?.abbreviation &&
        <Badge variant="outline" className="rounded-full text-[11px] px-2 py-0.5 max-w-full whitespace-normal break-words text-center" style={{ background: 'var(--bg-white)', color: store.color || 'var(--text-slate-600)', borderColor: store.color || 'var(--border-slate-300)' }}>
              {store.abbreviation}{isAppOwner(currentUser) && delivery?.puid ? ` • ${delivery.puid}` : ''}
            </Badge>
        }
        </div>

        <div className="flex items-center justify-center">
          {getTimeDisplay(delivery)}
        </div>

        <div className="flex items-center min-w-0">
          <div className="flex flex-col min-w-0">
            <span className={`font-medium whitespace-normal break-words ${isPickup ? 'text-blue-600 dark:text-blue-300' : 'text-slate-900 dark:text-slate-100'}`}>
              {patient?.full_name || delivery.patient_name || (store?.name ? `${store.name} Pickup` : 'Store Pickup')}
            </span>
            {patient?.address &&
          <span className="text-xs text-slate-500 truncate">{patient.address}</span>
          }
          </div>
        </div>

        {/* Notes column */}
        <div className="flex min-w-0 items-start py-1 text-xs text-slate-700">
          <div className="min-w-0 w-full space-y-1 whitespace-normal break-words leading-4">
            {patient?.notes &&
          <div className="w-full"><span className="text-slate-500">P:</span> {patient.notes}</div>
          }
            {delivery?.delivery_notes &&
          <div className="w-full"><span className="text-slate-500">D:</span> {delivery.delivery_notes}</div>
          }
          </div>
        </div>

        {/* Receipts barcode */}
        <div className="flex items-center justify-center">
          {Array.isArray(delivery.receipt_barcode_values) && delivery.receipt_barcode_values.length > 0 ?
        <button
          className="flex items-center gap-1 cursor-zoom-in"
          onClick={(e) => {e.stopPropagation();onOpenMedia({ type: 'barcode', value: delivery.receipt_barcode_values[0], title: 'Receipt Barcode' });}}>
          
              <div className="w-[72px] h-7 bg-white border rounded-sm overflow-hidden flex items-center" style={{ borderColor: 'var(--border-slate-200)' }}>
                <BarcodeThumb value={delivery.receipt_barcode_values[0]} height={28} className="w-full h-7" />
              </div>
              <span className="text-[11px] text-slate-600">x{delivery.receipt_barcode_values.length}</span>
            </button> :

        <div className="w-[72px] h-7 bg-white border rounded-sm overflow-hidden flex items-center justify-center text-slate-400" style={{ borderColor: 'var(--border-slate-200)' }}>—</div>
        }
        </div>

        {/* Rx barcode */}
        <div className="flex items-center justify-center">
          {Array.isArray(delivery.barcode_values) && delivery.barcode_values.length > 0 ?
        <button
          className="flex items-center gap-1 cursor-zoom-in"
          onClick={(e) => {e.stopPropagation();onOpenMedia({ type: 'barcode', value: delivery.barcode_values[0], title: 'Rx Barcode' });}}>
          
              <div className="w-[72px] h-7 bg-white border rounded-sm overflow-hidden flex items-center" style={{ borderColor: 'var(--border-slate-200)' }}>
                <BarcodeThumb value={delivery.barcode_values[0]} height={28} className="w-full h-7" />
              </div>
              <span className="text-[11px] text-slate-600">x{delivery.barcode_values.length}</span>
            </button> :

        <div className="w-[72px] h-7 bg-white border rounded-sm overflow-hidden flex items-center justify-center text-slate-400" style={{ borderColor: 'var(--border-slate-200)' }}>—</div>
        }
        </div>

        {/* Signature */}
        <div className="flex items-center justify-center">
          {delivery.signature_image_url ?
        <img
          src={delivery.signature_image_url}
          alt="Signature"
          className="w-8 h-8 rounded-sm object-cover border cursor-zoom-in"
          style={{ borderColor: 'var(--border-slate-200)' }}
          onClick={(e) => {e.stopPropagation();onOpenMedia({ type: 'image', src: delivery.signature_image_url, title: 'Signature' });}} /> :


        <div className="w-8 h-8 rounded-sm border flex items-center justify-center text-slate-400" style={{ borderColor: 'var(--border-slate-200)' }}>—</div>
        }
        </div>

        {/* Photos */}
        <div className="flex items-center justify-center">
          {Array.isArray(delivery.proof_photo_urls) && delivery.proof_photo_urls.length > 0 ?
        <div className="flex -space-x-2">
              {delivery.proof_photo_urls.slice(0, 3).map((url, i) =>
          <img
            key={i}
            src={url}
            alt={`POD ${i + 1}`}
            className="w-8 h-8 rounded-md object-cover ring-2 ring-white cursor-zoom-in"
            onClick={(e) => {e.stopPropagation();onOpenMedia({ type: 'image', src: url, title: `Photo ${i + 1}` });}} />

          )}
              {delivery.proof_photo_urls.length > 3 &&
          <div
            className="w-8 h-8 rounded-md bg-slate-200 text-slate-700 text-[11px] flex items-center justify-center ring-2 ring-white cursor-zoom-in"
            onClick={(e) => {e.stopPropagation();onOpenMedia({ type: 'image', src: delivery.proof_photo_urls[2], title: 'Photo' });}}>
            
                  +{delivery.proof_photo_urls.length - 3}
                </div>
          }
            </div> :

        <div className="w-8 h-8 rounded-md border flex items-center justify-center text-slate-400" style={{ borderColor: 'var(--border-slate-200)' }}>—</div>
        }
        </div>

        {/* COD */}
        <div className="flex items-center justify-center min-w-[90px]">
          {getCODDisplay(delivery)}
        </div>
      </div>);


});

DeliveryRow.displayName = 'DeliveryRow';

const MOBILE_ROW_HEIGHT = 164;
const DESKTOP_ROW_HEIGHT = 96;
const DESKTOP_LIST_WIDTH = 1400;
const DESKTOP_BULK_LIST_WIDTH = 1456;

const DeliveryListView = ({
  deliveries,
  patients,
  stores,
  drivers,
  currentUser,
  onEdit,
  onEditPatient,
  onDelete,
  onRestart,
  onStatusUpdate,
  onNotesUpdate,
  onCODUpdate,
  onCreateReturn,
  onStartDelivery,
  allDeliveries,
  selectedDate,
  onDriverStatusChange,
  isMobile,
  bulkEditMode = false,
  bulkSelectedIds = [],
  onBulkToggle = () => {},
  onBulkToggleAllVisible = () => {}
}) => {
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);
  const [mediaPreview, setMediaPreview] = useState(null);
  const headerScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);
  const syncScrollSourceRef = useRef(null);
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const [listViewportWidth, setListViewportWidth] = useState(0);

  // Memoize patient lookup map for O(1) access
  const patientMap = useMemo(() => {
    const map = new Map();
    patients.forEach((p) => {
      if (p?.id) map.set(p.id, p);
      if (p?.patient_id) map.set(p.patient_id, p);
    });
    return map;
  }, [patients]);

  // Memoize store lookup map for O(1) access
  const storeMap = useMemo(() => {
    const map = new Map();
    stores.forEach((s) => {if (s?.id) map.set(s.id, s);});
    return map;
  }, [stores]);

  const getStatusBadge = useCallback((status) => {
    const statusConfig = {
      completed: { color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300', label: 'Completed' },
      in_transit: { color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', label: 'In Transit' },
      en_route: { color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', label: 'En Route' },
      pending: { color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300', label: 'Pending' },
      failed: { color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300', label: 'Failed' },
      cancelled: { color: 'bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-200', label: 'Cancelled' }
    };
    const config = statusConfig[status] || { color: 'bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-200', label: String(status || '') };
    return <Badge className={config.color}>{config.label}</Badge>;
  }, []);

  const getCODDisplay = useCallback((delivery) => {
    const requiredAmount = Number(delivery?.cod_total_amount_required || 0);
    if (requiredAmount <= 0) {
      return <span className="text-slate-400">—</span>;
    }

    const payments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
    const hasPayments = payments.length > 0;
    const totalCollected = payments.reduce((sum, p) => sum + Number(p?.amount || 0), 0);
    const codSymbolColorClass = getCodSymbolColorClass(delivery);

    if (hasPayments) {
      const types = Array.from(new Set(payments.map((p) => p?.type).filter(Boolean)));
      return (
        <div className="flex flex-col items-center">
          <span className="font-semibold text-slate-900 dark:text-slate-100"><span className={codSymbolColorClass}>$</span>{requiredAmount.toFixed(2)}</span>
          <span className="text-xs text-emerald-600 dark:text-emerald-300">Collected{types.length ? ` • ${types.join(' + ')}` : ''}</span>
        </div>);

    }

    return (
      <div className="flex flex-col items-center">
        <span className="font-semibold text-slate-900 dark:text-slate-100"><span className={codSymbolColorClass}>$</span>{requiredAmount.toFixed(2)}</span>
        <span className="text-xs text-amber-600 dark:text-amber-300">Pending collection</span>
      </div>);

  }, []);

  const getTimeDisplay = useCallback((delivery) => {
    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    const extractStoredTime = (value) => {
      if (!value) return null;
      const raw = String(value);
      const isoMatch = raw.match(/T(\d{2}:\d{2})/);
      if (isoMatch) return isoMatch[1];
      const timeMatch = raw.match(/^(\d{2}:\d{2})/);
      return timeMatch ? timeMatch[1] : null;
    };
    const toComparableDate = (value) => {
      if (!value) return null;
      const parsed = new Date(value);
      return isNaN(parsed.getTime()) ? null : parsed;
    };

    if (finishedStatuses.includes(delivery.status)) {
      const actualLabel = extractStoredTime(delivery.actual_delivery_time);
      const arrivalLabel = extractStoredTime(delivery.arrival_time);
      const at = toComparableDate(delivery.actual_delivery_time);
      const arr = toComparableDate(delivery.arrival_time);
      let minutesOnSite = null;
      if (at && arr) {
        try {
          minutesOnSite = Math.max(0, differenceInMinutes(at, arr));
        } catch {}
      }

      if (actualLabel || arrivalLabel) {
        return (
          <div className="flex flex-col items-center text-green-700 leading-tight">
            <div className="flex items-center gap-1">
              <CheckCircle className="w-3.5 h-3.5" />
              <span className="font-medium">{actualLabel || arrivalLabel}</span>
            </div>
            {minutesOnSite !== null &&
            <span className="text-[11px] text-slate-500">{minutesOnSite} min</span>
            }
          </div>);
      }
    }

    const eta = delivery.delivery_time_eta || delivery.delivery_time_start;
    if (eta) {
      return (
        <div className="flex items-center gap-1 text-blue-700">
          <Clock className="w-3.5 h-3.5" />
          <span className="font-medium">{eta}</span>
        </div>);

    }

    return <span className="text-slate-400">—</span>;
  }, []);

  const handleSelect = useCallback((deliveryId) => {
    setSelectedDeliveryId((prev) => prev === deliveryId ? null : deliveryId);
  }, []);

  const handleOpenMedia = useCallback((payload) => {
    setMediaPreview(payload);
  }, []);

  const selectedDelivery = useMemo(() =>
  selectedDeliveryId ? deliveries.find((d) => d?.id === selectedDeliveryId) : null,
  [selectedDeliveryId, deliveries]);

  const selectedPatient = useMemo(() =>
  selectedDelivery?.patient_id ? patientMap.get(selectedDelivery.patient_id) : null,
  [selectedDelivery?.patient_id, patientMap]);

  const selectedStore = useMemo(() =>
  selectedDelivery ? storeMap.get(selectedDelivery.store_id) : null,
  [selectedDelivery?.store_id, storeMap]);

  const allVisibleSelected = deliveries.length > 0 && deliveries.every((delivery) => bulkSelectedIds.includes(delivery.id));
  const someVisibleSelected = deliveries.some((delivery) => bulkSelectedIds.includes(delivery.id));

  useEffect(() => {
    if (bulkEditMode) {
      setSelectedDeliveryId(null);
    }
  }, [bulkEditMode]);

  useEffect(() => {
    const container = bodyScrollRef.current;
    if (!container) return;

    const updateSize = () => {
      setListViewportHeight(container.clientHeight);
      setListViewportWidth(container.clientWidth);
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    window.addEventListener('resize', updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [isMobile, bulkEditMode]);

  const syncHeaderScroll = useCallback((event) => {
    if (syncScrollSourceRef.current === 'body') {
      syncScrollSourceRef.current = null;
      return;
    }
    if (!bodyScrollRef.current) return;
    syncScrollSourceRef.current = 'header';
    bodyScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  const syncBodyScroll = useCallback((event) => {
    if (syncScrollSourceRef.current === 'header') {
      syncScrollSourceRef.current = null;
      return;
    }
    if (!headerScrollRef.current) return;
    syncScrollSourceRef.current = 'body';
    headerScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  const desktopContentWidth = bulkEditMode ? DESKTOP_BULK_LIST_WIDTH : DESKTOP_LIST_WIDTH;
  const listWidth = Math.max(isMobile ? listViewportWidth : Math.max(listViewportWidth, desktopContentWidth), 1);
  const listHeight = Math.max(listViewportHeight, 1);

  const renderVirtualRow = useCallback(({ index, style }) => {
    const delivery = deliveries[index];
    if (!delivery) return null;

    const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
    const store = storeMap.get(delivery.store_id);

    return (
      <div style={isMobile ? { ...style, padding: '0 8px 8px', boxSizing: 'border-box' } : style}>
        <DeliveryRow
          delivery={delivery}
          patient={patient}
          store={store}
          isSelected={selectedDeliveryId === delivery.id}
          onSelect={handleSelect}
          getStatusBadge={getStatusBadge}
          getTimeDisplay={getTimeDisplay}
          getCODDisplay={getCODDisplay}
          onOpenMedia={handleOpenMedia}
          isMobile={isMobile}
          bulkEditMode={bulkEditMode}
          isBulkSelected={bulkSelectedIds.includes(delivery.id)}
          onBulkToggle={onBulkToggle}
          currentUser={currentUser} />
        
      </div>);

  }, [deliveries, patientMap, storeMap, selectedDeliveryId, handleSelect, getStatusBadge, getTimeDisplay, getCODDisplay, handleOpenMedia, isMobile, bulkEditMode, bulkSelectedIds, onBulkToggle]);

  const getItemKey = useCallback((index) => {
    const delivery = deliveries[index];
    return delivery?.id || `${delivery?.delivery_date || 'unknown'}-${delivery?.patient_id ?? 'pickup'}-${delivery?.store_id ?? 'store'}-${delivery?.tracking_number || index}`;
  }, [deliveries]);

  return (
    <>
      <style>{`.delivery-list-header-scroll{scrollbar-width:none;-ms-overflow-style:none;}.delivery-list-header-scroll::-webkit-scrollbar{display:none;}`}</style>
      <div className="h-full max-h-full w-full max-w-full min-h-0 min-w-0 flex flex-col relative overflow-hidden" style={{ background: 'var(--bg-white)' }}>
        {/* Table Header */}
        <div className="sticky top-0 flex-shrink-0 border-b z-20" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
          {!isMobile &&
          <div
            ref={headerScrollRef}
            onScroll={syncHeaderScroll}
            className="delivery-list-header-scroll max-w-full overflow-x-auto overflow-y-hidden">
            
              <div className={`${bulkEditMode ? 'grid min-w-max grid-cols-[44px_120px_120px_90px_minmax(300px,1fr)_minmax(200px,1fr)_100px_100px_40px_100px_120px]' : 'grid min-w-max grid-cols-[120px_120px_90px_minmax(300px,1fr)_minmax(200px,1fr)_100px_100px_40px_100px_120px]'} gap-2 px-4 py-3 text-sm font-semibold`} style={{ color: 'var(--text-slate-700)', width: listWidth }}>
                {bulkEditMode &&
              <div className="flex items-center justify-center">
                    <Checkbox
                  checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                  onCheckedChange={() => onBulkToggleAllVisible()} />
                
                  </div>
              }
                <div className="text-center">Stop/TR</div>
                <div className="text-center">Status</div>
                <div className="text-center">Time</div>
                <div className="text-left">Patient/Pickup</div>
                <div className="text-left">Notes</div>
                <div className="text-center">Receipts</div>
                <div className="text-center">Rx</div>
                <div className="text-center">Signature</div>
                <div className="text-center">Photos</div>
                <div className="text-center">COD</div>
              </div>
            </div>
          }
        </div>

        {/* Scrollable List */}
        <div
          ref={bodyScrollRef}
          onScroll={syncBodyScroll}
          className="flex-1 min-h-0 min-w-0 h-full w-full max-h-full max-w-full overflow-x-auto overflow-y-hidden">
          {deliveries.length === 0 ?
          <div className="flex items-center justify-center h-32 text-slate-500">
              No deliveries found
            </div> :
          listViewportHeight > 0 && listViewportWidth > 0 ?
          <div className={!isMobile ? 'min-w-max' : 'w-full'} style={{ width: listWidth }}>
              <List
              height={listHeight}
              width={listWidth}
              itemCount={deliveries.length}
              itemSize={isMobile ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT}
              itemKey={getItemKey}
              overscanCount={8}>
                {renderVirtualRow}
              </List>
            </div> :
          <div className="flex items-center justify-center h-32 text-slate-500">
              Loading deliveries...
            </div>
          }
        </div>
      </div>

        {/* Centered media preview */}
        <AnimatePresence>
          {mediaPreview &&
        <>
              <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/60 z-[300]"
            onClick={() => setMediaPreview(null)} />
          
              <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            className="fixed inset-0 z-[301] flex items-center justify-center p-4"
            onClick={() => setMediaPreview(null)}>
            
                <div className="rounded-lg shadow-xl p-3 bg-white dark:bg-slate-900 max-w-[90vw] max-h-[85vh] flex items-center justify-center">
                  {mediaPreview.type === 'image' &&
              <img src={mediaPreview.src} alt={mediaPreview.title || 'Preview'} className="max-w-[85vw] max-h-[80vh] object-contain" />
              }
                  {mediaPreview.type === 'barcode' &&
              <div className="bg-white p-4 rounded-md border" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <BarcodeThumb value={mediaPreview.value} height={120} className="w-[360px] h-28" />
                    </div>
              }
                </div>
              </motion.div>
            </>
        }
        </AnimatePresence>

        {/* Slide-in Details Panel Overlay */}
      <AnimatePresence>
        {selectedDeliveryId && selectedDelivery &&
        <RouteManagementStopDetailsOverlay
          selectedDeliveryId={selectedDeliveryId}
          selectedDelivery={selectedDelivery}
          selectedPatient={selectedPatient}
          selectedStore={selectedStore}
          currentUser={currentUser}
          onEdit={onEdit}
          onEditPatient={onEditPatient}
          onDelete={onDelete}
          onRestart={onRestart}
          onStatusUpdate={onStatusUpdate}
          onNotesUpdate={onNotesUpdate}
          onCODUpdate={onCODUpdate}
          onCreateReturn={onCreateReturn}
          onStartDelivery={onStartDelivery}
          allDeliveries={allDeliveries}
          selectedDate={selectedDate}
          patients={patients}
          stores={stores}
          drivers={drivers}
          onDriverStatusChange={onDriverStatusChange}
          isMobile={isMobile}
          onClose={() => setSelectedDeliveryId(null)} />

        }
      </AnimatePresence>
    </>);

};

export default memo(DeliveryListView);