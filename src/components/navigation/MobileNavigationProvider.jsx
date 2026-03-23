import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MOBILE_TAB_CONFIG, getTabKeyForPath } from './mobileNavigationConfig';

const STORAGE_KEY = 'rxdeliver_mobile_navigation_state';
const MAX_STACK_DEPTH = 20;
const MobileNavigationContext = React.createContext(null);

const normalizeRoutePath = (path = '') => {
  const [pathname, search = ''] = path.split('?');
  return `${pathname.toLowerCase()}${search ? `?${search}` : ''}`;
};

const getRootPath = (tabKey) => normalizeRoutePath(MOBILE_TAB_CONFIG[tabKey]?.rootPath || '/dashboard');

const buildDefaultState = () => ({
  activeTab: 'dashboard',
  lastAction: 'push',
  tabStacks: Object.fromEntries(
    Object.keys(MOBILE_TAB_CONFIG).map((key) => [key, [getRootPath(key)]])
  ),
  scrollPositions: {},
});

const sanitizeState = (rawState = {}) => {
  const defaultState = buildDefaultState();
  const tabStacks = Object.fromEntries(
    Object.keys(MOBILE_TAB_CONFIG).map((key) => {
      const rawStack = Array.isArray(rawState?.tabStacks?.[key])
        ? rawState.tabStacks[key].map(normalizeRoutePath).filter(Boolean)
        : [];

      const dedupedStack = rawStack.reduce((stack, path) => {
        if (stack[stack.length - 1] === path) return stack;
        return [...stack, path];
      }, []);

      return [key, (dedupedStack.length ? dedupedStack : [getRootPath(key)]).slice(-MAX_STACK_DEPTH)];
    })
  );

  const scrollPositions = Object.fromEntries(
    Object.entries(rawState?.scrollPositions || {}).map(([path, scrollTop]) => [
      normalizeRoutePath(path),
      Number.isFinite(scrollTop) ? scrollTop : 0,
    ])
  );

  return {
    ...defaultState,
    ...rawState,
    activeTab: rawState?.activeTab && MOBILE_TAB_CONFIG[rawState.activeTab] ? rawState.activeTab : defaultState.activeTab,
    lastAction: rawState?.lastAction === 'pop' ? 'pop' : 'push',
    tabStacks,
    scrollPositions,
  };
};

const readStoredState = () => {
  if (typeof window === 'undefined') return buildDefaultState();

  try {
    const savedState = sessionStorage.getItem(STORAGE_KEY);
    if (!savedState) return buildDefaultState();
    return sanitizeState(JSON.parse(savedState));
  } catch {
    return buildDefaultState();
  }
};

