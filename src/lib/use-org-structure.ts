import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { DeptPositionLink, OrgDepartment, OrgItem } from "@/lib/org-structure";

export const ORG_STRUCTURE_KEY = "org-structure";

export interface OrgStructure {
  locations: OrgItem[];
  departments: OrgDepartment[];
  positions: OrgItem[];
  links: DeptPositionLink[];
  /** True when the org structure migration isn't on the database yet. */
  missing: boolean;
}

const EMPTY: OrgStructure = {
  locations: [],
  departments: [],
  positions: [],
  links: [],
  missing: false,
};

/**
 * Locations, departments, positions and the department–position links, for
 * the dropdowns. Before the migration runs the new columns are missing: the
 * lists still load, everything counts as active and no department lists
 * positions, which is how the app behaved before.
 */
export function useOrgStructure(companyId: string | null | undefined, enabled = true) {
  const q = useQuery({
    queryKey: [ORG_STRUCTURE_KEY, companyId],
    enabled: !!companyId && enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<OrgStructure> => {
      const cid = companyId!;
      const [l, d, p, k] = await Promise.all([
        supabase
          .from("locations")
          .select("id, name, is_active")
          .eq("company_id", cid)
          .order("name"),
        supabase
          .from("departments")
          .select("id, name, is_active, location_id")
          .eq("company_id", cid)
          .order("name"),
        supabase
          .from("positions")
          .select("id, name, is_active")
          .eq("company_id", cid)
          .order("name"),
        supabase
          .from("department_positions")
          .select("department_id, position_id")
          .eq("company_id", cid),
      ]);
      if (!l.error && !d.error && !p.error && !k.error) {
        return {
          locations: l.data ?? [],
          departments: d.data ?? [],
          positions: p.data ?? [],
          links: k.data ?? [],
          missing: false,
        };
      }
      const [l0, d0, p0] = await Promise.all([
        supabase.from("locations").select("id, name").eq("company_id", cid).order("name"),
        supabase.from("departments").select("id, name").eq("company_id", cid).order("name"),
        supabase.from("positions").select("id, name").eq("company_id", cid).order("name"),
      ]);
      if (l0.error) throw l0.error;
      if (d0.error) throw d0.error;
      if (p0.error) throw p0.error;
      const on = <T extends { id: string; name: string }>(rows: T[] | null) =>
        (rows ?? []).map((r) => ({ id: r.id, name: r.name, is_active: true }));
      return {
        locations: on(l0.data),
        departments: on(d0.data).map((x) => ({ ...x, location_id: null })),
        positions: on(p0.data),
        links: [],
        missing: true,
      };
    },
  });
  return { ...(q.data ?? EMPTY), isLoading: q.isLoading, error: q.error };
}
