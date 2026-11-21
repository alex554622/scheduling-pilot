import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";

/**
 * Who the signed-in person manages, for narrowing a manager screen's lists.
 *
 * An admin (or a super admin) manages the whole company, so nothing is
 * narrowed. A supervisor manages the people in the departments an admin
 * assigned them, as the database's `managed_employee_ids()` reports.
 *
 * This only tidies the lists. The database is what keeps a supervisor out of
 * everyone else's punches, notes and shifts — see
 * 20261121120000_supervisor_departments.sql.
 */
export function useManagedScope() {
  const { primaryRole, company, user } = useAuth();
  const rules = useAppRules();
  const isSupervisor = primaryRole === "supervisor";

  const idsQ = useQuery({
    queryKey: ["managed-employee-ids", company?.id, user?.id],
    enabled: isSupervisor && !!company?.id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("managed_employee_ids");
      if (error) throw error;
      // A set-returning function comes back as a bare list of values.
      return new Set(((data ?? []) as unknown[]).map(String));
    },
  });

  const deptQ = useQuery({
    queryKey: ["my-supervised-departments", company?.id, user?.id],
    enabled: isSupervisor && !!company?.id && !!user?.id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("supervisor_assignments")
        .select("department_id")
        .eq("supervisor_id", user!.id)
        // Someone can supervise in more than one company; only the selected
        // one counts here.
        .eq("company_id", company!.id);
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.department_id));
    },
  });

  const ids = idsQ.data;
  const departments = deptQ.data;

  /** Whether this viewer manages that person. Admins manage everyone. */
  const manages = useCallback(
    (employeeId: string | null | undefined) => {
      if (!isSupervisor) return true;
      if (!employeeId) return false;
      return !!ids?.has(employeeId);
    },
    [isSupervisor, ids],
  );

  /** Keep only the rows about people this viewer manages. */
  const narrow = useCallback(
    <T>(rows: T[], idOf: (row: T) => string | null | undefined): T[] =>
      isSupervisor ? rows.filter((r) => manages(idOf(r))) : rows,
    [isSupervisor, manages],
  );

  /** Whether this viewer plans for that department. Admins plan for all of them. */
  const managesDepartment = useCallback(
    (departmentId: string | null | undefined) => {
      if (!isSupervisor) return true;
      return !!departmentId && !!departments?.has(departmentId);
    },
    [isSupervisor, departments],
  );

  return useMemo(
    () => ({
      isSupervisor,
      loading: isSupervisor && (idsQ.isLoading || deptQ.isLoading),
      manages,
      narrow,
      managesDepartment,
      /** Supervisors may fix punches and notes (company rule, on unless turned off). */
      canEditTimecards: !isSupervisor || rules.supervisors_edit_timecards,
      /** Supervisors may approve time off and record absences (company rule). */
      canApproveTimeOff: !isSupervisor || rules.supervisors_approve_time_off,
    }),
    [isSupervisor, idsQ.isLoading, deptQ.isLoading, manages, narrow, managesDepartment, rules],
  );
}
