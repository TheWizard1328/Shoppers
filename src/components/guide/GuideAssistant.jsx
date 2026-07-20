/**
 * GuideAssistant.jsx — Floating conversational guide assistant for RxDeliver.
 * Provides step-by-step guidance, quick actions, contextual tips, and onboarding.
 * Works offline — no API calls required for core functionality.
 *
 * Positioning: On mobile, the floating button sits above the FAB controls which
 * sit above the stop cards. It reads --stop-cards-height (set by Dashboard) and
 * --bottom-nav-height to compute its position dynamically.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, Send, ChevronRight, RotateCcw, Lightbulb, Navigation } from 'lucide-react';
import { useAppData } from '@/components/utils/AppDataContext';
import { isAppOwner, userHasRole, getPrimaryRole } from '@/components/utils/userRoles';
import { QUICK_ACTIONS, FLOWS, PAGE_TIPS, PAGE_CONTEXT, matchIntent } from './guideFlows';
import {
  detectPatientQuery,
  findPatientByName,
  findAllPatientsByName,
  findCurrentDeliveryPatient,
  getPatientDeliveryStats,
  buildPatientResponse,
} from './patientQueryHandler';
import { getLocalDeliveryPredictions } from '@/components/deliveries/getLocalDeliveryPredictions';

const STORAGE_KEY = 'rxdeliver_guide_seen';
const CONVERSATION_KEY = 'rxdeliver_guide_conversation';
const DAILY_GREETING_KEY = 'rxdeliver_guide_daily_greeting_v4';


const MOTIVATIONAL_QUOTES = [
  "The way to get started is to quit talking and begin doing. — Walt Disney",
  "Success is not final, failure is not fatal: it is the courage to continue that counts. — Winston Churchill",
  "Believe you can and you're halfway there. — Theodore Roosevelt",
  "It always seems impossible until it's done. — Nelson Mandela",
  "The only way to do great work is to love what you do. — Steve Jobs",
  "Don't watch the clock; do what it does. Keep going. — Sam Levenson",
  "The future depends on what you do today. — Mahatma Gandhi",
  "Every accomplishment starts with the decision to try. — Unknown",
  "You don't have to be great to start, but you have to start to be great. — Zig Ziglar",
  "The hard days are what make you stronger. — Aly Raisman",
  "Mile by mile, it's a style; but yard by yard, it's hard. — Unknown",
  "Done is better than perfect.",
  "Small steps every day add up to big results.",
  "Your patients are counting on you. Let's make it happen! 🚀",
  "Smooth roads never make good drivers. Keep pushing! 💪",
];

// FAB is h-10 (40px) + 10px gap above stop cards + 8px gap above FAB
const FAB_HEIGHT = 40;
const FAB_GAP = 10;
const GUIDE_GAP = 8;

export default function GuideAssistant() {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser, deliveries: appDeliveries, patients: appPatients, stores: appStores, drivers: appDrivers } = useAppData();
  const [isOpen, setIsOpen] = useState(false);
  const [isStopCardExpanded, setIsStopCardExpanded] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [hasSeenIntro, setHasSeenIntro] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
  });
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [activeFlow, setActiveFlow] = useState(null);
  const [currentStepId, setCurrentStepId] = useState(null);
  const [showQuickActions, setShowQuickActions] = useState(true);
  const [showTips, setShowTips] = useState(false);
  const [pageTipIndex, setPageTipIndex] = useState(0);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // ── Track stop card expansion and dialog open state ──────────────────────────
  // Hide the FAB when a stop card is expanded but no dialog/form is open.
  useEffect(() => {
    const handleExpand = (e) => setIsStopCardExpanded(!!(e?.detail?.cardId));
    const handleDialogOpen = () => setIsDialogOpen(true);
    const handleDialogClose = () => setIsDialogOpen(false);

    window.addEventListener('stopCardExpandedChange', handleExpand);
    // Re-use the existing pauseBackgroundSync / resumeBackgroundSync events which
    // are fired when forms/dialogs open and close (DeliveryForm, PatientForm, etc.)
    window.addEventListener('pauseBackgroundSync', handleDialogOpen);
    window.addEventListener('resumeBackgroundSync', handleDialogClose);
    return () => {
      window.removeEventListener('stopCardExpandedChange', handleExpand);
      window.removeEventListener('pauseBackgroundSync', handleDialogOpen);
      window.removeEventListener('resumeBackgroundSync', handleDialogClose);
    };
  }, []);

  // FAB should be hidden when a stop card is expanded and no dialog is open
  const hideFabForExpandedCard = isStopCardExpanded && !isDialogOpen && !isOpen;

  // ── Dynamic bottom offset — tracks MapViewCycleFAB via getBoundingClientRect ────
  // Uses direct DOM measurement (viewport-accurate regardless of position context).
  // Polls every 300ms so it catches any layout changes quickly.
  const [guideBottomPx, setGuideBottomPx] = useState(80);
  const [guideRightPx] = useState(16);

  useEffect(() => {
    const compute = () => {
      if (window.innerWidth >= 850) {
        setGuideBottomPx(24);
        return;
      }
      const fabEl = document.querySelector('[data-map-cycle-fab]');
      if (fabEl) {
        const rect = fabEl.getBoundingClientRect();
        // viewport bottom → top of MapCycleFAB + 8px gap
        const fromBottom = window.innerHeight - rect.top + 8;
        setGuideBottomPx(fromBottom);
      } else {
        // No MapCycleFAB (non-Dashboard page) — sit above bottom nav
        const navEl = document.querySelector('[data-mobile-bottom-nav]');
        setGuideBottomPx((navEl ? navEl.offsetHeight : 0) + 12);
      }
    };

    compute();
    const interval = setInterval(compute, 300);
    window.addEventListener('resize', compute);
    window.addEventListener('orientationchange', compute);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', compute);
      window.removeEventListener('orientationchange', compute);
    };
  }, []);

  // ── Determine current page and role ───────────────────────────────
  const currentPageName = useMemo(() => {
    const path = location.pathname.replace(/^\//, '');
    return path || 'Dashboard';
  }, [location.pathname]);

  const userRole = useMemo(() => {
    if (!currentUser) return 'driver';
    if (isAppOwner(currentUser)) return 'admin';
    return getPrimaryRole(currentUser) || 'driver';
  }, [currentUser]);

  // Today0027s date for patient queries and delivery lookups
  const todayStr = new Date().toLocaleDateString("en-CA");
  const pageContext = PAGE_CONTEXT[currentPageName] || null;
  const pageTips = pageContext ? PAGE_TIPS[pageContext.tips] || [] : [];

  // ── Daily greeting logic ──────────────────────────────────────────
  const [hasShownDailyGreeting, setHasShownDailyGreeting] = useState(() => {
    try {
      const stored = localStorage.getItem(DAILY_GREETING_KEY);
      const today = new Date().toLocaleDateString('en-CA');
      return stored === today;
    } catch { return false; }
  });

  const getLocalDateString = useCallback((date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }, []);

  const generateDailyGreeting = useCallback(() => {
    const today = getLocalDateString(new Date());
    const roleLabel = userRole === 'admin' ? 'admin' : userRole === 'dispatcher' ? 'dispatcher' : 'driver';
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const quote = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];

    if (userRole === 'driver') {
      // Count pending stops for today
      const myDeliveries = (appDeliveries || []).filter((d) =>
        d && d.delivery_date === today &&
        d.driver_id === currentUser?.id &&
        !['completed', 'returned', 'cancelled'].includes(d.status)
      );
      const count = myDeliveries.length;
      const completed = (appDeliveries || []).filter((d) =>
        d && d.delivery_date === today &&
        d.driver_id === currentUser?.id &&
        d.status === 'completed'
      ).length;

      let msg = `${greeting}! ☀️\n\n`;
      if (count > 0) {
        msg += `You have **${count} stop${count !== 1 ? 's' : ''}** lined up for today`;
        if (completed > 0) msg += ` (${completed} already completed ✅)`;
        msg += `.\n\n`;
      } else {
        msg += `No pending stops for today. Enjoy the lighter day! 😊\n\n`;
      }
      msg += `💪 \"${quote}\"`;
      return [{ text: msg, actions: [] }];
    }

    if (userRole === 'dispatcher' || userRole === 'admin') {
      // Get projected deliveries for today
      const predictions = getLocalDeliveryPredictions({
        currentUser,
        stores: appStores,
        patients: appPatients,
        allDeliveries: appDeliveries,
        selectedDate: today,
        scheduledDriverMap: {},
      });

      // Count active deliveries scoped to this user's visible stores
      const myStoreIds = new Set(currentUser?.store_ids || []);
      const isAdminRole = userRole === 'admin';
      const todaysDeliveries = (appDeliveries || []).filter((d) =>
        d && d.delivery_date === today &&
        (isAdminRole || myStoreIds.has(d.store_id)) &&
        !['completed', 'returned', 'cancelled'].includes(d.status)
      );

      let msg = `${greeting}! ☀️\n\n`;
      msg += `**Today's Overview:**\n`;
      msg += `• ${todaysDeliveries.length} active delivery${todaysDeliveries.length !== 1 ? 's' : ''} in progress\n`;
      msg += `• ${predictions.length} projected delivery${predictions.length !== 1 ? 's' : ''} from recurring schedules\n\n`;

      if (predictions.length > 0) {
        msg += `**Potential deliveries to add:**\n`;
        const top = predictions.slice(0, 5);
        for (const p of top) {
          const store = (appStores || []).find((s) => s.id === p.store_id);
          const storeName = store?.name || store?.abbreviation || 'Unknown store';
          msg += `• ${p.patient_name} — ${storeName} (${p.reason})\n`;
        }
        if (predictions.length > 5) {
          msg += `• ...and ${predictions.length - 5} more\n`;
        }
        msg += `\n💪 \"${quote}\"`;

        return [{
          text: msg,
          actions: [
            { label: '📅 Add To Route', type: 'open_add_to_route' },
            { label: 'Dismiss', type: 'dismiss' },
          ],
        }];
      } else {
        msg += `No new projected deliveries for today.\n\n💪 \"${quote}\"`;
        return [{ text: msg, actions: [] }];
      }
    }

    return [{ text: `${greeting}! 💪 \"${quote}\"`, actions: [] }];
  }, [userRole, currentUser, appDeliveries, appPatients, appStores, getLocalDateString]);

  const markDailyGreetingShown = useCallback(() => {
    try {
      const today = new Date().toLocaleDateString('en-CA');
      localStorage.setItem(DAILY_GREETING_KEY, today);
      setHasShownDailyGreeting(true);
    } catch { /* ignore */ }
  }, []);



  // ── Role-filtered quick actions ──────────────────────────────────
  const visibleQuickActions = useMemo(() => {
    if (userRole === 'driver') {
      return QUICK_ACTIONS.filter(a =>
        ['start_route', 'collect_cod', 'upload_docs', 'manage_schedule', 'patient_info', 'getting_started'].includes(a.id)
      );
    }
    if (userRole === 'dispatcher') {
      return QUICK_ACTIONS.filter(a =>
        ['create_delivery', 'create_patient', 'patient_info', 'getting_started'].includes(a.id)
      );
    }
    // Admin sees all
    return QUICK_ACTIONS;
  }, [userRole]);

  // ── Show pulse animation for new users ───────────────────────────
  const [showPulse, setShowPulse] = useState(!hasSeenIntro);

  // ── Persist conversation ──────────────────────────────────────────
  useEffect(() => {
    if (messages.length > 0) {
      try {
        localStorage.setItem(CONVERSATION_KEY, JSON.stringify(messages.slice(-20)));
      } catch { /* ignore */ }
    }
  }, [messages]);

  // ── Restore conversation on mount ────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CONVERSATION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
          setShowQuickActions(false);
        }
      }
    } catch { /* ignore */ }
  }, []);

  // ── Auto-open on first app load of the day ──────────────────────
  useEffect(() => {
    // Only fire on mount (empty deps). Check if daily greeting already shown.
    if (hasShownDailyGreeting) return;

    // If there's a restored conversation from a previous session, don't
    // auto-open — the user can open the guide manually.
    try {
      const saved = localStorage.getItem(CONVERSATION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return;
      }
    } catch { /* ignore */ }

    // Small delay so data (deliveries, patients) has time to load
    // before generating the greeting, and to avoid jarring instant popup.
    const timer = setTimeout(() => {
      // Double-check in case user manually opened during the delay
      if (!isOpen) {
        setIsOpen(true);
        setShowPulse(false);
        try { localStorage.setItem(STORAGE_KEY, 'true'); } catch { /* ignore */ }
        setHasSeenIntro(true);

        const greetingMessages = generateDailyGreeting();
        for (const msg of greetingMessages) {
          addBotMessage(msg.text, msg.actions);
        }
        markDailyGreetingShown();
        if (!greetingMessages.some((m) => m.actions && m.actions.length > 0)) {
          setShowQuickActions(true);
        }
      }
    }, 800);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll to bottom ────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, showQuickActions]);

  // ── Add a bot message ────────────────────────────────────────────
  const addBotMessage = useCallback((text, actions = []) => {
    setMessages(prev => [...prev, {
      id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'bot',
      text,
      actions,
      timestamp: Date.now(),
    }]);
  }, []);

  // ── Add a user message ───────────────────────────────────────────
  const addUserMessage = useCallback((text) => {
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text,
      timestamp: Date.now(),
    }]);
  }, []);

  // ── Start a guided flow ──────────────────────────────────────────
  const startFlow = useCallback((flowId) => {
    const flow = FLOWS[flowId];
    if (!flow) return;
    setActiveFlow(flowId);
    setCurrentStepId(flow.steps[0].id);
    setShowQuickActions(false);
    setShowTips(false);
    addBotMessage(flow.steps[0].bot, flow.steps[0].actions || []);
  }, [addBotMessage]);

  // ── Navigate to a step within a flow ──────────────────────────────
  const goToStep = useCallback((stepId) => {
    const flow = activeFlow ? FLOWS[activeFlow] : null;
    if (!flow) return;
    const step = flow.steps.find(s => s.id === stepId);
    if (step) {
      setCurrentStepId(stepId);
      addBotMessage(step.bot, step.actions || []);
    }
  }, [activeFlow, addBotMessage]);

  // ── Patient pool scoped to role (must be before handleAction) ─────
  // Memoized so handlePatientQuery deps are stable across renders.
  const getAllowedPatients = useMemo(() => {
    if (!appPatients || !currentUser) return [];
    const userRole = isAppOwner(currentUser) ? 'admin' : getPrimaryRole(currentUser) || 'driver';
    if (userRole === 'admin') return appPatients;
    if (userRole === 'dispatcher') {
      const myStoreIds = new Set(currentUser?.store_ids || []);
      if (myStoreIds.size === 0) return [];
      return appPatients.filter(p => p && myStoreIds.has(p.store_id));
    }
    // Driver: patients from stores they have deliveries for
    const myStoreIds = new Set();
    for (const d of (appDeliveries || [])) {
      if (d && d.driver_id === currentUser?.id && d.store_id) {
        myStoreIds.add(d.store_id);
      }
    }
    if (myStoreIds.size === 0) return [];
    return appPatients.filter(p => p && myStoreIds.has(p.store_id));
  }, [appPatients, currentUser, appDeliveries]);

  // ── Handle user input ────────────────────────────────────────────────────────
  // ── Patient info lookup ──────────────────────────────────────────
  const handlePatientQuery = useCallback((queryResult) => {
    const userRole = currentUser ? (isAppOwner(currentUser) ? 'admin' : getPrimaryRole(currentUser) || 'driver') : 'driver';
    const isDriver = userRole === 'driver';
    const isDispatcher = userRole === 'dispatcher';
    const isAdmin = userRole === 'admin';

    // Drivers, dispatchers, and admins can use patient lookup
    if (!isDriver && !isDispatcher && !isAdmin) {
      addBotMessage("Patient lookups are available for drivers, dispatchers, and admins only.", []);
      setShowQuickActions(true);
      return;
    }

    let patient = null;
    let delivery = null;
    let includeAdvice = false;

    if (queryResult.type === 'current') {
      // Current delivery patient
      const result = findCurrentDeliveryPatient(currentUser, appDeliveries, appPatients, todayStr);
      if (!result) {
        addBotMessage(
          "You don't have an active delivery right now. Once you start a route, type **'info'** to get patient details for your next stop.",
          []
        );
        setShowQuickActions(true);
        return;
      }
      patient = result.patient;
      delivery = result.delivery;
      includeAdvice = isDriver || isAdmin;
    } else if (queryResult.patientId) {
      // Direct patient ID from disambiguation selection — verify it's in allowed set
      const allowedPatients = getAllowedPatients();
      patient = allowedPatients?.find(p => p?.id === queryResult.patientId);
      if (!patient) {
        addBotMessage("You don't have access to that patient's information. Only patients from your assigned stores/deliveries can be looked up.", []);
        setShowQuickActions(true);
        return;
      }
      // Try to find a current delivery for this patient
      const today = todayStr;
      const activeDelivery = (appDeliveries || []).find(d =>
        d && d.delivery_date === today &&
        d.patient_id === patient.id &&
        !['completed', 'returned', 'cancelled'].includes(d.status)
      );
      if (activeDelivery) {
        delivery = activeDelivery;
        includeAdvice = isDriver || isAdmin;
      }
    } else {
      // Named patient search — scoped to allowed patients for this role
      const allowedPatients = getAllowedPatients();
      const matches = findAllPatientsByName(queryResult.patientName, allowedPatients);
      if (matches.length === 0) {
        const scopeMsg = isDispatcher
          ? 'Only patients from your assigned stores can be searched.'
          : isDriver
          ? 'Only patients from stores you have deliveries for can be searched.'
          : '';
        addBotMessage(
          `I couldn't find a patient named "**${queryResult.patientName}**" in your accessible patients. ${scopeMsg} Could you double-check the spelling? You can also type **'info'** for your current delivery patient.`,
          []
        );
        setShowQuickActions(true);
        return;
      }
      if (matches.length > 1) {
        // Multiple matches — show disambiguation with store badges
        const disambiguationActions = matches.slice(0, 8).map(({ patient: p }) => {
          const store = appStores?.find(s => s?.id === p.store_id);
          const storeAbbr = store?.abbreviation || '';
          const storeColor = store?.color || '#666';
          return {
            label: p.full_name || 'Unknown',
            type: 'select_patient',
            patientId: p.id,
            badgeText: storeAbbr || undefined,
            badgeColor: storeAbbr ? storeColor : undefined,
          };
        });
        addBotMessage(
          `I found **${matches.length}** patients matching "**${queryResult.patientName}**". Which one are you looking for?`,
          disambiguationActions
        );
        return; // Wait for user to select
      }
      // Single match — proceed directly
      patient = matches[0].patient;
      const today = todayStr;
      const activeDelivery = (appDeliveries || []).find(d =>
        d && d.delivery_date === today &&
        d.patient_id === patient.id &&
        !['completed', 'returned', 'cancelled'].includes(d.status)
      );
      if (activeDelivery) {
        delivery = activeDelivery;
        includeAdvice = isDriver || isAdmin;
      }
    }

    // Find the store
    const store = delivery ? appStores?.find(s => s?.id === delivery.store_id) : null;

    // Find city admins for no-answer advice
    let cityAdmins = [];
    if (includeAdvice && currentUser?.city_id) {
      cityAdmins = (appDrivers || []).filter(u =>
        u && u.app_roles?.includes('admin') &&
        (u.city_id === currentUser.city_id || (u.city_ids && u.city_ids.includes(currentUser.city_id)))
      );
    }

    // Compute delivery stats
    const stats = getPatientDeliveryStats(patient.id, appDeliveries);

    // Build the response
    const response = buildPatientResponse({ patient, delivery, stats, store, cityAdmins, includeAdvice });
    addBotMessage(response, []);
    setShowQuickActions(true);
  }, [currentUser, appDeliveries, appPatients, appStores, appDrivers, addBotMessage, setShowQuickActions, getAllowedPatients]);

  // ── Handle action button clicks ──────────────────────────────────
  const handleAction = useCallback((action) => {
    if (!action) return;

    switch (action.type) {
      case 'next': {
        const flow = activeFlow ? FLOWS[activeFlow] : null;
        if (!flow) return;
        const currentIdx = flow.steps.findIndex(s => s.id === currentStepId);
        const nextStep = flow.steps[currentIdx + 1];
        if (nextStep) {
          goToStep(nextStep.id);
        } else {
          addBotMessage("That's all for this guide! Is there anything else you'd like help with?");
          setActiveFlow(null);
          setCurrentStepId(null);
          setShowQuickActions(true);
        }
        break;
      }
      case 'jump': {
        goToStep(action.target);
        break;
      }
      case 'restart': {
        if (activeFlow) startFlow(activeFlow);
        break;
      }
      case 'end': {
        addBotMessage("You're all set! 👍 Feel free to ask if you need more help. I'm always here.");
        setActiveFlow(null);
        setCurrentStepId(null);
        setShowQuickActions(true);
        break;
      }
      case 'flow': {
        addUserMessage(action.label || action.target);
        startFlow(action.target);
        break;
      }
      case 'navigate': {
        if (action.page) {
          window.location.hash = `/${action.page}`;
          addBotMessage(`Taking you to the ${action.page} page...`);
        }
        break;
      }
      case 'open_add_to_route': {
        // Close the guide panel first
        setIsOpen(false);
        // Fire the event immediately — Dashboard listener opens the form in-place,
        // Deliveries page listener also handles it if we're already there.
        // We do NOT navigate away on mobile (stay on Dashboard).
        const currentPath = window.location.hash.replace('#', '') || '/';
        const isOnDashboard = currentPath === '/' || currentPath.startsWith('/Dashboard');
        if (!isOnDashboard) {
          // Only navigate if we're on a different page
          navigate('/Deliveries');
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('rxdeliver_open_add_to_route'));
          }, 600);
        } else {
          // Already on Dashboard — fire event immediately, form opens in-place
          window.dispatchEvent(new CustomEvent('rxdeliver_open_add_to_route'));
        }
        break;
      }
      case 'dismiss': {
        setShowQuickActions(true);
        break;
      }
      case 'select_patient': {
        // Disambiguation selection — look up the specific patient
        if (action.patientId) {
          const selected = appPatients?.find(p => p?.id === action.patientId);
          if (selected) {
            addUserMessage(action.label || selected.full_name);
            setShowQuickActions(false);
            setTimeout(() => handlePatientQuery({ type: 'named', patientName: selected.full_name, patientId: selected.id }), 300);
          } else {
            addBotMessage("I couldn't find that patient. They may have been removed.");
          }
        }
        break;
      }
      default:
        break;
    }
  }, [activeFlow, currentStepId, goToStep, startFlow, addBotMessage, addUserMessage, navigate, appPatients, handlePatientQuery]);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;

    addUserMessage(text);
    setInputValue('');
    setShowQuickActions(false);

    // ── Check for patient query FIRST (before generic intent matching) ──
    const patientQuery = detectPatientQuery(text);
    if (patientQuery) {
      // Check for "no answer" / "can't reach" triggers that add troubleshooting
      const lower = text.toLowerCase();
      const wantsNoAnswer = /no answer|no response|can.?t reach|can.?t contact|not home|not answering|no one home|nobody home|trouble reaching/.test(lower);

      // If it's a current-delivery query with no-answer keywords, force advice
      if (patientQuery.type === 'current' && wantsNoAnswer) {
        setTimeout(() => {
          // Temporarily set a flag — handlePatientQuery will include advice
          // We call it with a modified query result
          const userRole = currentUser ? (isAppOwner(currentUser) ? 'admin' : getPrimaryRole(currentUser) || 'driver') : 'driver';
          if (userRole !== 'driver' && userRole !== 'admin') {
            addBotMessage("No-answer troubleshooting is most useful for drivers on active deliveries. As a dispatcher, you can look up a patient by name instead!", []);
            setShowQuickActions(true);
            return;
          }
          const result = findCurrentDeliveryPatient(currentUser, appDeliveries, appPatients, todayStr);
          if (!result) {
            addBotMessage("You don't have an active delivery right now to troubleshoot.", []);
            setShowQuickActions(true);
            return;
          }
          const store = appStores?.find(s => s?.id === result.delivery.store_id);
          const cityAdmins = (appDrivers || []).filter(u =>
            u && u.app_roles?.includes('admin') &&
            (u.city_id === currentUser.city_id || (u.city_ids && u.city_ids.includes(currentUser.city_id)))
          );
          const stats = getPatientDeliveryStats(result.patient.id, appDeliveries);
          const response = buildPatientResponse({
            patient: result.patient,
            delivery: result.delivery,
            stats,
            store,
            cityAdmins,
            includeAdvice: true,
          });
          addBotMessage(response, []);
          setShowQuickActions(true);
        }, 300);
        return;
      }

      // Standard patient query
      setTimeout(() => handlePatientQuery(patientQuery), 300);
      return;
    }

    // Try to match a generic intent
    const match = matchIntent(text);
    if (match) {
      if (match.action?.type === 'flow') {
        setTimeout(() => startFlow(match.action.target), 300);
      } else {
        setTimeout(() => {
          addBotMessage(match.response);
          setShowQuickActions(true);
        }, 300);
      }
    } else {
      // ── Last resort: try patient name match (scoped to allowed patients) ──
      // handlePatientQuery does the actual scoping, so we just pass the raw name
      // and let it filter. But we can pre-check to avoid showing a fallback when
      // the name actually matches a scoped patient.
      const allowedPatients = getAllowedPatients();
      const patientMatches = findAllPatientsByName(text, allowedPatients);
      if (patientMatches.length > 0) {
        setTimeout(() => handlePatientQuery({ type: 'named', patientName: text }), 300);
        return;
      }
      // Fallback response
      setTimeout(() => {
        addBotMessage(
          "I'm not sure about that specific question, but I can help you with:\n\n• Creating deliveries or patients\n• Starting your route\n• Collecting COD payments\n• Uploading documents\n• Learning the app\n• **Patient info** — type 'info' for your current delivery patient, or just type a patient's name\n\nTry one of the quick actions below, or ask me about one of these topics!",
          []
        );
        setShowQuickActions(true);
      }, 300);
    }
  }, [inputValue, addUserMessage, addBotMessage, startFlow, handlePatientQuery, currentUser, appDeliveries, appPatients, appStores, appDrivers, getAllowedPatients]);

  // ── Handle quick action click ───────────────────────────────────
  const handleQuickAction = useCallback((actionId) => {
    // Patient info quick action — triggers current delivery patient lookup
    if (actionId === 'patient_info') {
      addUserMessage('Patient Info');
      setShowQuickActions(false);
      setTimeout(() => handlePatientQuery({ type: 'current' }), 300);
      return;
    }
    const action = QUICK_ACTIONS.find(a => a.id === actionId);
    if (!action) return;
    addUserMessage(action.label);
    startFlow(actionId);
  }, [addUserMessage, startFlow, handlePatientQuery]);

  // ── Show contextual tip ──────────────────────────────────────────
  const handleShowTip = useCallback(() => {
    if (pageTips.length === 0) {
      addBotMessage("No specific tips for this page, but you can ask me about deliveries, patients, COD, or navigating the app!");
      return;
    }
    const tip = pageTips[pageTipIndex % pageTips.length];
    setPageTipIndex(prev => prev + 1);
    addBotMessage(`💡 Tip for ${pageContext?.label || 'this page'}:\n\n${tip}`);
    setShowTips(true);
  }, [pageTips, pageTipIndex, pageContext, addBotMessage]);

  // ── Open/close handler ───────────────────────────────────────────
  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setShowPulse(false);
    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch { /* ignore */ }
    setHasSeenIntro(true);

    // If no messages yet, show appropriate greeting
    if (messages.length === 0) {
      if (!hasShownDailyGreeting) {
        // First open of the day — show daily greeting
        const greetingMessages = generateDailyGreeting();
        for (const msg of greetingMessages) {
          addBotMessage(msg.text, msg.actions);
        }
        markDailyGreetingShown();
        // Show quick actions after the greeting (unless actions are present)
        if (!greetingMessages.some((m) => m.actions && m.actions.length > 0)) {
          setShowQuickActions(true);
        }
      } else {
        // Returning later same day — simple welcome
        addBotMessage(
          `Welcome back! 👋 How can I help you today?`,
          []
        );
        setShowQuickActions(true);
      }
    }

    setTimeout(() => inputRef.current?.focus(), 300);
  }, [messages.length, userRole, hasShownDailyGreeting, generateDailyGreeting, markDailyGreetingShown, addBotMessage]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleClear = useCallback(() => {
    setMessages([]);
    setActiveFlow(null);
    setCurrentStepId(null);
    setShowQuickActions(true);
    setShowTips(false);
    try { localStorage.removeItem(CONVERSATION_KEY); } catch { /* ignore */ }
    addBotMessage("Conversation cleared. How can I help you?", []);
  }, [addBotMessage]);

  // ── Keyboard handler ─────────────────────────────────────────────
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Don't render if no user
  if (!currentUser) return null;

  return (
    <>
      {/* Floating Sparkles Button */}
      <AnimatePresence>
        {!isOpen && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            className="fixed z-[10060]"
            style={{
              bottom: `${guideBottomPx}px`,
              right: `${guideRightPx}px`,
              opacity: hideFabForExpandedCard ? 0 : 1,
              pointerEvents: hideFabForExpandedCard ? 'none' : 'auto',
              transition: 'opacity 0.15s ease',
            }}
          >
            <button
              onClick={handleOpen}
              className="relative flex items-center justify-center w-12 h-12 md:w-14 md:h-14 rounded-full shadow-lg hover:shadow-xl transition-shadow"
              style={{ backgroundColor: 'var(--primary-color)', color: '#fff' }}
              aria-label="Open guide assistant"
            >
              <Sparkles className="w-5 h-5 md:w-6 md:h-6" />
              {showPulse && (
                <span className="absolute inset-0 rounded-full animate-ping opacity-30" style={{ backgroundColor: 'var(--primary-color)' }} />
              )}
              {!hasSeenIntro && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full" style={{ boxShadow: '0 0 0 2px var(--bg-white)' }} />
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            className="fixed bottom-0 md:bottom-6 right-0 md:right-4 z-[10060] w-full md:w-[500px] h-[70vh] md:h-[650px] md:max-h-[80vh]"
          >
            <div
              className="flex flex-col h-full rounded-t-xl md:rounded-xl shadow-2xl overflow-hidden"
              style={{
                backgroundColor: 'var(--bg-white)',
                color: 'var(--text-slate-900)',
                border: '1px solid var(--border-slate-200)',
              }}
            >
              {/* Header */}
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{
                  borderBottom: '1px solid var(--border-slate-200)',
                  backgroundColor: 'var(--bg-slate-50)',
                }}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ backgroundColor: 'var(--primary-color)', opacity: 0.9 }}
                  >
                    <Sparkles className="w-4 h-4" style={{ color: '#fff' }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold leading-none" style={{ color: 'var(--text-slate-900)' }}>RxDeliver Guide</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>Your app assistant</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {messages.length > 0 && (
                    <button
                      onClick={handleClear}
                      className="p-1.5 rounded-md transition-colors"
                      style={{ color: 'var(--text-slate-500)' }}
                      title="Clear conversation"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={handleClose}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: 'var(--text-slate-500)' }}
                    title="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Page context badge */}
              {pageContext && (
                <div
                  className="px-4 py-1.5 flex items-center gap-2"
                  style={{
                    borderBottom: '1px solid var(--border-slate-200)',
                    backgroundColor: 'var(--bg-slate-100)',
                  }}
                >
                  <Navigation className="w-3 h-3" style={{ color: 'var(--text-slate-500)' }} />
                  <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>On {pageContext.label}</span>
                  <button
                    onClick={handleShowTip}
                    className="ml-auto flex items-center gap-1 text-xs hover:underline"
                    style={{ color: 'var(--primary-color)' }}
                  >
                    <Lightbulb className="w-3 h-3" />
                    Tip
                  </button>
                </div>
              )}

              {/* Messages */}
              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
                style={{ backgroundColor: 'var(--bg-slate-50)' }}
              >
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} onAction={handleAction} />
                ))}
              </div>

              {/* Quick Actions */}
              {showQuickActions && (
                <div
                  className="px-3 py-2"
                  style={{
                    borderTop: '1px solid var(--border-slate-200)',
                    backgroundColor: 'var(--bg-white)',
                  }}
                >
                  <div className="flex flex-wrap gap-1.5">
                    {visibleQuickActions.map((action) => (
                      <button
                        key={action.id}
                        onClick={() => handleQuickAction(action.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors"
                        style={{
                          backgroundColor: 'var(--bg-slate-100)',
                          color: 'var(--text-slate-700)',
                          border: '1px solid var(--border-slate-200)',
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.backgroundColor = 'var(--bg-slate-200)';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.backgroundColor = 'var(--bg-slate-100)';
                        }}
                      >
                        <span className="text-xs">{action.icon}</span>
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Input */}
              <div
                className="px-3 py-3"
                style={{
                  borderTop: '1px solid var(--border-slate-200)',
                  backgroundColor: 'var(--bg-white)',
                }}
              >
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask me anything..."
                    className="flex-1 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2"
                    style={{
                      backgroundColor: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)',
                      border: '1px solid var(--border-slate-200)',
                      '--tw-ring-color': 'var(--primary-color)',
                    }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                    className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--primary-color)', color: '#fff' }}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ── Message Bubble Component ─────────────────────────────────────────

function MessageBubble({ message, onAction }) {
  const isBot = message.role === 'bot';

  // Render **bold** markdown inline
  const renderText = (text) => {
    if (!text) return null;
    return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className={`flex ${isBot ? 'justify-start' : 'justify-end'}`}>
      <div className="max-w-[85%]">
        <div
          className="px-3.5 py-2.5 text-sm whitespace-pre-wrap leading-relaxed"
          style={
            isBot
              ? {
                  borderRadius: '18px 18px 18px 4px',
                  backgroundColor: 'var(--bg-white)',
                  color: 'var(--text-slate-900)',
                  border: '1px solid var(--border-slate-200)',
                }
              : {
                  borderRadius: '18px 18px 4px 18px',
                  backgroundColor: 'var(--primary-color)',
                  color: '#fff',
                }
          }
        >
          {renderText(message.text)}
        </div>

        {/* Action buttons */}
        {isBot && message.actions && message.actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.actions.map((action, idx) => (
              <button
                key={idx}
                onClick={() => onAction(action)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  backgroundColor: action.badgeColor ? 'var(--bg-white)' : 'var(--primary-color)',
                  color: action.badgeColor ? 'var(--text-slate-900)' : '#fff',
                  border: action.badgeColor ? `1px solid ${action.badgeColor}` : 'none',
                  opacity: action.type === 'dismiss' ? 0.75 : 1,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '0.85'; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = action.type === 'dismiss' ? '0.75' : '1'; }}
              >
                {action.label}
                {action.badgeText && (
                  <span
                    className="ml-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-white"
                    style={{ backgroundColor: action.badgeColor || '#666' }}
                  >
                    {action.badgeText}
                  </span>
                )}
                {action.type === 'next' && <ChevronRight className="w-3 h-3" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}