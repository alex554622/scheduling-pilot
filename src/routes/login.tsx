import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useState } from "react";
import {
  Loader2,
  Mail,
  Lock,
  Eye,
  EyeOff,
  ShieldCheck,
  Building2,
  UserRound,
  Check,
  ArrowLeft,
  ChevronRight,
} from "lucide-react";
import { BrandLogo, APP_NAME } from "@/components/brand";
import { Decorations } from "@/components/showcase";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { clearSignupIntent, saveSignupIntent } from "@/lib/signup-intent";
import { takeAuthLinkError } from "@/lib/auth-link-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { noindexSeo } from "@/lib/seo";
import { useT } from "@/lib/i18n";

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
  // Public but not a search result worth having; follow keeps link equity
  // flowing back to the marketing pages it links to.
  head: () => noindexSeo("Log in | Scheduling Pilot", { follow: true }),
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
  const t = useT("shell");
  const navigate = useNavigate();
  const { mode: modeParam, kind: kindParam } = Route.useSearch();
  const [mode, setMode] = useState<Mode>(modeParam === "signup" ? "signup" : "signin");
  const [signupKind, setSignupKind] = useState<SignupKind>(kindParam ?? "create");
  // Which kind of account comes first, on its own screen. The form used to open
  // on "Business account" with the alternatives as small tabs, and employees
  // who didn't notice them registered whole businesses by mistake. A link that
  // already says which kind (`?kind=`) skips the question.
  const [signupStep, setSignupStep] = useState<"choose" | "form">(kindParam ? "form" : "choose");

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

  // An expired or already-used confirmation link ends up here with no session.
  // Say why, instead of showing a bare sign-in form.
  useEffect(() => {
    const linkError = takeAuthLinkError();
    if (linkError) setError(linkError);
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
      setError(t("Enter the 8-character company code from your admin (letters and digits)."));
      return;
    }
    if (email.trim().toLowerCase() !== emailConfirm.trim().toLowerCase()) {
      setBusy(false);
      setError(t("Email and confirm email do not match."));
      return;
    }
    if (password !== passwordConfirm) {
      setBusy(false);
      setError(t("Password and confirm password do not match."));
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
          ? t("Check your email to confirm the account, then sign in.")
          : t(
              "Check your email to confirm the account, then sign in — we'll finish the company setup for you.",
            ),
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
                {mode === "signin" ? t("Welcome back") : t("Create your account")}
              </h2>
              <p className="mt-2 text-lg text-muted-foreground">
                {mode === "signin"
                  ? t("Sign in to {app}", { app: APP_NAME })
                  : signupStep === "choose"
                    ? t("First, which describes you?")
                    : signupKind === "create"
                      ? t("Set up your business")
                      : t("Create your employee account")}
              </p>
            </div>

            {mode === "signin" ? (
              <form className="mt-8 space-y-5" onSubmit={handleSignIn}>
                <div className="space-y-1.5">
                  <Label htmlFor="email">{t("Email")}</Label>
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
                  <Label htmlFor="password">{t("Password")}</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      required
                      placeholder={t("Enter your password")}
                      className="h-11 pl-10 pr-10"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? t("Hide password") : t("Show password")}
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
                    {t("Remember me")}
                  </label>
                  <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">
                    {t("Forgot password?")}
                  </Link>
                </div>

                <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("Sign In")}
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  {t("New here?")}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("signup");
                      setSignupStep("choose");
                      setError(null);
                      setInfo(null);
                    }}
                    className="font-medium text-primary hover:underline"
                  >
                    {t("Create an account")}
                  </button>
                </p>
              </form>
            ) : signupStep === "choose" ? (
              <AccountTypeChooser
                onPick={(k) => {
                  setSignupKind(k);
                  setSignupStep("form");
                  setError(null);
                }}
                onSignIn={() => {
                  setMode("signin");
                  setError(null);
                  setInfo(null);
                }}
              />
            ) : (
              <form className="mt-6 space-y-4" onSubmit={handleSignUp}>
                {/* What they picked, and the way back. */}
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {signupKind === "create" ? (
                      <Building2 className="h-5 w-5 shrink-0 text-primary" />
                    ) : (
                      <UserRound className="h-5 w-5 shrink-0 text-primary" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {signupKind === "create" ? t("Business account") : t("Employee account")}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {signupKind === "create"
                          ? t("For owners and managers")
                          : t("For people who work at a business")}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSignupStep("choose");
                      setError(null);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" /> {t("Change")}
                  </button>
                </div>

                {signupKind !== "create" && (
                  <div className="grid grid-cols-2 gap-2">
                    {(["join", "solo"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setSignupKind(k)}
                        className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${signupKind === k ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
                      >
                        {k === "join" ? t("I have a company code") : t("I don't have a code yet")}
                      </button>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="first-name">{t("First name")}</Label>
                    <Input id="first-name" autoComplete="given-name" required maxLength={50} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="last-name">{t("Last name")}</Label>
                    <Input id="last-name" autoComplete="family-name" required maxLength={50} value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email-up">{t("Email")}</Label>
                  <Input id="email-up" type="email" autoComplete="email" required maxLength={255} placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email-confirm">{t("Confirm email")}</Label>
                  <Input id="email-confirm" type="email" autoComplete="email" required maxLength={255} value={emailConfirm} onChange={(e) => setEmailConfirm(e.target.value)} onPaste={(e) => e.preventDefault()} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password-up">{t("Password")}</Label>
                  <Input id="password-up" type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password-confirm">{t("Confirm password")}</Label>
                  <Input id="password-confirm" type="password" autoComplete="new-password" minLength={6} required value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} onPaste={(e) => e.preventDefault()} />
                </div>
                {signupKind === "create" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="company">{t("Business name")}</Label>
                    <Input id="company" required value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                    <p className="text-xs text-muted-foreground">
                      {t("You'll be the admin for this business, and it starts on a free trial once we approve it.")}
                    </p>
                  </div>
                )}
                {signupKind === "join" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="company-id">{t("Company code")}</Label>
                    <Input id="company-id" required placeholder={t("e.g. A1B2C3D4")} maxLength={12} value={companyId} onChange={(e) => setCompanyId(e.target.value.toUpperCase())} className="uppercase tracking-widest" />
                    <p className="text-xs text-muted-foreground">{t("Ask your manager for the 8-character company code. Your request will need their approval.")}</p>
                  </div>
                )}
                {signupKind === "solo" && (
                  <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
                    {t("Creates your employee profile on its own. You can add a company any time from the app once you have a join code from your manager.")}
                  </p>
                )}
                <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("Create account")}
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  {t("Already have an account?")}{" "}
                  <button
                    type="button"
                    onClick={() => { setMode("signin"); setError(null); setInfo(null); }}
                    className="font-medium text-primary hover:underline"
                  >
                    {t("Sign in")}
                  </button>
                </p>
              </form>
            )}

            {error && <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            {info && <p className="mt-4 rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">{info}</p>}

            <p className="mt-8 text-center text-sm font-medium text-muted-foreground">
              {t("Powered by Valladolid NovaTech")}
            </p>
          </div>

          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("Secure access for authorized users only.")}
          </p>
          <p className="mt-3 text-center">
            <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
              {t("← Back to home")}
            </Link>
          </p>
      </div>
    </div>
  );
}

