import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isNativeApp } from "@/lib/native/platform";

/**
 * Ghost as one person — the browser side of /api/ghost-person.
 *
 * Starting swaps this browser's sign-in for the person's, keeping the platform
 * admin's own tokens here so Exit can swap back without a password. Everything
 * in between is that person's real session: their screens, their data, and
 * anything saved is saved as them. The server logs the start and end.
 *
 * Both swaps finish with a full page load, so no cached query, live channel or
 * context from one account is left showing for the other.
 */

const KEY = "ps-ghost-person";

export interface GhostPerson {
  /** The platform admin's own session, restored on exit. */
  admin: { access_token: string; refresh_token: string };
  target: { id: string; name: string };
  startedAt: string;
}

function read(): GhostPerson | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as GhostPerson) : null;
  } catch {
    return null;
  }
}

// useSyncExternalStore needs the same object back while nothing changed.
let lastRaw: string | null = null;
let lastValue: GhostPerson | null = null;
function snapshot(): GhostPerson | null {
  const raw = localStorage.getItem(KEY);
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = read();
  }
  return lastValue;
}

function subscribe(cb: () => void) {
  const on = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", on);
  return () => window.removeEventListener("storage", on);
}

/** The person this browser is ghosting, or null. */
export function useGhostPerson(): GhostPerson | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

export function isGhostingPerson(): boolean {
  return read() !== null;
}

// Website only: the apps are served from the device and have no /api to call,
// so the Accounts page hides the button there (see canGhostPeopleHere).
const endpoint = () => "/api/ghost-person";
export const canGhostPeopleHere = () => !isNativeApp();

async function call(accessToken: string, body: unknown) {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function startGhostPerson(target: { id: string; name: string }) {
  if (read()) throw new Error("Exit the current ghost session first.");
  const { data } = await supabase.auth.getSession();
  const own = data.session;
  if (!own) throw new Error("Sign in again first.");

  const tokens = await call(own.access_token, { action: "start", userId: target.id });

  const marker: GhostPerson = {
    admin: { access_token: own.access_token, refresh_token: own.refresh_token },
    target,
    startedAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(marker));
  const { error } = await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (error) {
    localStorage.removeItem(KEY);
    await supabase.auth.setSession(marker.admin);
    throw error;
  }
  window.location.assign("/dashboard");
}

/** Back to the platform admin's own account. Safe to call more than once. */
export async function endGhostPerson(goTo = "/accounts") {
  const marker = read();
  if (!marker) return;
  const { data } = await supabase.auth.getSession();
  const ghostToken = data.session?.access_token ?? "";

  const { data: restored, error } = await supabase.auth.setSession(marker.admin);
  localStorage.removeItem(KEY);
  if (error || !restored.session) {
    // The saved sign-in no longer works (signed out elsewhere, or revoked):
    // drop the ghost session too, and start over at the login screen.
    await supabase.auth.signOut({ scope: "local" });
    window.location.assign("/login");
    return;
  }
  try {
    await call(restored.session.access_token, { action: "end", targetAccessToken: ghostToken });
  } catch (e) {
    console.error("[ghost] could not close the ghost session on the server", e);
  }
  window.location.assign(goTo);
}
