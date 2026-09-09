-- Allow any company_admin in the same company to update pending invitations
-- (e.g. extend expiry or regenerate token) without being the original inviter.
CREATE POLICY "invites_admin_update_any"
ON public.invitations
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'company_admin'::app_role, company_id)
)
WITH CHECK (
  has_role(auth.uid(), 'super_admin'::app_role)
  OR (
    has_role(auth.uid(), 'company_admin'::app_role, company_id)
    AND role <> 'super_admin'::app_role
  )
);