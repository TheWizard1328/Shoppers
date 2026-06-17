import React, { useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogIn, Mail, Lock, Loader2, CheckCircle } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import GoogleIcon from "@/components/GoogleIcon";



export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await base44.auth.loginViaEmailPassword(email, password);
      setSuccess(true);
      setTimeout(() => { window.location.href = "/"; }, 1500);
    } catch (err) {
      const msg = err.message || "";
      // Google/social OAuth accounts don't have a password — guide the user
      if (msg.toLowerCase().includes("password") || msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("incorrect")) {
        setError("Incorrect password. If you signed up with Google, please use the \"Continue with Google\" button above.");
      } else {
        setError(msg || "Invalid email or password");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = () => base44.auth.loginWithProvider("google", "/");
  const handleMicrosoft = () => base44.auth.loginWithProvider("microsoft", "/");
  const handleFacebook = () => base44.auth.loginWithProvider("facebook", "/");
  const handleApple = () => base44.auth.loginWithProvider("apple", "/");

  return (
    <AuthLayout
      icon={LogIn}
      title="Welcome back"
      subtitle="Log in to your RxDeliver account"
      footer={
        <>
          Don't have an account?{" "}
          <Link to="/register" className="text-primary font-medium hover:underline">
            Create one
          </Link>
        </>
      }
    >
      {/* OAuth provider buttons — hidden inside Capacitor APK/IPA builds */}
      <div className="space-y-3 mb-6">
        <Button variant="outline" className="w-full h-12 text-sm font-medium" onClick={handleGoogle}>
          <GoogleIcon className="w-5 h-5 mr-2" />
          Continue with Google
        </Button>
        <Button variant="outline" className="w-full h-12 text-sm font-medium" onClick={handleMicrosoft}>
          <svg className="w-5 h-5 mr-2" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="9" height="9" fill="#F35325"/>
            <rect x="11" y="1" width="9" height="9" fill="#81BC06"/>
            <rect x="1" y="11" width="9" height="9" fill="#05A6F0"/>
            <rect x="11" y="11" width="9" height="9" fill="#FFBA08"/>
          </svg>
          Continue with Microsoft
        </Button>
        <Button variant="outline" className="w-full h-12 text-sm font-medium" onClick={handleFacebook}>
          <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="#1877F2" xmlns="http://www.w3.org/2000/svg">
            <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
          </svg>
          Continue with Facebook
        </Button>
        <Button variant="outline" className="w-full h-12 text-sm font-medium" onClick={handleApple}>
          <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.39.07 2.36.74 3.18.8 1.21-.24 2.37-.93 3.67-.84 1.56.12 2.73.72 3.5 1.9-3.23 1.94-2.46 5.9.7 7.04-.44 1.19-.96 2.35-2.05 3.98zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
          </svg>
          Continue with Apple
        </Button>
      </div>

      <div className="relative mb-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-3 text-muted-foreground">or</span>
        </div>
      </div>

      {success && (
        <div className="mb-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
          <CheckCircle className="w-4 h-4 shrink-0" />
          Login successful! Redirecting you to the RxDeliver Dashboard...
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <Button type="submit" className="w-full h-12 font-medium" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Logging in...
            </>
          ) : (
            "Log in"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}