export function MobileNavigationProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = normalizeRoutePath(`${location.pathname}${location.search}`);
  const pendingActionRef = React.useRef('push');
  const [state, setState] = React.useState(readStoredState);
  const scrollPositionsRef = React.useRef(state.scrollPositions);

  React.useEffect(() => {
    scrollPositionsRef.current = state.scrollPositions;
  }, [state.scrollPositions]);

  const persistState = React.useCallback((updater) => {
    setState((previousState) => {
      const candidateState = typeof updater === 'function' ? updater(previousState) : updater;
      const nextState = sanitizeState(candidateState);
      const previousSerialized = JSON.stringify(previousState);
      const nextSerialized = JSON.stringify(nextState);

      if (previousSerialized === nextSerialized) {
        return previousState;
      }

      sessionStorage.setItem(STORAGE_KEY, nextSerialized);
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
    const nextAction = pendingActionRef.current || 'push';

    persistState((previousState) => {
      const tabKey = getTabKeyForPath(location.pathname) || previousState.activeTab || 'dashboard';
      const rootPath = getRootPath(tabKey);
      const previousStack = previousState.tabStacks?.[tabKey] || [rootPath];
      let nextStack = previousStack;

      if (nextAction === 'pop') {
        const existingIndex = previousStack.lastIndexOf(currentPath);
        nextStack = existingIndex >= 0
          ? previousStack.slice(0, existingIndex + 1)
          : previousStack;
      } else if (previousStack[previousStack.length - 1] !== currentPath) {
        nextStack = [...previousStack, currentPath].slice(-MAX_STACK_DEPTH);
      }

      if (nextStack[nextStack.length - 1] !== currentPath) {
        nextStack = [...nextStack, currentPath].slice(-MAX_STACK_DEPTH);
      }

      const finalStack = nextStack.length ? nextStack : [rootPath];
      const currentStoredStack = previousState.tabStacks?.[tabKey] || [rootPath];
      const stackUnchanged = JSON.stringify(currentStoredStack) === JSON.stringify(finalStack);

      if (
        previousState.activeTab === tabKey &&
        previousState.lastAction === nextAction &&
        stackUnchanged
      ) {
        return previousState;
      }

      return {
        ...previousState,
        activeTab: tabKey,
        lastAction: nextAction,
        tabStacks: {
          ...previousState.tabStacks,
          [tabKey]: finalStack,
        },
      };
    });

    pendingActionRef.current = 'push';
  }, [currentPath, location.pathname, persistState]);

  const saveScrollPosition = React.useCallback((path, scrollTop) => {
    if (!path) return;

    const normalizedPath = normalizeRoutePath(path);
    const nextScrollTop = Number.isFinite(scrollTop) ? scrollTop : 0;

    persistState((previousState) => {
      const currentScrollTop = previousState.scrollPositions?.[normalizedPath] ?? 0;
      if (currentScrollTop === nextScrollTop) {
        return previousState;
      }

      return {
        ...previousState,
        scrollPositions: {
          ...previousState.scrollPositions,
          [normalizedPath]: nextScrollTop,
        },
      };
    });
  }, [persistState]);

  const getScrollPosition = React.useCallback((path) => {
    return scrollPositionsRef.current?.[normalizeRoutePath(path)] ?? 0;
  }, []);

  const navigateToTab = React.useCallback((tabKey, fallbackPath) => {
    const savedStack = state.tabStacks?.[tabKey] || [getRootPath(tabKey)];
    const targetPath = savedStack[savedStack.length - 1] || normalizeRoutePath(fallbackPath) || getRootPath(tabKey);

    pendingActionRef.current = 'push';
    persistState((previousState) => ({
      ...previousState,
      activeTab: tabKey,
      lastAction: 'push',
    }));

    navigate(targetPath);
  }, [navigate, persistState, state.tabStacks]);

  const goBack = React.useCallback(() => {
    const tabKey = getTabKeyForPath(location.pathname) || state.activeTab || 'dashboard';
    const rootPath = getRootPath(tabKey);
    const currentStack = state.tabStacks?.[tabKey] || [rootPath];

    if (currentStack.length > 1) {
      const previousPath = currentStack[currentStack.length - 2];
      pendingActionRef.current = 'pop';
      persistState((previousState) => ({
        ...previousState,
        activeTab: tabKey,
        lastAction: 'pop',
        tabStacks: {
          ...previousState.tabStacks,
          [tabKey]: currentStack.slice(0, -1),
        },
      }));
      navigate(previousPath);
      return;
    }

    if (currentPath !== rootPath) {
      pendingActionRef.current = 'pop';
      persistState((previousState) => ({
        ...previousState,
        activeTab: tabKey,
        lastAction: 'pop',
        tabStacks: {
          ...previousState.tabStacks,
          [tabKey]: [rootPath],
        },
      }));
      navigate(rootPath);
      return;
    }

    if (window.history.length > 1) {
      window.history.back();
    }
  }, [currentPath, location.pathname, navigate, persistState, state.activeTab, state.tabStacks]);

  const setNextNavigationAction = React.useCallback((action = 'push') => {
    pendingActionRef.current = action;
    persistState((previousState) => ({ ...previousState, lastAction: action === 'pop' ? 'pop' : 'push' }));
  }, [persistState]);

  const activeTab = getTabKeyForPath(location.pathname) || state.activeTab || 'dashboard';
  const activeTabRootPath = getRootPath(activeTab);
  const activeTabStack = state.tabStacks?.[activeTab] || [activeTabRootPath];
  const canGoBack = activeTabStack.length > 1 || currentPath !== activeTabRootPath;

  const value = React.useMemo(() => ({
    ...state,
    activeTab,
    activeTabStack,
    currentPath,
    canGoBack,
    navigateToTab,
    goBack,
    saveScrollPosition,
    getScrollPosition,
    setNextNavigationAction,
  }), [state, activeTab, activeTabStack, currentPath, canGoBack, navigateToTab, goBack, saveScrollPosition, getScrollPosition, setNextNavigationAction]);

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