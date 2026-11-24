import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useLocation } from 'react-router-dom';
import { useUser } from '@/components/utils/UserContext';
import MessagingPanel from '@/components/messaging/MessagingPanel';

// OWNER SPEC (Nov 23 2026): "the messaging panel should actually be a page and
// open and close like all the other pages like dashboard and payroll" — it used
// to be a floating overlay mounted from Layout, so the bottom nav kept Dashboard
// highlighted green while messages were on screen. It now has a real route
// (/Messages), a nav tab key (messages) and browser back/forward.
//
// The panel keeps its own measured band styling (it already fills the space
// between the mobile header and the bottom nav, or the content area on tablet
// and PC), so pageMode only changes behaviour: no route-change auto-close, no
// overlay close button, and closing navigates back to the dashboard.
export default function Messages() {
  const { currentUser } = useUser();
  // Deep links (chat push, app-issue watchdog, driver auto-open) hand the
  // conversation over through router state instead of a floating overlay.
  const location = useLocation();
  const initialConversation = location.state?.initialConversation || null;
  const [users, setUsers] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await base44.entities.User.list();
        if (!cancelled) setUsers(Array.isArray(list) ? list : []);
      } catch (_) {
        if (!cancelled) setUsers([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!currentUser) return null;

  return (
    <MessagingPanel
      pageMode
      currentUser={currentUser}
      users={users}
      initialConversation={initialConversation}
      onClose={() => {}}
    />
  );
}
