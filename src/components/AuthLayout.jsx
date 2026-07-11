import React from "react";

const APP_LOGO_URL = 'https://placehold.co/200x200?text=Logo';

export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center mb-4">
            <img src="https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/0aeae1e24_renametoicon-192.png" alt="RxDeliver" className="w-16 h-16 object-contain rounded-2xl" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-2">{subtitle}</p>}
        </div>
        <div className="bg-card rounded-2xl shadow-sm border border-border p-8">
          {children}
        </div>
        {footer &&
        <p className="text-center text-sm text-muted-foreground mt-6">{footer}</p>
        }
      </div>
    </div>);

}