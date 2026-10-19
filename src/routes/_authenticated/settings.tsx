import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, ROLE_LABEL } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  Check,
  KeyRound,
  UserCog,
  Building2,
  Copy,
  Bell,
  Moon,
  Sun,
  MonitorSmartphone,
  Languages,
} from "lucide-react";
import { isNativeApp } from "@/lib/native/platform";
import {
  hasNativePushToken,
  nativePushPermission,
  registerNativePush,
  requestNativePushPermission,
  unregisterNativePush,
} from "@/lib/native/push";
import { DeleteAccountCard } from "@/components/delete-account";
import { SUPPORT_EMAIL } from "@/lib/contact";
import { useThemePref, type ThemePref } from "@/lib/theme";
import { LANGUAGES, useLang, useT } from "@/lib/i18n";
import { SCHEDULE_LAYOUTS, useScheduleLayout } from "@/lib/schedule-layout";
import { playBreakAlert, playChime } from "@/lib/notify-sound";
import { useBreakAlertSound } from "@/lib/break-alert-sound";
import { Switch } from "@/components/ui/switch";
import {
  NOTIFICATION_TYPES,
  desktopPermission,
  isStandalone,
  requestDesktopPermission,
  useNotificationPrefs,
} from "@/lib/notification-prefs";
import {
  pushConfigured,
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push-subscription";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { user, profile, primaryRole, company, refresh, loading } = useAuth();
  const t = useT("shell");
  const [fullName, setFullName] = useState("");
  const [position, setPosition] = useState("");
  const [savedProfile, setSavedProfile] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setFullName(profile.full_name ?? "");
      setPosition(profile.position ?? "");
    }
  }, [profile]);

  const saveProfile = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName.trim(), position: position.trim() || null })
        .eq("id", user!.id);
      if (error) throw error;
      await refresh();
    },
    onSuccess: () => {
      setSavedProfile(true);
      setProfileErr(null);
      setTimeout(() => setSavedProfile(false), 1500);
    },
    onError: (e: unknown) => setProfileErr(e instanceof Error ? e.message : String(e)),
  });

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwOk, setPwOk] = useState(false);

  const changePw = useMutation({
    mutationFn: async () => {
      if (pw.length < 8) throw new Error(t("Password must be at least 8 characters"));
      if (pw !== pw2) throw new Error(t("Passwords don't match"));
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
    },
    onSuccess: () => {
      setPw("");
      setPw2("");
      setPwErr(null);
      setPwOk(true);
      setTimeout(() => setPwOk(false), 2000);
    },
    onError: (e: unknown) => setPwErr(e instanceof Error ? e.message : String(e)),
  });

  const canSeeCode = primaryRole === "company_admin" || primaryRole === "super_admin";
  const [copied, setCopied] = useState(false);

  // Company name. The existing company_admin_update policy already lets an admin
  // update their own company row (the same route timezone and worksite settings
  // take), so this needs no new database work.
  const [companyName, setCompanyName] = useState("");
  const [companyErr, setCompanyErr] = useState<string | null>(null);
  const [companySaved, setCompanySaved] = useState(false);

  useEffect(() => {
    if (company) setCompanyName(company.name ?? "");
  }, [company]);

  const saveCompanyName = useMutation({
    mutationFn: async () => {
      const next = companyName.trim();
      // `name` is NOT NULL but an empty string would satisfy that, leaving the
      // company nameless everywhere it is displayed.
      if (!next) throw new Error(t("Organization name can't be empty"));
      if (next.length > 120) throw new Error(t("Organization name must be 120 characters or fewer"));
      if (next === company?.name) return;

      const { error } = await supabase
        .from("companies")
        .update({ name: next })
        .eq("id", company!.id);
      if (error) throw error;
      // Refresh so the sidebar, header and every "Company: …" label pick up the
      // new name without a reload.
      await refresh();
    },
    onSuccess: () => {
      setCompanyErr(null);
      setCompanySaved(true);
      setTimeout(() => setCompanySaved(false), 1500);
    },
    onError: (e: unknown) => setCompanyErr(e instanceof Error ? e.message : String(e)),
  });

  const companyNameDirty = !!company && companyName.trim() !== company.name;

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">{t("Settings")}</h2>
        <p className="text-sm text-muted-foreground">{t("Manage your profile and password.")}</p>
      </div>

      {canSeeCode && company && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="mb-4 flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">{t("Organization name")}</h3>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="company-name">{t("Organization name")}</Label>
              <Input
                id="company-name"
                value={companyName}
                maxLength={120}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder={t("e.g. City of Calexico")}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Shown to your team across the app, on schedules you publish, and on printed timecards.",
                )}
              </p>
            </div>
            {companyErr && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {companyErr}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                onClick={() => saveCompanyName.mutate()}
                disabled={saveCompanyName.isPending || !companyNameDirty || !companyName.trim()}
              >
                {saveCompanyName.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {companySaved && <Check className="h-4 w-4" />}
                {companySaved ? t("Saved") : t("Save name")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {canSeeCode && company && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="mb-3 flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">{t("Company join code")}</h3>
          </div>
          {company.status !== "active" ? (
            <p className="text-sm text-muted-foreground">
              {t("Your company is")}{" "}
              <span className="font-medium text-foreground">
                {t(company.status.replace("_", " "))}
              </span>
              {t(". A join code will be generated once a platform admin approves your company.")}
            </p>
          ) : company.join_code ? (
            <>
              <p className="text-sm text-muted-foreground mb-3">
                {t(
                  "Share this code with employees. When they sign up with it, you'll get a join request to approve in the Employees page.",
                )}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-md border border-border bg-secondary/40 px-4 py-3 text-center text-2xl font-mono font-semibold tracking-[0.3em] text-foreground">
                  {company.join_code}
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(company.join_code ?? "");
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? t("Copied") : t("Copy")}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("No code yet — contact support.")}</p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <UserCog className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">{t("Profile")}</h3>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("Email")}</Label>
            <Input value={user?.email ?? ""} disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fn">{t("Full name")}</Label>
            <Input id="fn" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po">{t("Position")}</Label>
            <Input
              id="po"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder={t("e.g. Shift Lead")}
            />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {t("Role:")}{" "}
              <span className="font-medium text-foreground">
                {primaryRole ? t(ROLE_LABEL[primaryRole]) : t("None")}
              </span>
            </span>
            {company && (
              <span>
                {t("Company:")}{" "}
                <span className="font-medium text-foreground">{company.name}</span>
              </span>
            )}
          </div>
          {profileErr && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {profileErr}
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>
              {saveProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {savedProfile && <Check className="h-4 w-4" />}
              {savedProfile ? t("Saved") : t("Save changes")}
            </Button>
          </div>
        </div>
      </div>

      <LanguageSettings />

      <AppearanceSettings />

      <NotificationSettings />

      <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">{t("Change password")}</h3>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="np">{t("New password")}</Label>
            <Input
              id="np"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder={t("Min. 8 characters")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np2">{t("Confirm new password")}</Label>
            <Input id="np2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          {pwErr && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {pwErr}
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={() => changePw.mutate()} disabled={changePw.isPending || !pw || !pw2}>
              {changePw.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {pwOk && <Check className="h-4 w-4" />}
              {pwOk ? t("Updated") : t("Update password")}
            </Button>
          </div>
        </div>
      </div>

      <DeleteAccountCard />

      <p className="text-center text-xs text-muted-foreground">
        <Link to="/privacy" className="underline hover:text-foreground">
          {t("Privacy policy")}
        </Link>
        {" · "}
        {t("Questions? Email {email}", { email: SUPPORT_EMAIL })}
      </p>
    </div>
  );
}

/**
 * Everyone's own notification switches — an employee's as much as an admin's.
 *
 * The master switch and the per-kind ones are saved on the account, because
 * `wants_notification()` reads the same column inside the database triggers
 * that write a notification: switched off here, the row is never created. The
 * desktop pop-up is the exception, since a browser can only grant permission
 * for itself.
 */
function NotificationSettings() {
  const { user } = useAuth();
  const t = useT("shell");
  const breakAlert = useBreakAlertSound();
  const { prefs, unavailable, isSaving, setEnabled, setType, setPopup, setSound, setDesktop } =
    useNotificationPrefs();
  const [permission, setPermission] = useState<string>("default");
  // Whether this device is on the list the server delivers to. Separate from
  // the permission above: permission lets an open page draw a notification,
  // a subscription is what reaches a phone with the app shut.
  const [subscribing, setSubscribing] = useState(false);
  const [deliversClosed, setDeliversClosed] = useState(false);
  // Safari only offers notifications to an app that has been added to the Home
  // Screen, so "unsupported" on an iPhone is an instruction, not a dead end.
  const [needsInstall, setNeedsInstall] = useState(false);
  useEffect(() => {
    // The apps ask the phone, not the web view: its permission and whether
    // this phone's token is on file (@/lib/native/push).
    if (isNativeApp()) {
      void nativePushPermission().then(setPermission);
      void hasNativePushToken().then(setDeliversClosed);
      return;
    }
    const p = desktopPermission();
    setPermission(p);
    setNeedsInstall(
      (p === "unsupported" || !pushSupported()) &&
        !isStandalone() &&
        /iPad|iPhone|iPod/.test(window.navigator.userAgent),
    );
    // Ask the browser itself rather than trusting the saved preference: a
    // subscription can be retired without the account knowing, and this line
    // is the only honest answer to "will my phone actually buzz?".
    if (!pushSupported()) return;
    void navigator.serviceWorker
      .getRegistration("/")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setDeliversClosed(!!sub))
      .catch(() => setDeliversClosed(false));
  }, []);

  async function toggleDesktop(on: boolean) {
    if (!on) {
      setDesktop(false);
      setDeliversClosed(false);
      // Taken off the server's list as well, or it would keep delivering to a
      // device whose switch says it shouldn't.
      void (isNativeApp() ? unregisterNativePush() : unsubscribeFromPush());
      return;
    }
    setSubscribing(true);
    try {
      if (isNativeApp()) {
        const result = await requestNativePushPermission();
        setPermission(result);
        const granted = result === "granted";
        setDesktop(granted);
        setDeliversClosed(granted ? await registerNativePush() : false);
        return;
      }
      const result = await requestDesktopPermission();
      setPermission(result);
      // A browser that refused is not a preference we can honour, so it is not
      // one we save — the line below says why instead.
      const granted = result === "granted";
      setDesktop(granted);
      // Registering for push is what makes this work with the app closed. It
      // can fail on its own — no keys on this deployment, a browser that will
      // not subscribe — and that is worth saying rather than hiding, because
      // the difference is invisible until a notification does not arrive.
      setDeliversClosed(granted && user ? await subscribeToPush(user.id) : false);
    } finally {
      setSubscribing(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center gap-2">
        <Bell className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">{t("Notifications")}</h3>
      </div>

      {unavailable && (
        <p className="mb-4 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          {t(
            "Your notification settings can't be saved yet — this company's database is still waiting on an update. Everything stays switched on until then.",
          )}
        </p>
      )}

      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t("Notifications")}</p>
            <p className="text-xs text-muted-foreground">
              {t("The master switch. Off, nothing reaches your bell and nothing pops up.")}
            </p>
          </div>
          <Switch
            checked={prefs.enabled}
            disabled={unavailable || isSaving}
            onCheckedChange={setEnabled}
            aria-label={t("All notifications")}
          />
        </div>

        <div
          className={`space-y-3 ${prefs.enabled ? "" : "pointer-events-none opacity-50"}`}
          aria-disabled={!prefs.enabled}
        >
          {NOTIFICATION_TYPES.map((nt) => (
            <div key={nt.key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t(nt.label)}</p>
                <p className="text-xs text-muted-foreground">{t(nt.detail)}</p>
              </div>
              <Switch
                checked={prefs.types[nt.key] !== false}
                disabled={unavailable || isSaving}
                onCheckedChange={(v) => setType(nt.key, v)}
                aria-label={t(nt.label)}
              />
            </div>
          ))}

          <div className="flex items-start justify-between gap-4 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t("Pop them up in the app")}</p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "A pop-up in the corner as it arrives, with a button to open it. Off, it only counts up on the bell and waits for you there.",
                )}
              </p>
            </div>
            <Switch
              checked={prefs.popup}
              disabled={unavailable || isSaving}
              onCheckedChange={setPopup}
              aria-label={t("Pop notifications up in the app")}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t("Play a sound")}</p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "A short chime when something pops up — a new message, an announcement, your schedule, or your break running out.",
                )}
              </p>
              {/* The alert is not a preference, so it is explained rather than
                  offered. Somebody who hears it once and does not know why it
                  differs from everything else will think it is a fault. */}
              {breakAlert && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    "Your break reminder is the exception: it plays a louder alert, so it carries when your phone is in a pocket.",
                  )}{" "}
                  <button
                    type="button"
                    onClick={() => playBreakAlert(true)}
                    className="font-medium text-primary hover:underline"
                  >
                    {t("Hear it")}
                  </button>
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* Hearing it is the only way to know what "a chime" means. */}
              <button
                type="button"
                onClick={() => playChime(true)}
                className="text-xs font-medium text-primary hover:underline"
              >
                {t("Test")}
              </button>
              <Switch
                checked={prefs.sound}
                disabled={unavailable || isSaving}
                onCheckedChange={setSound}
                aria-label={t("Play a sound")}
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t("Show them on this device")}</p>
              <p className="text-xs text-muted-foreground">
                {needsInstall
                  ? t(
                      "Add Scheduling Pilot to your Home Screen first — on iPhone and iPad, notifications are only offered to the installed app.",
                    )
                  : permission === "unsupported"
                    ? isNativeApp()
                      ? t("In this version of the app, alerts show inside the app while it's open.")
                      : t("This browser doesn't do system notifications.")
                    : permission === "denied" && isNativeApp()
                      ? t(
                          "Notifications are turned off for this app — allow them in your phone's Settings first.",
                        )
                      : permission === "denied"
                      ? t(
                          "This browser is blocking notifications — allow them in its site settings first.",
                        )
                      : t(
                          "A system pop-up as well as the one in the app, on your phone's lock screen too. Each device asks once.",
                        )}
              </p>
              {/* The difference between "it pops up while I'm looking" and "it
                  wakes my phone in my pocket" is the whole point of the
                  feature, and is invisible until something fails to arrive. */}
              {prefs.desktop && permission === "granted" && (
                <p
                  className={`mt-1 text-xs ${deliversClosed ? "text-muted-foreground" : "text-warning-foreground"}`}
                >
                  {deliversClosed
                    ? t(
                        "These reach you with the app closed — your break reminder will arrive whether or not it's open.",
                      )
                    : !isNativeApp() && !pushConfigured()
                      ? t(
                          "This device will only be told while the app is open: delivery to closed apps isn't set up on this server yet.",
                        )
                      : t(
                          "This device will only be told while the app is open — it couldn't be registered for delivery. Switching this off and on again usually fixes it.",
                        )}
                </p>
              )}
            </div>
            <Switch
              checked={prefs.desktop && permission === "granted"}
              disabled={
                unavailable ||
                isSaving ||
                subscribing ||
                permission === "denied" ||
                permission === "unsupported"
              }
              onCheckedChange={(v) => void toggleDesktop(v)}
              aria-label={t("Show notifications on this device")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * English or Spanish. Saved on this device, like the theme — see `@/lib/i18n`.
 * Each option is labelled in its own language, so someone who cannot read the
 * current one can still find theirs.
 */
function LanguageSettings() {
  const { lang, setLang } = useLang();
  const t = useT("shell");
  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-1 flex items-center gap-2">
        <Languages className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">{t("Language")}</h3>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {t("Saved on this device, so your phone and your computer can each have their own.")}
      </p>
      <div role="radiogroup" aria-label={t("Language")} className="grid gap-2 sm:grid-cols-2">
        {LANGUAGES.map((o) => {
          const active = lang === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              lang={o.value}
              onClick={() => setLang(o.value)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active
                  ? "border-primary bg-primary-soft/40 ring-1 ring-primary"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <span className="block text-sm font-medium text-foreground">{o.native}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Day, night, or whatever the phone is doing. Saved on this device only — see
 * `@/lib/theme` for why — so the card says so rather than letting someone
 * wonder why their laptop did not follow their phone.
 */
function AppearanceSettings() {
  const { pref, setPref } = useThemePref();
  const t = useT("shell");
  const { layout, setLayout, saving } = useScheduleLayout();
  const [layoutErr, setLayoutErr] = useState<string | null>(null);
  const options: { value: ThemePref; label: string; detail: string; icon: typeof Sun }[] = [
    { value: "light", label: "Day", detail: "Light, always.", icon: Sun },
    { value: "dark", label: "Night", detail: "Dark, always.", icon: Moon },
    {
      value: "system",
      label: "Match device",
      detail: "Follows this phone or computer's own setting.",
      icon: MonitorSmartphone,
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-1 flex items-center gap-2">
        <Moon className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">{t("Appearance")}</h3>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {t("Saved on this device, so your phone and your computer can each have their own.")}
      </p>
      <div role="radiogroup" aria-label={t("Appearance")} className="grid gap-2 sm:grid-cols-3">
        {options.map((o) => {
          const active = pref === o.value;
          const Icon = o.icon;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPref(o.value)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active
                  ? "border-primary bg-primary-soft/40 ring-1 ring-primary"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Icon className="h-4 w-4" />
                {t(o.label)}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t(o.detail)}</span>
            </button>
          );
        })}
      </div>

      {/* Unlike the theme, this one follows the account: the schedule looks the
          same wherever you sign in. */}
      <div className="mt-6 border-t border-border pt-5">
        <p className="text-sm font-medium text-foreground">{t("Schedule layout")}</p>
        <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
          {t(
            "How the Schedule page is laid out for you. Saved to your account, so it follows you to any device.",
          )}
        </p>
        <div role="radiogroup" aria-label={t("Schedule layout")} className="grid gap-2 sm:grid-cols-2">
          {SCHEDULE_LAYOUTS.map((o) => {
            const active = layout === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={saving}
                onClick={() => {
                  setLayoutErr(null);
                  setLayout(o.value).catch((e: Error) => setLayoutErr(e.message));
                }}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  active
                    ? "border-primary bg-primary-soft/40 ring-1 ring-primary"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <span className="block text-sm font-medium text-foreground">{t(o.label)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t(o.detail)}</span>
              </button>
            );
          })}
        </div>
        {layoutErr && (
          <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {layoutErr}
          </p>
        )}
      </div>
    </div>
  );
}
