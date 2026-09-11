import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Coffee, Delete, LogIn, LogOut, Loader2, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BrandLogo } from "@/components/brand";
import { noindexSeo } from "@/lib/seo";

/**
 * The shared clock-in screen: a tablet by the door that belongs to nobody.
 *
 * It is deliberately outside `_authenticated` and holds no session. Staff are
 * identified by a 4-digit code, and every action goes through a kiosk_* RPC
 * that authenticates the *device* by the token in this URL. There is nothing
 * to navigate to from here — no links, no sign-in — so the device cannot reach
 * anyone's account, and losing the tablet leaks nothing but the ability to
 * punch, which an admin can revoke from the app.
 */
export const Route = createFileRoute("/clock/$token")({
  ssr: false,
  head: () => noindexSeo("Shared clock-in | Scheduling Pilot"),
  component: SharedClockInPage,
});

type Device = { company: string | null; label: string | null };
type Person = { name: string; state: "in" | "out" | "on_break"; breaks: Record<string, boolean> };

/** Every kiosk_* RPC answers in this shape; a refused code is `ok: false`, not an error. */
type KioskReply = {
  ok: boolean;
  message?: string;
  company?: string;
  label?: string;
  name?: string;
  state?: Person["state"];
  breaks?: Record<string, boolean>;
  kind?: string;
  at?: string;
};

/** How long a confirmation stays up before the screen is ready for the next person. */
const CONFIRM_MS = 4000;
const BREAK_LENGTHS = [10, 30, 60] as const;

function callKiosk(
  fn: "kiosk_device_info" | "kiosk_state" | "kiosk_punch",
  args: Record<string, unknown>,
) {
  // The generated types carry these as Json; the shape is KioskReply.
  return supabase.rpc(fn, args as never).then(({ data, error }) => {
    if (error) {
      // A transport or setup failure, not a refused code. Say something the
      // person at the tablet can act on and leave the detail in the console
      // for whoever set the device up.
      console.error("[shared clock-in]", error);
      return {
        ok: false,
        message: "This clock-in screen can not reach the server. Ask an admin to check it.",
      } satisfies KioskReply;
    }
    return (data ?? { ok: false, message: "No answer from the server." }) as unknown as KioskReply;
  });
}

