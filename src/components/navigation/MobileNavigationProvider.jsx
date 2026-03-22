import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MOBILE_TAB_CONFIG, getTabKeyForPath } from './mobileNavigationConfig';

const STORAGE_KEY = 'rxdeliver_mobile_navigation_state';
const MAX_STACK_DEPTH = 20;
const MobileNavigationContext = React.createContext(null);

const buildDefaultState = () => ({
  activeTab: 'dashboard',
  lastAction: 'push',
  tabStacks: Object.fromEntries(
    Object.entries(MOBILE_TAB_CONFIG).map(([key, config]) => [key, [config.rootPath]])
  ),
  scrollPositions: {},
});

const readStoredState = () => {
  if (typeof window === 'undefined') return buildDefaultState();

  try {
    const savedState = sessionStorage.getItem(STORAGE_KEY);
    if (!savedState) return buildDefaultState();

    const parsedState = JSON.parse(savedState);
    const defaultState = buildDefaultState();

    return {
      ...defaultState,
      ...parsedState,
      tabStacks: {
        ...defaultState.tabStacks,
        ...(parsedState?.tabStacks || {}),
      },
      scrollPositions: parsedState?.scrollPositions || {},
    };
  } catch {
    return buildDefaultState();
  }
};

export function MobileNavigationProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = `${location.pathname.toLowerCase()}${location.search}`;
  const pendingActionRef = React.useRef('push');
  const [state, setState] = React.useState(readStoredState);

  const persistState = React.useCallback((updater) => {
    setState((previousState) => {
      const nextState = typeof updater === 'function' ? updater(previousState) : updater;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      return nextState;
    });
  }, []);

  React.useEffect(() => {
    const handlePopState = () => {
      pendingActionRef.current = 'pop';
      persistState((previousState) => ({ ...previousState, lastAction: 'pop' }));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [persistState]);

  React.useEffect(() => {
    const tabKey = getTabKeyForPath(location.pathname) || state.activeTab || 'dashboard';
    const nextAction = pendingActionRef.current || 'push';

    persistState((previousState) => {
      const previousStack = previousState.tabStacks?.[tabKey] || [currentPath];
      let nextStack = previousStack;

      if (nextAction === 'pop') {
        const existingIndex = previousStack.lastIndexOf(currentPath);
        nextStack = existingIndex >= 0
          ? previousStack.slice(0, existingIndex + 1)
          : [...previousStack, currentPath].slice(-MAX_STACK_DEPTH);
      } else if (previousStack[previousStack.length - 1] !== currentPath) {
        nextStack = [...previousStack, currentPath].slice(-MAX_STACK_DEPTH);
      }

      return {
        ...previousState,
        activeTab: tabKey,
        lastAction: nextAction,
        tabStacks: {
          ...previousState.tabStacks,
          [tabKey]: nextStack,
        },
      };
    });

    pendingActionRef.current = 'push';
  }, [currentPath, location.pathname, persistState, state.activeTab]);

  const saveScrollPosition = React.useCallback((path, scrollTop) => {
    if (!path) return;

    persistState((previousState) => ({
      ...previousState,
      scrollPositions: {
        ...previousState.scrollPositions,
        [path]: scrollTop,
      },
    }));
  }, [persistState]);

  const getScrollPosition = React.useCallback((path) => {
    return state.scrollPositions?.[path] ?? 0;
  }, [state.scrollPositions]);

  const navigateToTab = React.useCallback((tabKey, fallbackPath) => {
    const savedStack = state.tabStacks?.[tabKey] || [];
    const targetPath = savedStack[savedStack.length - 1] || fallbackPath || MOBILE_TAB_CONFIG[tabKey]?.rootPath || '/dashboard';

    pendingActionRef.current = 'push';
    persistState((previousState) => ({
      ...previousState,
      activeTab: tabKey,
      lastAction: 'push',
    }));

    navigate(targetPath);
  }, [navigate, persistState, state.tabStacks]);

  const setNextNavigationAction = React.useCallback((action = 'push') => {
    pendingActionRef.current = action;
    persistState((previousState) => ({ ...previousState, lastAction: action }));
  }, [persistState]);

  const value = React.useMemo(() => ({
    ...state,
    currentPath,
    navigateToTab,
    saveScrollPosition,
    getScrollPosition,
    setNextNavigationAction,
  }), [state, currentPath, navigateToTab, saveScrollPosition, getScrollPosition, setNextNavigationAction]);

  return (
    <MobileNavigationContext.Provider value={value}>
      {children}
    </MobileNavigationContext.Provider>
  );
}

export function useMobileNavigation() {
  const context = React.useContext(MobileNavigationContext);

  if (!context) {
    throw new Error('useMobileNavigation must be used within MobileNavigationProvider');
  }

  return context;
}