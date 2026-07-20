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
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, Send, ChevronRight, RotateCcw, Lightbulb, Navigation } from 'lucide-react';
import { useAppData } from '@/components/utils/AppDataContext';
import { isAppOwner, userHasRole, getPrimaryRole } from '@/components/utils/userRoles';
import { QUICK_ACTIONS, FLOWS, PAGE_TIPS, PAGE_CONTEXT, matchIntent } from './guideFlows';

const STORAGE_KEY = 'rxdeliver_guide_seen';
const CONVERSATION_KEY = 'rxdeliver_guide_conversation';

// FAB is h-10 (40px) + 10px gap above stop cards + 8px gap above FAB
const FAB_HEIGHT = 40;
const FAB_GAP = 10;
const GUIDE_GAP = 8;

export default function GuideAssistant() {
  const location = useLocation();
  const { currentUser } = useAppData();
  const [isOpen, setIsOpen] = useState(false);
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

  // ── Dynamic bottom offset for the floating button ───────────────
  // On the Dashboard, we need to sit above the FABs which sit above stop cards.
  // --stop-cards-height is set by Dashboard.jsx. --bottom-nav-height is the
  // mobile bottom nav. On non-Dashboard pages, stop-cards-height is 0 so we
  // just sit above the bottom nav (or at a default position on desktop).
  const [guideBottomPx, setGuideBottomPx] = useState(80);

  useEffect(() => {
    const compute = () => {
      const isMobileScreen = window.innerWidth < 850;

      if (!isMobileScreen) {
        // Desktop: sit at a fixed comfortable position
        setGuideBottomPx(24);
        return;
      }

      // Mobile: sit above the FABs which are above the stop cards.
      // --stop-cards-height is set by Dashboard.jsx.
      // --bottom-nav-height is always 0px in CSS, so measure the actual nav element.
      const stopCardsHeight = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--stop-cards-height') || '0',
        10
      ) || 0;

      let bottomNavHeight = 0;
      const navEl = document.querySelector('[data-mobile-bottom-nav]');
      if (navEl) {
        bottomNavHeight = navEl.offsetHeight || 0;
      }

      // FAB bottom (from viewport) = stopCardsHeight + bottomNavHeight + FAB_GAP
      // Guide bottom = FAB bottom + FAB_HEIGHT + GUIDE_GAP
      const fabBottom = stopCardsHeight + bottomNavHeight + FAB_GAP;
      const guideBottom = fabBottom + FAB_HEIGHT + GUIDE_GAP;
      setGuideBottomPx(guideBottom);
    };

    compute();

    // Re-compute when CSS variables change (stop cards height updates)
    const observer = new MutationObserver(() => compute());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });

    // Re-compute on resize (mobile <-> desktop transition)
    window.addEventListener('resize', compute);
    window.addEventListener('orientationchange', compute);

    // Re-compute on SPA navigation (bottom nav may mount/unmount)
    window.addEventListener('popstate', compute);

    // Also poll briefly for the CSS variable to settle (Dashboard sets it async)
    const interval = setInterval(compute, 500);
    const timeout = setTimeout(() => clearInterval(interval), 3000);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', compute);
      window.removeEventListener('orientationchange', compute);
      window.removeEventListener('popstate', compute);
      clearInterval(interval);
      clearTimeout(timeout);
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

  const pageContext = PAGE_CONTEXT[currentPageName] || null;
  const pageTips = pageContext ? PAGE_TIPS[pageContext.tips] || [] : [];

  // ── Role-filtered quick actions ──────────────────────────────────
  const visibleQuickActions = useMemo(() => {
    if (userRole === 'driver') {
      return QUICK_ACTIONS.filter(a =>
        ['start_route', 'collect_cod', 'upload_docs', 'getting_started'].includes(a.id)
      );
    }
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
      default:
        break;
    }
  }, [activeFlow, currentStepId, goToStep, startFlow, addBotMessage, addUserMessage]);

  // ── Handle user input ────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;

    addUserMessage(text);
    setInputValue('');
    setShowQuickActions(false);

    // Try to match an intent
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
      // Fallback response
      setTimeout(() => {
        addBotMessage(
          "I'm not sure about that specific question, but I can help you with:\n\n• Creating deliveries or patients\n• Starting your route\n• Collecting COD payments\n• Uploading documents\n• Learning the app\n\nTry one of the quick actions below, or ask me about one of these topics!",
          []
        );
        setShowQuickActions(true);
      }, 300);
    }
  }, [inputValue, addUserMessage, addBotMessage, startFlow]);

  // ── Handle quick action click ───────────────────────────────────
  const handleQuickAction = useCallback((actionId) => {
    const action = QUICK_ACTIONS.find(a => a.id === actionId);
    if (!action) return;
    addUserMessage(action.label);
    startFlow(actionId);
  }, [addUserMessage, startFlow]);

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

    // If no messages and first time, show welcome
    if (messages.length === 0) {
      const roleLabel = userRole === 'admin' ? 'admin' : userRole === 'dispatcher' ? 'dispatcher' : 'driver';
      addBotMessage(
        `Hi! 👋 I'm your RxDeliver guide assistant. I can help you create deliveries, add patients, start routes, collect COD, and learn how to use the app.\n\nI see you're a ${roleLabel} — here are some things I can help with:`,
        []
      );
      setShowQuickActions(true);
    }

    setTimeout(() => inputRef.current?.focus(), 300);
  }, [messages.length, userRole, addBotMessage]);

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
      {/* Floating Button — positioned above FABs on mobile */}
      <AnimatePresence>
        {!isOpen && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            className="fixed right-4 z-[9999]"
            style={{ bottom: `${guideBottomPx}px` }}
          >
            <button
              onClick={handleOpen}
              className="relative flex items-center justify-center w-12 h-12 md:w-14 md:h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl transition-shadow"
              aria-label="Open guide assistant"
            >
              <Sparkles className="w-5 h-5 md:w-6 md:h-6" />
              {showPulse && (
                <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-30" />
              )}
              {!hasSeenIntro && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full ring-2 ring-background" />
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
            className="fixed bottom-0 md:bottom-6 right-0 md:right-4 z-[9999] w-full md:w-[400px] h-[70vh] md:h-[600px] md:max-h-[80vh]"
          >
            <div className="flex flex-col h-full rounded-t-xl md:rounded-xl bg-card text-card-foreground border border-border shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b bg-primary/5">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold leading-none">RxDeliver Guide</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Your app assistant</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {messages.length > 0 && (
                    <button
                      onClick={handleClear}
                      className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                      title="Clear conversation"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={handleClose}
                    className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                    title="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Page context badge */}
              {pageContext && (
                <div className="px-4 py-1.5 border-b bg-muted/30 flex items-center gap-2">
                  <Navigation className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">On {pageContext.label}</span>
                  <button
                    onClick={handleShowTip}
                    className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Lightbulb className="w-3 h-3" />
                    Tip
                  </button>
                </div>
              )}

              {/* Messages */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} onAction={handleAction} />
                ))}
              </div>

              {/* Quick Actions */}
              {showQuickActions && (
                <div className="px-3 py-2 border-t bg-muted/20">
                  <div className="flex flex-wrap gap-1.5">
                    {visibleQuickActions.map((action) => (
                      <button
                        key={action.id}
                        onClick={() => handleQuickAction(action.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-accent text-accent-foreground text-xs font-medium hover:bg-primary/10 transition-colors border border-border"
                      >
                        <span className="text-xs">{action.icon}</span>
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Input */}
              <div className="px-3 py-3 border-t bg-background">
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask me anything..."
                    className="flex-1 px-3 py-2 rounded-lg bg-muted text-sm text-foreground placeholder:text-muted-foreground/60 border border-border focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                    className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors flex-shrink-0"
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

// ── Message Bubble Component ──────────────────────────────────────────

function MessageBubble({ message, onAction }) {
  const isBot = message.role === 'bot';

  return (
    <div className={`flex ${isBot ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[85%] ${isBot ? '' : ''}`}>
        <div
          className={
            isBot
              ? 'px-3.5 py-2.5 rounded-2xl rounded-br-md bg-muted text-foreground text-sm whitespace-pre-wrap'
              : 'px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-primary text-primary-foreground text-sm whitespace-pre-wrap'
          }
        >
          {message.text}
        </div>

        {/* Action buttons */}
        {isBot && message.actions && message.actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.actions.map((action, idx) => (
              <button
                key={idx}
                onClick={() => onAction(action)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:bg-primary/10 transition-colors border border-border"
              >
                {action.label}
                {action.type === 'next' && <ChevronRight className="w-3 h-3" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
