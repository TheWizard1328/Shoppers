/** @type {import('tailwindcss').Config} */

module.exports = {
    // FIX (Sep 29 2026, v3): v1/v2 both tried to make Tailwind's `dark:` utilities
// follow the app's theme via a custom `addVariant("dark", ...)` plugin call.
// ROOT CAUSE FOUND: Tailwind CORE always registers its own built-in `dark`
// variant from the top-level `darkMode` option (default 'media', i.e. the
// DEVICE'S OS-level light/dark switch) — a plugin re-registering the SAME
// variant name via addVariant is silently overridden by core, confirmed by
// compiling this exact plugin in isolation and inspecting the output: every
// `dark:` utility still compiled wrapped in `@media (prefers-color-scheme:
// dark)`, with NO trace of the plugin's .dark/.dark-theme selector at all.
// This is why the owner saw a split page: components using the app's OWN CSS
// variables (layoutStyles.jsx, --bg-white etc — driven by html.dark/.dark-theme
// classes, unrelated to Tailwind core) rendered dark correctly, while any
// component using a literal Tailwind `dark:bg-slate-800` / `dark:text-...`
// utility (the App Users header/search Card, etc.) rendered by the PHONE'S
// system theme instead of the in-app Dark choice — e.g. an owner device set
// to iOS/Android system Light while the app's own setting is Dark shows a
// half-dark, half-white page. useAutoThemeSync always adds the 'dark' class
// to <html> in BOTH cases that should render dark (explicit dark theme, or
// auto + system-dark) and removes it otherwise — so 'dark' is already the
// single unified signal. Using the top-level `darkMode: 'class'` config (the
// correct/supported way to point Tailwind's dark variant at a class instead
// of the OS) makes core generate `.dark\:bg-slate-800:is(.dark *)` — every
// dark: utility now follows the SAME <html class="dark"> our own vars use,
// with zero dependency on the device's OS appearance setting.
    // FIX (Oct 2 2026, v5): v4 tried darkMode: ['class', '.dark, .dark-theme']
    // to cover BOTH signals. BUG: Tailwind's custom-selector string handling
    // appends the descendant ' *' to only the LAST comma-separated token —
    // the compiled output was literally '.dark\:bg-slate-900:is(.dark,
    // .dark-theme *)'. CSS parses that as :is(.dark) OR :is(.dark-theme *) —
    // the FIRST branch means the ELEMENT ITSELF must carry class="dark"
    // (true only for <html>, never a nested card), not an ANCESTOR check.
    // So explicit Dark theme worked by luck (useAutoThemeSync also adds the
    // 'dark-theme' class, whose branch WAS a correct descendant selector),
    // but Auto-resolved-dark (which only ever gets 'auto-theme' + 'dark', no
    // 'dark-theme') never matched any dark: utility at all — Dark and Auto
    // rendered completely differently, exactly as reported. Fix: plain
    // 'class' strategy compiles to the correct '.dark\:x:is(.dark *)' built
    // in to Tailwind. useAutoThemeSync (JS) already guarantees the literal
    // 'dark' class is present on <html> in EVERY case that should render
    // dark (explicit dark AND auto+system-dark) — that's the one signal
    // needed; no custom multi-selector required.
    darkMode: 'class',
    content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
  	extend: {
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [
    require("tailwindcss-animate"),
  ],
}