function SharedClockInPage() {
  const { token } = Route.useParams();

  const [device, setDevice] = useState<Device | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [person, setPerson] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    void callKiosk("kiosk_device_info", { _token: token }).then((reply) => {
      if (reply.ok) setDevice({ company: reply.company ?? null, label: reply.label ?? null });
      else setDeviceError(reply.message ?? "This device link is no longer valid.");
    });
  }, [token]);

  const reset = useCallback(() => {
    setCode("");
    setPerson(null);
    setError(null);
  }, []);

  // A confirmation clears itself, so the next person always walks up to a fresh
  // keypad rather than the last person's name.
  useEffect(() => {
    if (!confirmation) return;
    const timer = setTimeout(() => {
      setConfirmation(null);
      reset();
    }, CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmation, reset]);

  // Four digits is the whole code, so look the person up without an extra tap.
  useEffect(() => {
    if (code.length !== 4 || person || busy) return;
    setBusy(true);
    setError(null);
    void callKiosk("kiosk_state", { _token: token, _code: code }).then((reply) => {
      setBusy(false);
      if (!reply.ok || !reply.name || !reply.state) {
        setError(reply.message ?? "That code was not recognised.");
        setCode("");
        return;
      }
      setPerson({ name: reply.name, state: reply.state, breaks: reply.breaks ?? {} });
    });
  }, [code, person, busy, token]);

  async function punch(action: "clock" | "break", minutes?: number) {
    setBusy(true);
    setError(null);
    const reply = await callKiosk("kiosk_punch", {
      _token: token,
      _code: code,
      _action: action,
      _minutes: minutes ?? null,
    });
    setBusy(false);
    if (!reply.ok) {
      setError(reply.message ?? "That didn't go through. Try again.");
      return;
    }
    const at = reply.at ? new Date(reply.at) : new Date();
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const what =
      reply.kind === "in"
        ? "Clocked in"
        : reply.kind === "out"
          ? "Clocked out"
          : reply.kind === "break_start"
            ? "Break started"
            : "Back from break";
    setConfirmation(`${what} at ${time}`);
    setPerson((p) => (p ? { ...p, name: reply.name ?? p.name } : p));
  }

  if (deviceError) {
    return (
      <Screen>
        <p className="text-center text-lg text-destructive">{deviceError}</p>
      </Screen>
    );
  }

  if (!device) {
    return (
      <Screen>
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="text-center">
        <BrandLogo className="mx-auto h-14" />
        <h1 className="mt-4 text-2xl font-semibold text-foreground">
          {device.company ?? "Clock in"}
        </h1>
        <p className="text-sm text-muted-foreground">{device.label}</p>
      </div>

      {confirmation && person ? (
        <div className="mt-10 text-center">
          <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" />
          <p className="mt-4 text-3xl font-semibold text-foreground">{person.name}</p>
          <p className="mt-2 text-xl text-muted-foreground">{confirmation}</p>
        </div>
      ) : person ? (
        <div className="mt-8 w-full">
          <p className="text-center text-3xl font-semibold text-foreground">{person.name}</p>
          <p className="mt-1 text-center text-base text-muted-foreground">
            {person.state === "out"
              ? "Not clocked in"
              : person.state === "on_break"
                ? "On break"
                : "On the clock"}
          </p>

          <div className="mt-8 space-y-3">
            {person.state === "out" && (
              <BigButton onClick={() => void punch("clock")} disabled={busy} tone="go">
                <LogIn className="h-7 w-7" /> Clock in
              </BigButton>
            )}

            {person.state === "in" && (
              <>
                <BigButton onClick={() => void punch("clock")} disabled={busy} tone="stop">
                  <LogOut className="h-7 w-7" /> Clock out
                </BigButton>
                <div className="grid grid-cols-3 gap-3">
                  {BREAK_LENGTHS.filter((m) => person.breaks[String(m)] !== false).map((m) => (
                    <BigButton
                      key={m}
                      onClick={() => void punch("break", m)}
                      disabled={busy}
                      tone="quiet"
                    >
                      <Coffee className="h-6 w-6" /> {m} min
                    </BigButton>
                  ))}
                </div>
              </>
            )}

            {person.state === "on_break" && (
              <BigButton onClick={() => void punch("break")} disabled={busy} tone="go">
                <Coffee className="h-7 w-7" /> End break
              </BigButton>
            )}

            <button
              onClick={reset}
              className="mx-auto block px-4 py-3 text-base font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-8 w-full">
          <p className="text-center text-lg text-muted-foreground">Enter your 4-digit code</p>

          <div
            className="mt-5 flex justify-center gap-3"
            aria-label={`${code.length} of 4 digits entered`}
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`h-14 w-12 rounded-xl border-2 text-center text-3xl leading-[3rem] ${
                  code[i]
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-border bg-card text-transparent"
                }`}
              >
                {code[i] ? "●" : "0"}
              </span>
            ))}
          </div>

          <div className="mx-auto mt-8 grid max-w-xs grid-cols-3 gap-3">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <KeypadKey
                key={d}
                onClick={() => setCode((c) => (c.length < 4 ? c + d : c))}
                disabled={busy}
              >
                {d}
              </KeypadKey>
            ))}
            <KeypadKey onClick={reset} disabled={busy} aria-label="Clear">
              <span className="text-lg">Clear</span>
            </KeypadKey>
            <KeypadKey onClick={() => setCode((c) => (c.length < 4 ? c + "0" : c))} disabled={busy}>
              0
            </KeypadKey>
            <KeypadKey
              onClick={() => setCode((c) => c.slice(0, -1))}
              disabled={busy}
              aria-label="Backspace"
            >
              <Delete className="h-7 w-7" />
            </KeypadKey>
          </div>
        </div>
      )}

      {busy && <Loader2 className="mt-6 h-6 w-6 animate-spin text-muted-foreground" />}
      {error && (
        <p className="mt-6 rounded-lg bg-destructive/10 px-4 py-3 text-center text-base font-medium text-destructive">
          {error}
        </p>
      )}
    </Screen>
  );
}

/** Full-screen frame with nothing to navigate to. */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen select-none flex-col items-center justify-center bg-secondary/40 px-4 py-8">
      <div className="flex w-full max-w-md flex-col items-center">{children}</div>
    </div>
  );
}

function KeypadKey({
  children,
  onClick,
  disabled,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-20 items-center justify-center rounded-2xl border border-border bg-card text-3xl font-medium text-foreground shadow-sm transition-colors hover:bg-accent active:bg-accent disabled:opacity-50"
      {...rest}
    >
      {children}
    </button>
  );
}

function BigButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone: "go" | "stop" | "quiet";
}) {
  const tones = {
    go: "bg-emerald-600 text-white hover:bg-emerald-700",
    stop: "bg-primary text-primary-foreground hover:bg-primary/90",
    quiet: "border border-border bg-card text-foreground hover:bg-accent",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-20 w-full items-center justify-center gap-3 rounded-2xl text-2xl font-semibold shadow-sm transition-colors disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
