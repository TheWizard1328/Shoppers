src/components/guide/guideFlows.jsx

/**
 * guideFlows.jsx — Conversation flow definitions for the RxDeliver Guide Assistant.
 * Each flow is a state machine: steps → responses → next steps.
 * Flows are role-aware (driver, dispatcher, admin) and page-aware.
 */

export const QUICK_ACTIONS = [
  { id: 'create_delivery', label: 'Create a Delivery', icon: '📦' },
  { id: 'create_patient', label: 'Create a Patient', icon: '👤' },
  { id: 'start_route', label: 'Start My Route', icon: '🚀' },
  { id: 'collect_cod', label: 'Collect COD', icon: '💳' },
  { id: 'upload_docs', label: 'Upload Documents', icon: '📄' },
  { id: 'getting_started', label: 'Getting Started', icon: '✨' },
];

export const PAGE_CONTEXT = {
  Dashboard: { label: 'Dashboard', tips: 'dashboard' },
  Patients: { label: 'Patients', tips: 'patients' },
  Deliveries: { label: 'Deliveries', tips: 'deliveries' },
  DriverPayroll: { label: 'Payroll', tips: 'payroll' },
  Documents: { label: 'Documents', tips: 'documents' },
  SquareManagement: { label: 'COD Management', tips: 'square' },
  AppUsers: { label: 'App Users', tips: 'users' },
  Stores: { label: 'Stores', tips: 'stores' },
  Settings: { label: 'Settings', tips: 'settings' },
};

// ── Guided flows ──────────────────────────────────────────────────────

