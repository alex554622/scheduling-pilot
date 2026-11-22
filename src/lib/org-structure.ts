/**
 * The company's organization structure as Edit Member uses it: locations,
 * departments, positions, and which positions belong to which department.
 * Settings → Organization edits these; the database checks every assignment
 * the same way (20261127120000_org_structure_assignments.sql).
 */

export interface OrgItem {
  id: string;
  name: string;
  is_active: boolean;
}

export interface OrgDepartment extends OrgItem {
  location_id: string | null;
}

export interface DeptPositionLink {
  department_id: string;
  position_id: string;
}

/** Whether a department has its own list of positions. One with none accepts all. */
export function departmentListsPositions(departmentId: string, links: DeptPositionLink[]): boolean {
  return links.some((l) => l.department_id === departmentId);
}

/** Whether a position may be held in a department. Nothing picked always fits. */
export function positionFitsDepartment(
  positionId: string | null | undefined,
  departmentId: string | null | undefined,
  links: DeptPositionLink[],
): boolean {
  if (!positionId || !departmentId) return true;
  if (!departmentListsPositions(departmentId, links)) return true;
  return links.some((l) => l.department_id === departmentId && l.position_id === positionId);
}

/**
 * What a dropdown offers: the active items, plus the one already picked even
 * if it was turned off since, so an old assignment still shows.
 */
export function activeOrCurrent<T extends OrgItem>(items: T[], currentId?: string | null): T[] {
  return items.filter((i) => i.is_active || i.id === currentId);
}

/**
 * The positions the Position dropdown offers for a department: active ones
 * that belong to it, plus the person's current one while it still does.
 */
export function positionsForDepartment<T extends OrgItem>(
  departmentId: string | null | undefined,
  positions: T[],
  links: DeptPositionLink[],
  currentId?: string | null,
): T[] {
  return activeOrCurrent(positions, currentId).filter((p) =>
    positionFitsDepartment(p.id, departmentId, links),
  );
}

/** Rows to add and remove to turn one set of ids into another. */
export function diffIds(before: Iterable<string>, after: Iterable<string>) {
  const was = new Set(before);
  const now = new Set(after);
  return {
    add: [...now].filter((id) => !was.has(id)),
    remove: [...was].filter((id) => !now.has(id)),
  };
}
