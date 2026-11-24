import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Building2, Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth, ROLE_LABEL, roleLabel, type AppRole } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/error-message";

const ROLE_ORDER = ["super_admin", "company_admin", "supervisor", "employee"];

/** The role to show for a membership: the strongest one held there. */
function topRole(roles: string[]): string | null {
  return ROLE_ORDER.find((r) => roles.includes(r)) ?? roles[0] ?? null;
}

/**
 * The company and role in the header, and the way to change company. Shown to
 * everyone with a company; the menu lists every company the account belongs
 * to, with the role held in each.
 */
export function CompanySwitcher({
  primaryRole,
  fallbackName,
}: {
  primaryRole: AppRole | null;
  fallbackName: string;
}) {
  const { company, memberships, switchCompany, ghost } = useAuth();
  const t = useT("shell");
  const [switching, setSwitching] = useState<string | null>(null);

  const title = (
    <span className="block min-w-0 text-left">
      <span className="block truncate text-xs text-muted-foreground">
        {company?.name ?? fallbackName}
      </span>
      <span className="block truncate text-base font-semibold text-foreground">
        {/* "workspace" is the word that goes on a phone, so the role itself —
            the part that tells you which screen you're on — is never the part
            that gets cut off. */}
        {primaryRole ? (
          <>
            {t(ROLE_LABEL[primaryRole])}
            <span className="hidden sm:inline"> {t("workspace")}</span>
          </>
        ) : (
          t("Workspace")
        )}
      </span>
    </span>
  );

  // Ghost mode and super admins without a company keep the plain heading.
  if (ghost || !company) return title;

  const otherUnread = memberships
    .filter((m) => m.companyId !== company.id)
    .reduce((n, m) => n + m.unread, 0);

  async function pick(companyId: string) {
    if (companyId === company?.id) return;
    setSwitching(companyId);
    try {
      await switchCompany(companyId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSwitching(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="-mx-2 flex min-w-0 max-w-[60vw] items-center gap-2 rounded-md px-2 py-1 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-xs"
        aria-label={t("Switch company")}
      >
        {title}
        <span className="relative shrink-0">
          <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
          {otherUnread > 0 && (
            <span
              className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary"
              aria-label={t("Unread notifications in another company")}
            />
          )}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(20rem,calc(100vw-2rem))]">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
          {t("Your companies")}
        </DropdownMenuLabel>
        {memberships.map((m) => {
          const current = m.companyId === company.id;
          const role = topRole(m.roles);
          const disabled = m.status !== "active" || switching !== null;
          return (
            <DropdownMenuItem
              key={m.companyId}
              disabled={disabled && !current}
              onSelect={(e) => {
                e.preventDefault();
                void pick(m.companyId);
              }}
              className="flex items-center gap-3 py-2"
            >
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{m.name || company.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {m.status === "suspended"
                    ? t("Suspended")
                    : m.companyStatus !== "active"
                      ? t(m.companyStatus.replace("_", " "))
                      : role
                        ? role === "supervisor"
                          ? t("Supervisor")
                          : roleLabel(role)
                        : t("No role yet")}
                </span>
              </span>
              {switching === m.companyId ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : current ? (
                <Check className="h-4 w-4 text-primary" />
              ) : m.unread > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {m.unread}
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/settings"
            search={{ tab: "companies" }}
            className="flex items-center gap-3 py-2"
          >
            <Plus className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">{t("Join another company")}</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