/**
 * The first question of sign-up: running a business, or working at one.
 *
 * Each card says what that account can do and what happens after the form,
 * because the two differ in ways people only discover later — a business waits
 * for our approval, an employee waits for their manager's.
 */
function AccountTypeChooser({
  onPick,
  onSignIn,
}: {
  onPick: (kind: SignupKind) => void;
  onSignIn: () => void;
}) {
  const t = useT("shell");
  const cards: {
    kind: SignupKind;
    icon: typeof Building2;
    title: string;
    who: string;
    points: string[];
    next: string;
    cta: string;
  }[] = [
    {
      kind: "create",
      icon: Building2,
      title: "I run a business",
      who: "Owners and managers setting up their team",
      points: [
        "Build and publish schedules",
        "Approve time off, shift trades and timecards",
        "Invite employees with your company code",
        "Billing and company settings",
      ],
      next: "We review every new business before it goes live, and notify you the moment it's approved. Your free trial starts then.",
      cta: "Create a business account",
    },
    {
      kind: "join",
      icon: UserRound,
      title: "I work for a business",
      who: "Employees whose workplace uses Scheduling Pilot",
      points: [
        "See your schedule on any device",
        "Clock in and out",
        "Request time off and trade shifts",
        "Get notified when your shifts change",
      ],
      next: "You'll need the company code from your manager — they approve you before you can see the schedule. No code yet? You can add it later.",
      cta: "Create an employee account",
    },
  ];

  return (
    <div className="mt-6 space-y-4">
      {cards.map((c) => (
        <button
          key={c.kind}
          type="button"
          onClick={() => onPick(c.kind)}
          className="group w-full rounded-2xl border border-border bg-background p-5 text-left transition-colors hover:border-primary hover:bg-primary-soft/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
              <c.icon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-foreground">{t(c.title)}</p>
              <p className="text-sm text-muted-foreground">{t(c.who)}</p>
            </div>
            <ChevronRight className="mt-2 h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </div>
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {c.points.map((p) => (
              <li key={p} className="flex items-start gap-1.5 text-sm text-foreground">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                {t(p)}
              </li>
            ))}
          </ul>
          <p className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{t("What happens next: ")}</span>
            {t(c.next)}
          </p>
          <p className="mt-3 text-sm font-medium text-primary">{t(c.cta)} →</p>
        </button>
      ))}

      <p className="text-center text-xs text-muted-foreground">
        {t("Not sure? If someone else pays for the app at your job, you're an employee.")}
      </p>

      <p className="text-center text-sm text-muted-foreground">
        {t("Already have an account?")}{" "}
        <button type="button" onClick={onSignIn} className="font-medium text-primary hover:underline">
          {t("Sign in")}
        </button>
      </p>
    </div>
  );
}
