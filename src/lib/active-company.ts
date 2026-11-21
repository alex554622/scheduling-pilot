/**
 * Which company this tab is working in.
 *
 * Every database request carries it as the `x-company-id` header (see
 * `@/integrations/supabase/client`). The database only honours it when the
 * signed-in person has an active membership there, so it selects — it never
 * grants. Each tab keeps its own, so switching on the laptop never changes
 * where a punch from the phone lands.
 */

let activeCompanyId: string | null = null;

export function getActiveCompanyId(): string | null {
  return activeCompanyId;
}

export function setActiveCompanyId(id: string | null) {
  activeCompanyId = id;
}

const KEY_PREFIX = "ps.company.";

/** The company this person last picked on this device. */
export function readRememberedCompany(userId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + userId);
  } catch {
    return null;
  }
}

export function rememberCompany(userId: string, companyId: string | null) {
  try {
    if (companyId) localStorage.setItem(KEY_PREFIX + userId, companyId);
    else localStorage.removeItem(KEY_PREFIX + userId);
  } catch {
    /* private mode, storage blocked: the server keeps the choice too */
  }
}
