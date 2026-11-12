"use client";
import React, { useEffect, useState } from "react";
import { Toaster as Sonner } from "sonner"
import { isAppDarkTheme } from "@/lib/utils"

const Toaster = ({
  ...props
}) => {
  // Sonner used to read next-themes' useTheme(), whose default is "system" —
  // so toasts styled themselves from the WINDOWS/macOS color scheme instead of
  // the app's own theme setting (owner report Nov 11 2026: pieces going dark
  // while the app was Light). The toast theme now comes from the app's theme
  // classes and follows them live.
  const [theme, setTheme] = useState(() => isAppDarkTheme() ? "dark" : "light");

  useEffect(() => {
    // Coalesced with requestAnimationFrame so a theme flip (which rewrites the
    // <html> class list several times) cannot trigger a burst of re-renders.
    let raf = 0;
    const sync = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = isAppDarkTheme() ? "dark" : "light";
        setTheme((prev) => (prev === next ? prev : next));
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    (<Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props} />)
  );
}

export { Toaster }