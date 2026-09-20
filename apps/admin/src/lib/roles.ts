// Roles carried in the `role` custom claim, set by scripts/set-admin-claim.
// firestore.rules mirrors these: isAdmin() for 'admin', isSupportStaff() for
// either. A support user answers tickets and sees nothing else.
export type StaffRole = 'admin' | 'support'

export function toStaffRole(claim: unknown): StaffRole | null {
  return claim === 'admin' || claim === 'support' ? claim : null
}

// Where each role lands after sign-in, and where it is sent when it opens a
// page it is not allowed to see.
export function homeFor(role: StaffRole): string {
  return role === 'support' ? '/messages' : '/dashboard'
}

export const ROLE_LABEL: Record<StaffRole, string> = {
  admin: 'Admin',
  support: 'Support',
}
