import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useState } from "react";
import { Loader2, Mail, Lock, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { BrandLogo, APP_NAME } from "@/components/brand";
import { Decorations } from "@/components/showcase";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { clearSignupIntent, saveSignupIntent } from "@/lib/signup-intent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "signin" | "signup";
type SignupKind = "create" | "join" | "solo";

/**
 * `mode=signup` opens straight on the sign-up form, and `kind` preselects which
 * kind of account — so "Create account" in the header and "Try free" on a
 * pricing card each land where they promise instead of on the sign-in form.
 * `invite` is passed through by the /join page.
 */
const searchSchema = z.object({
  mode: z.enum(["signin", "signup"]).optional(),
  kind: z.enum(["create", "join", "solo"]).optional(),
  invite: z.string().optional(),
});

export const Route = createFileRoute("/login")({
  validateSearch: (s) => searchSchema.parse(s),
  component: LoginPage,
});

// "Remember me" keeps the email on this device so the next sign-in is one field
// shorter. It deliberately does not touch session lifetime — Supabase already
// persists and refreshes the session, and the usual sessionStorage trick for
// expiring it signs you out the moment you open a second tab.
const REMEMBERED_EMAIL_KEY = "sp-remembered-email";
const REMEMBER_PREF_KEY = "sp-remember";

function readRememberedEmail(): string {
  try {
    return localStorage.getItem(REMEMBERED_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeRememberedEmail(email: string | null) {
  try {
    localStorage.setItem(REMEMBER_PREF_KEY, email ? "1" : "0");
    if (email) localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
    else localStorage.removeItem(REMEMBERED_EMAIL_KEY);
  } catch { /* private mode — the checkbox just won't stick */ }
}

function LoginPage() {
  const { user, loading, primaryRole, refresh } = useAuth();
  const navigate = useNavigate();
  const { mode: modeParam, kind: kindParam } = Route.useSearch();
  const [mode, setMode] = useState<Mode>(modeParam === "signup" ? "signup" : "signin");
  const [signupKind, setSignupKind] = useState<SignupKind>(kindParam ?? "create");

  const [email, setEmail] = useState("");
  const [emailConfirm, setEmailConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyId, setCompanyId] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Restore the remembered email once, after hydration so SSR and the client
  // render the same empty field on the first pass.
  useEffect(() => {
    const saved = readRememberedEmail();
    if (saved) {
      setEmail(saved);
      return;
    }
    // Nothing saved: either a fresh device, or the box was unchecked last time.
    try {
      if (localStorage.getItem(REMEMBER_PREF_KEY) === "0") setRemember(false);
    } catch { /* ignore */ }
  }, []);

  // Once authenticated, leave the login screen. A super admin belongs to no
  // company, so /dashboard (a company's daily roster) is empty for them — send them
  // to the platform view instead. primaryRole is in the deps because it resolves
  // a tick after `user` does, so this re-runs and corrects itself.
  useEffect(() => {
    if (loading || !user) return;
    navigate({ to: primaryRole === "super_admin" ? "/platform" : "/dashboard" });
  }, [loading, user, primaryRole, navigate]);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    writeRememberedEmail(remember ? email.trim() : null);

    // Resolve the role here rather than leaning on the redirect effect: the auth
    // context fills in a tick later, and once we navigate this page unmounts, so
    // the effect would never get a second pass to correct itself.
    let target: "/platform" | "/dashboard" = "/dashboard";
    if (data.user) {
      const { data: roles } = await supabase
        .from("user_roles").select("role").eq("user_id", data.user.id);
      if ((roles ?? []).some((r) => r.role === "super_admin")) target = "/platform";
    }
    setBusy(false);
    navigate({ to: target });
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);

    // Pre-validate the short company code.
    if (signupKind === "join" && !/^[A-Za-z0-9]{6,12}$/.test(companyId.trim())) {
      setBusy(false);
      setError("Enter the 8-character company code from your admin (letters and digits).");
      return;
    }
    if (email.trim().toLowerCase() !== emailConfirm.trim().toLowerCase()) {
      setBusy(false);
      setError("Email and confirm email do not match.");
      return;
    }
    if (password !== passwordConfirm) {
      setBusy(false);
      setError("Password and confirm password do not match.");
      return;
    }

    // Record what this signup asked for BEFORE creating the account. When email
    // confirmation is off, `signUp` fires SIGNED_IN before it returns and the
    // auth provider replays the intent straight away; when it is on, the replay
    // waits for the confirmation link. Either way the request is never lost —
    // this used to bail out early and drop the company code on the floor.
    if (signupKind === "create") saveSignupIntent({ kind: "create", companyName: companyName.trim() }, email);
    else if (signupKind === "join") saveSignupIntent({ kind: "join", code: companyId.trim().toUpperCase() }, email);
    else clearSignupIntent();

    const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Required for email confirmation links to land back in the app.
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: { full_name: fullName, first_name: firstName.trim(), last_name: lastName.trim() },
      },
    });
    if (error) {
      clearSignupIntent();
      setBusy(false);
      setError(error.message);
      return;
    }

    // If email confirmation is required, the session won't be set.
    if (!data.session) {
      setBusy(false);
      setInfo(
        signupKind === "solo"
          ? "Check your email to confirm the account, then sign in."
          : "Check your email to confirm the account, then sign in — we'll finish the company setup for you.",
      );
      setMode("signin");
      return;
    }

    // A session already exists. SIGNED_IN may have landed before the profile row
    // the signup trigger creates was visible, in which case the provider skipped
    // the replay; this second pass picks it up.
    await refresh();
    setBusy(false);
    // The redirect effect above routes by role once the session settles.
  }

  return (
    <div className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-secondary/40 px-4 py-10">
      <Decorations />

      <div className="relative z-10 w-full max-w-lg">
          <div className="rounded-3xl border border-border bg-card p-8 shadow-[var(--shadow-elev)] sm:p-10">
            <Link to="/" className="flex justify-center">
              <BrandLogo className="h-20" />
            </Link>

            <div className="mt-6 text-center">
              <h2 className="text-3xl font-semibold tracking-tight text-foreground">
                {mode === "signin" ? "Welcome back" : "Create your account"}
              </h2>
              <p className="mt-2 text-lg text-muted-foreground">
                {mode === "signin"
                  ? `Sign in to ${APP_NAME}`
                  : "Start a business account, join one with a code, or just create your profile"}
              </p>
            </div>

            {mode === "signin" ? (
              <form className="mt-8 space-y-5" onSubmit={handleSignIn}>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      required
                      placeholder="name@company.com"
                      className="h-11 pl-10"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      required
                      placeholder="Enter your password"
                      className="h-11 pl-10 pr-10"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      className="h-4 w-4 rounded border-border accent-primary"
                    />
                    Remember me
                  </label>
                  <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">
                    Forgot password?
                  </Link>
                </div>

                <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Sign In
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  New here?{" "}
                  <button
                    type="button"
                    onClick={() => { setMode("signup"); setError(null); setInfo(null); }}
                    className="font-medium text-primary hover:underline"
                  >
                    Create an account
                  </button>
                </p>
              </form>
            ) : (
              <form className="mt-6 space-y-4" onSubmit={handleSignUp}>
                <div className="grid grid-cols-3 gap-2">
                  {(["create", "join", "solo"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setSignupKind(k)}
                      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${signupKind === k ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
                    >
                      {k === "create" ? "Business account" : k === "join" ? "Join with a code" : "Employee only"}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="first-name">First name</Label>
                    <Input id="first-name" autoComplete="given-name" required maxLength={50} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="last-name">Last name</Label>
                    <Input id="last-name" autoComplete="family-name" required maxLength={50} value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email-up">Email</Label>
                  <Input id="email-up" type="email" autoComplete="email" required maxLength={255} placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email-confirm">Confirm email</Label>
                  <Input id="email-confirm" type="email" autoComplete="email" required maxLength={255} value={emailConfirm} onChange={(e) => setEmailConfirm(e.target.value)} onPaste={(e) => e.preventDefault()} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password-up">Password</Label>
                  <Input id="password-up" type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password-confirm">Confirm password</Label>
                  <Input id="password-confirm" type="password" autoComplete="new-password" minLength={6} required value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} onPaste={(e) => e.preventDefault()} />
                </div>
                {signupKind === "create" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="company">Business name</Label>
                    <Input id="company" required value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                    <p className="text-xs text-muted-foreground">
                      You'll be the admin for this business, and it starts on a free trial once we approve it.
                    </p>
                  </div>
                )}
                {signupKind === "join" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="company-id">Company code</Label>
                    <Input id="company-id" required placeholder="e.g. A1B2C3D4" maxLength={12} value={companyId} onChange={(e) => setCompanyId(e.target.value.toUpperCase())} className="uppercase tracking-widest" />
                    <p className="text-xs text-muted-foreground">Ask your manager for the 8-character company code. Your request will need their approval.</p>
                  </div>
                )}
                {signupKind === "solo" && (
                  <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
                    Creates your employee profile on its own. You can add a company any time from the app once you have a join code from your manager.
                  </p>
                )}
                <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create account
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{" "}
                  <button
                    type="button"
                    onClick={() => { setMode("signin"); setError(null); setInfo(null); }}
                    className="font-medium text-primary hover:underline"
                  >
                    Sign in
                  </button>
                </p>
              </form>
            )}

            {error && <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            {info && <p className="mt-4 rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">{info}</p>}

            <p className="mt-8 text-center text-sm font-medium text-muted-foreground">
              Powered by Valladolid NovaTech
            </p>
          </div>

          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Secure access for authorized users only.
          </p>
          <p className="mt-3 text-center">
            <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
              ← Back to home
            </Link>
          </p>
      </div>
    </div>
  );
}