export const FLOWS = {
  create_delivery: {
    title: 'Create a New Delivery',
    steps: [
      {
        id: 'intro',
        bot: "Let's create a new delivery! I'll walk you through each step. First, make sure you're on the Dashboard — that's where deliveries are created.",
        actions: [
          { label: 'Go to Dashboard', type: 'navigate', page: 'Dashboard' },
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'open_form',
        bot: "On the Dashboard, look for the green 'New Delivery' button — it's usually in the top-right corner of the Dashboard card as a floating green button (+). Tap it to open the delivery form.",
        actions: [
          { label: 'I see the form', type: 'next' },
          { label: 'I can\'t find it', type: 'jump', target: 'cant_find' },
        ],
      },
      {
        id: 'select_patient',
        bot: "Great! The delivery form has a patient search field at the top. You can:\n\n• Search for an existing patient by Name, Address, Phone Number or something within the Patient Notes.\n• If now patients show up in the search list, then the '+ Add New Patient' button will appear.\n\nIf the patient is new, I can guide you through that too.",
        actions: [
          { label: 'Create a new patient', type: 'jump', target: 'create_patient_inline' },
          { label: 'I have an existing patient', type: 'next' },
        ],
      },
      {
        id: 'select_driver',
        bot: "Next, assign a driver if one has not already been preselected.\n• If you're a driver creating this for yourself, it'll auto-select you.\n• If you're a dispatcher and a driver has not already been assigned, tap the driver dropdown and pick your driver.",
        actions: [
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'set_cod',
        bot: "If this delivery requires Cash on Delivery (COD), enter the amount in the COD field. This is the amount the driver needs to collect from the patient.",
        actions: [
          { label: 'No COD needed', type: 'next' },
          { label: 'Got it', type: 'next' },
        ],
      },
      {
        id: 'delivery_options',
        bot: "Add any 'Delivery Options'\n• Special instructions like 'Oversized Items', 'Fridge item — keep cold', or 'Extra Signature Required'.\n• This helps the driver know what to expect.",
        actions: [
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'stage',
        bot: "Review the details and tap '+ Add' to stage the delivery.\n• The delivery will appear on the staged list to the right of the form and be pre-assigned to the selected driver's route.",
        actions: [
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'done',
        bot: "Review all the staged deliveries on the right.\n• Select a staged/pending delivery to make any final edits. Select Update to save the changes.\n• Select 'Done' for commit all staged deliveries to your driver(s).",
        actions: [
          { label: 'Done! 🎉', type: 'end' },
          { label: 'Projections', type: 'jump', target: 'projections' },
          { label: 'Start over', type: 'restart' },
        ],
      },
      {
        id: 'projections',
        bot: "You can also add deliveries to your Driver(s) via the Projections list.\n• These are deliveries for patients that have reocurring delivery patterns set up.\n• These will appear in your deliveries list on the right side panel.\nClicking the green '+' will add them to your staged list and set them as ready to to edit. Once ready to commit to your drivers route click the '+ Add' button.",
        actions: [
          { label: 'Done! 🎉', type: 'end' },
          { label: 'Start over', type: 'restart' },
        ],
      },
      {
        id: 'cant_find',
        bot: "No worries! The 'New Delivery' button looks like a green button with a '+' icon. On desktop, it's in the top toolbar above the map. On mobile, it's a floating action button (FAB) in the bottom-right corner. Try scrolling up if you don't see it.",
        actions: [
          { label: 'Found it!', type: 'jump', target: 'select_patient' },
          { label: 'Still can\'t find it', type: 'jump', target: 'cant_find_2' },
        ],
      },
      {
        id: 'cant_find_2',
        bot: "If you're a driver, make sure your status is set to 'On Duty' — the toggle is in the sidebar. Dispatchers and admins should always see the button. If it's still not visible, try refreshing the page.",
        actions: [
          { label: 'OK', type: 'end' },
        ],
      },
      {
        id: 'create_patient_inline',
        bot: "To create a new patient from the delivery form, type the patient's name in the search field. When no matches appear, you'll see a 'Create New Patient' option. Tap it to open the patient form. You'll need:\n\n• Full name\n• Phone number\n• Delivery address\n• City\n\nFill in the details and save — the patient will be linked to this delivery automatically.",
        actions: [
          { label: 'Back to delivery', type: 'jump', target: 'select_store' },
          { label: 'Tell me more about patients', type: 'jump', target: 'create_patient' },
        ],
      },
    ],
  },

  create_patient: {
    title: 'Create a New Patient',
    steps: [
      {
        id: 'intro',
        bot: "Let's create a new patient! You can do this from the Patients page or directly from a delivery form. I'll walk you through the Patients page method.",
        actions: [
          { label: 'Go to Patients', type: 'navigate', page: 'Patients' },
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'open_form',
        bot: "On the Patients page, look for the 'New Patient' or '+ Add Patient' button. It's usually at the top of the page. Tap it to open the patient form.",
        actions: [
          { label: 'I see the form', type: 'next' },
        ],
      },
      {
        id: 'basic_info',
        bot: "Fill in the patient's basic information:\n\n• Full Name — first and last name\n• Phone Number — for delivery confirmation calls\n• Patient ID — auto-generated, you usually don't need to change this\n• City — select the city where the patient lives",
        actions: [
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'address',
        bot: "Now enter the delivery address. The address field uses Google autocomplete, so start typing the address and select from the suggestions. This ensures accurate GPS coordinates for routing.\n\nIf the address doesn't appear in suggestions, you can type it manually.",
        actions: [
          { label: 'Got it', type: 'next' },
        ],
      },
      {
        id: 'store_assignment',
        bot: "Select the patient's default pharmacy store. This is the store that will typically prepare their prescriptions. When creating deliveries for this patient, the store will be pre-filled.",
        actions: [
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'delivery_preferences',
        bot: "Set any delivery preferences:\n\n• AM/PM delivery preference\n• Recurring delivery days (e.g., every Monday)\n• Special instructions (e.g., 'Knock loudly — doorbell broken')\n• Fridge items flag (if the patient receives cold-chain medications)",
        actions: [
          { label: 'Got it', type: 'next' },
        ],
      },
      {
        id: 'save',
        bot: "Review the details and tap 'Save'. The patient is now in the system and can be assigned to deliveries.\n\nYou can always edit patient details later by searching for them and tapping the edit button.",
        actions: [
          { label: 'Done! 🎉', type: 'end' },
          { label: 'Start over', type: 'restart' },
        ],
      },
    ],
  },

  start_route: {
    title: 'Start My Route',
    steps: [
      {
        id: 'intro',
        bot: "Ready to start your delivery route? Here's how to get going!",
        actions: [{ label: 'Let\'s go', type: 'next' }],
      },
      {
        id: 'check_status',
        bot: "First, make sure your driver status is set to 'On Duty'. You can toggle this in the sidebar — look for the green 'On Duty' / 'Off Duty' switch. When you're On Duty, your location is tracked and you'll appear as active on the dashboard.",
        actions: [{ label: 'I\'m On Duty', type: 'next' }],
      },
      {
        id: 'check_location',
        bot: "Make sure location tracking is enabled — there's a location icon in the sidebar. When it's active, you'll see your position on the map as a blue dot. This is essential for route optimization and arrival detection.",
        actions: [{ label: 'Location is on', type: 'next' }],
      },
      {
        id: 'view_deliveries',
        bot: "On the Dashboard, you'll see your deliveries for today as stop cards below the map. Each card shows:\n\n• Patient name and address\n• Stop number (if route is optimized)\n• COD amount (if applicable)\n• Delivery status\n\nYour stops are ordered by the optimized route. If you need to reorder, use the 'Optimize Route' button.",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'start_first',
        bot: "To start your route, tap the 'Start' button on your first delivery. This will:\n\n• Set your status to 'In Transit'\n• Begin route tracking\n• Show your progress on the map\n• Start the estimated arrival timer\n\nThe map will show a polyline (colored line) from your current position to the destination.",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'arrive',
        bot: "When you arrive at a delivery location, the app will auto-detect your arrival based on GPS proximity. You'll see an 'Arrived' prompt. From there you can:\n\n• Complete the delivery (mark as delivered)\n• Collect COD payment if required\n• Take a proof photo\n• Get a signature\n• Add delivery notes\n\nAfter completing, the next stop card will automatically expand.",
        actions: [
          { label: 'Got it! 🎉', type: 'end' },
          { label: 'What about COD?', type: 'jump', target: 'collect_cod' },
        ],
      },
    ],
  },

  collect_cod: {
    title: 'Collecting COD Payments',
    steps: [
      {
        id: 'intro',
        bot: "Here's how Cash on Delivery (COD) collection works in RxDeliver:",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'identify',
        bot: "When a delivery has COD, you'll see a dollar sign badge and a Square payment button next to the 'Complete' button on the delivery card. The amount is set by the dispatcher when creating the delivery. Common payment methods are:\n\n• Cash\n• Debit\n• Credit\n• Check",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'collect',
        bot: "Before you complete a COD delivery, you'll need to record the payment:\n\n1. Tap the delivery card to expand it.\n2. Select the Collect option next to the 'COD Required' amount to collet.\n3. Select the payment method (Cash, Debit, Credit, etc.)\n4. Enter/confirm the amount collected\n5. Select 'Save and Complete' to record the payment is recorded in the system\n\nFor card payments (Debit/Credit), you can use the Square POS button next to the 'Complete' button to process the payment directly through a connected Square reader.",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'square',
        bot: "To use the Square reader:\n\n1. Make sure your Bluetooth Square reader is connected\n2. Tap 'Square Payment' button on the delivery card next to the 'Complete' button\n3. The Square app will open with the pre-filled amount\n4. Complete the transaction on the reader\n5. Return to RxDeliver — to finalize the delivery with the required payment method.\n\nThe transaction will show up in the COD Management page for reconciliation.",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'verify',
        bot: "Admins and Drivers can verify COD collections in the COD Management page:\n\n• Green 'Collected' badge = payment verified via Square\n• Orange 'Not Collected' = delivery completed but no payment recorded\n• The Reconciliation tab shows unmatched deliveries and transactions\n\nDaily COD totals are shown in the dashboard stats cards.",
        actions: [
          { label: 'Got it! 🎉', type: 'end' },
          { label: 'Start over', type: 'restart' },
        ],
      },
    ],
  },

  upload_docs: {
    title: 'Upload Documents',
    steps: [
      {
        id: 'intro',
        bot: "RxDeliver uses a secure document management system for driver files. Here's how it works:",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'driver_uploads',
        bot: "Drivers can upload two types of documents:\n\n📄 Driver's License — a photo or scan of your license\n📄 Background Check — your background check certificate\n\nTo upload:\n1. Go to the Documents page\n2. Tap 'Upload' next to the document type\n3. Take a photo or select a file from your device\n4. The document is securely stored and encrypted",
        actions: [
          { label: 'Go to Documents', type: 'navigate', page: 'Documents' },
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'access_request',
        bot: "Dispatchers who need to view a driver's license or background check must request access:\n\n1. Dispatcher goes to Documents page\n2. Selects a driver and checks the document types to request\n3. Submits the access request\n4. The driver and all admins receive a push notification\n5. The driver or an admin approves/denies the request\n\nOnce approved, the dispatcher can view the document for a limited time (until midnight the next day, or 30 minutes after first viewing).",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'contracts',
        bot: "Driver Contracts are store-specific documents uploaded by dispatchers/admins. These don't require an access request — any dispatcher for that store can view them at any time.\n\nContracts are tracked with an expiry date for annual renewal monitoring.",
        actions: [
          { label: 'Got it! 🎉', type: 'end' },
          { label: 'Start over', type: 'restart' },
        ],
      },
    ],
  },

  getting_started: {
    title: 'Getting Started with RxDeliver',
    steps: [
      {
        id: 'intro',
        bot: "Welcome to RxDeliver! I'm your guide assistant. I can help you learn how to use the app. Let me show you around! 🚀",
        actions: [{ label: 'Let\'s start!', type: 'next' }],
      },
      {
        id: 'roles',
        bot: "RxDeliver has three main user roles:\n\n🚗 **Drivers** — deliver prescriptions, collect COD payments, track routes\n📋 **Dispatchers** — create deliveries, manage routes, assign drivers\n⚙️ **Admins** — full access including user management, payroll, and settings\n\nYour role determines what you can see and do in the app. Let me show you the key pages for your role.",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'dashboard',
        bot: "📊 **Dashboard** — This is your home base. It shows:\n\n• A live map with all delivery stops\n• Stop cards for each delivery (below the map)\n• Stats cards (deliveries completed, COD, time on duty)\n• Route optimization controls\n\nDrivers see their own deliveries. Dispatchers can view all drivers or filter by specific ones. Admins see everything.",
        actions: [
          { label: 'Show me the Dashboard', type: 'navigate', page: 'Dashboard' },
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'patients_page',
        bot: "👥 **Patients** — Manage your patient database. Here you can:\n\n• Search and view all patients\n• Create new patients\n• Edit patient details and delivery preferences\n• View delivery history for each patient\n• Set recurring delivery schedules",
        actions: [
          { label: 'Show me Patients', type: 'navigate', page: 'Patients' },
          { label: 'Continue', type: 'next' },
        ],
      },
      {
        id: 'cod_page',
        bot: "💳 **COD Management** — Track Cash on Delivery payments. This page shows:\n\n• Catalog items created in Square POS\n• Transaction history from Square\n• Delivery-to-transaction matching\n• Reconciliation of unmatched payments\n• Per-store and per-driver COD summaries",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'documents_page',
        bot: "📄 **Documents** — Secure document management for driver files:\n\n• Drivers upload licenses and background checks\n• Dispatchers request access to view driver documents\n• Admins manage all document access\n• Contracts are store-scoped and always accessible to dispatchers",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'payroll_page',
        bot: "💰 **Payroll** (admins only) — Track driver compensation:\n\n• Daily/period earnings per driver\n• Delivery count and completion rate\n• COD collected totals\n• Notes and adjustments\n\nDrivers can view their own earnings, but only admins can modify payroll data.",
        actions: [{ label: 'Continue', type: 'next' }],
      },
      {
        id: 'tips',
        bot: "💡 **Quick Tips:**\n\n• Tap a stop card on the dashboard to see delivery details\n• Use the 'Optimize Route' button to get the most efficient route\n• Your GPS must be on for arrival detection to work\n• COD badges show the amount to collect — green means collected\n• Pull down to refresh data on most pages\n\nYou can always come back to me by tapping the floating button. I'm here to help!",
        actions: [
          { label: 'Create a delivery', type: 'flow', target: 'create_delivery' },
          { label: 'Create a patient', type: 'flow', target: 'create_patient' },
          { label: 'Start my route', type: 'flow', target: 'start_route' },
          { label: 'Done! 🎉', type: 'end' },
        ],
      },
    ],
  },
};

// ── Page-specific tips ────────────────────────────────────────────────

export const PAGE_TIPS = {
  dashboard: [
    "Tap a stop card to see delivery details and actions.",
    "Use 'Optimize Route' to get the most efficient stop order.",
    "Green checkmarks on stop cards mean the delivery is complete.",
    "The blue polyline shows your route from stop to stop.",
    "Tap the map to interact — use two fingers to zoom.",
    "Your GPS must be enabled for automatic arrival detection.",
  ],
  patients: [
    "Use the search bar to find patients by name or phone number.",
    "Tap 'New Patient' to add someone to the system.",
    "Each patient has a default store — deliveries will auto-select it.",
    "Set recurring delivery days for patients on regular schedules.",
    "The fridge item flag ensures cold-chain handling for medications.",
  ],
  deliveries: [
    "All deliveries are listed here with their current status.",
    "Filter by date, driver, or store using the controls at the top.",
    "Click a delivery to view full details or edit it.",
    "Staged deliveries haven't been assigned to a route yet.",
    "Use the status badges to quickly see which deliveries need attention.",
  ],
  payroll: [
    "Select a date range to view driver earnings for that period.",
    "Tap a driver's row to see per-day breakdown and notes.",
    "Completion rate = (total - returned) / total.",
    "COD collected is tracked separately from delivery pay.",
    "Payroll notes can be added per-driver per-day.",
  ],
  documents: [
    "Drivers: upload your license and background check here.",
    "Dispatchers: request access to view a driver's documents.",
    "Contracts are store-scoped — dispatchers can view them anytime.",
    "Access requests expire at midnight the next day or 30 min after viewing.",
    "You'll get a push notification when someone requests your documents.",
  ],
  square: [
    "The Catalog tab shows all active COD items in Square POS.",
    "The Transactions tab shows actual payments collected.",
    "The Reconciliation tab highlights unmatched deliveries.",
    "Green 'Collected' means the payment was verified via Square.",
    "Tap 'Sync' to pull the latest data from Square.",
  ],
  users: [
    "Admins can manage all app users from this page.",
    "Assign roles: Driver, Dispatcher, or Admin.",
    "Link drivers to Square location IDs for COD reconciliation.",
    "Assign drivers to cities for route filtering.",
    "Set sort order to control how drivers appear in lists.",
  ],
  stores: [
    "Each store represents a pharmacy location.",
    "Set the store abbreviation — used in delivery item names.",
    "Configure delivery time windows for AM/PM scheduling.",
    "Link stores to Square location IDs for COD.",
    "Set app fee history for stores that pay platform fees.",
  ],
  settings: [
    "App settings control global behavior across all users.",
    "Temperature thresholds control the safe range for fridge items.",
    "Notification rules control push notification triggers.",
    "VAPID keys are configured for push notifications.",
    "Only admins can modify app settings.",
  ],
};

// ── Help index for natural language matching ─────────────────────────

export const HELP_TOPICS = [
  {
    keywords: ['create', 'new', 'delivery', 'add delivery', 'make delivery'],
    response: "I can guide you through creating a new delivery! It's done from the Dashboard — just tap the green 'New Delivery' button. Want me to walk you through it step by step?",
    action: { type: 'flow', target: 'create_delivery' },
  },
  {
    keywords: ['create', 'new', 'patient', 'add patient', 'make patient', 'register patient'],
    response: "I can help you create a new patient! You can do this from the Patients page or directly from the delivery form. Want me to walk you through it?",
    action: { type: 'flow', target: 'create_patient' },
  },
  {
    keywords: ['start', 'route', 'begin', 'drive', 'my route', 'first delivery'],
    response: "Ready to start your route? Let me walk you through getting going — checking your status, location, and starting your first delivery.",
    action: { type: 'flow', target: 'start_route' },
  },
  {
    keywords: ['cod', 'cash', 'payment', 'collect', 'money', 'square', 'card'],
    response: "COD (Cash on Delivery) collection is simple — when you complete a delivery with COD, you'll be prompted to record the payment. Want me to explain the full process?",
    action: { type: 'flow', target: 'collect_cod' },
  },
  {
    keywords: ['document', 'license', 'upload', 'background', 'contract', 'file'],
    response: "RxDeliver has a secure document system for driver files. Drivers upload their own licenses and background checks, and dispatchers can request access. Want me to explain how?",
    action: { type: 'flow', target: 'upload_docs' },
  },
  {
    keywords: ['tutorial', 'how to', 'help', 'learn', 'guide', 'getting started', 'new user', 'training', 'onboard'],
    response: "Welcome! I can show you around RxDeliver. Let me give you a tour of the key features and how everything works.",
    action: { type: 'flow', target: 'getting_started' },
  },
  {
    keywords: ['optimize', 'route', 'reorder', 'sequence', 'shortest', 'fastest'],
    response: "Route optimization is automatic! When you start your route, RxDeliver uses the HERE API to find the most efficient stop order. You can manually trigger optimization using the 'Optimize Route' button on the dashboard. The system considers time windows, traffic, and stop priority.",
  },
  {
    keywords: ['arrive', 'arrival', 'auto', 'detect', 'gps', 'location'],
    response: "RxDeliver auto-detects your arrival at a delivery using GPS proximity. When you get within ~50 meters of the destination, the app will prompt you with an 'Arrived' notification. Make sure your location tracking is enabled — the icon is in the sidebar.",
  },
  {
    keywords: ['offline', 'no internet', 'no signal', 'connection', 'disconnected'],
    response: "RxDeliver works offline! All your deliveries are stored locally on your device. You can complete deliveries, collect COD, and view your route even without internet. When you reconnect, everything syncs automatically. The offline indicator in the sidebar shows your sync status.",
  },
  {
    keywords: ['push', 'notification', 'alert', 'message'],
    response: "RxDeliver sends push notifications for: delivery status changes, document access requests, new deliveries assigned to you, and admin alerts. You need to allow notifications when prompted. You can manage notification rules in Settings (admins only).",
  },
  {
    keywords: ['cycling', 'bike', 'bicycle'],
    response: "Cycling routes are for drivers who use bicycles instead of cars. The system calculates a cycling-optimized loop route with a driving leg to/from the cycling start point. Cycling markers appear on the map — tap to see the route. Admins can configure cycling locations per city.",
  },
  {
    keywords: ['temperature', 'fridge', 'cold', 'inkbird', 'sensor'],
    response: "Fridge items require cold-chain monitoring. RxDeliver connects to Inkbird BLE temperature sensors to track fridge temperatures. The temperature badge shows green (safe), yellow (warning), or red (critical) based on thresholds set in App Settings. Alerts trigger when temperatures exceed the safe range.",
  },
  {
    keywords: ['payroll', 'earnings', 'pay', 'wage', 'salary'],
    response: "Driver payroll tracks daily earnings, delivery counts, completion rates, and COD collected. Admins can view all drivers, add notes, and make adjustments. Drivers can view their own earnings. Go to the Payroll page in the sidebar.",
  },
];

// ── Intent matching ──────────────────────────────────────────────────

export function matchIntent(message) {
  const lower = (message || '').toLowerCase().trim();
  if (!lower) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const topic of HELP_TOPICS) {
    let score = 0;
    for (const keyword of topic.keywords) {
      if (lower.includes(keyword)) {
        score += keyword.length; // Longer matches score higher
      }
      // Word boundary check
      const words = lower.split(/\s+/);
      for (const word of words) {
        if (word === keyword || word.startsWith(keyword)) {
          score += keyword.length;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = topic;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}
