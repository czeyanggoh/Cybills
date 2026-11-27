import { useState } from 'react';
import { useUsers } from '@/lib/userStore';
import { useColleagues } from '@/lib/practiceStore';
import { directManagersFor, defaultApproverId } from '@/lib/managers';

// For each claim about to be sent for approval: who it may go to, and who has
// been picked. `rows` is [{ claim, managers, approverId }].
export function useApprovers(claims) {
  // The roster is one client entity's own employees and leaves practice
  // colleagues out, so resolving a manager from it alone said "no direct
  // manager" for every colleague — claimant and approver both invisible to it.
  // A claim can be for either kind of person, so both lists are searched.
  const users = useUsers();
  const { data: colleagues = [] } = useColleagues();
  const people = [...users, ...colleagues.filter((c) => !users.some((u) => u.id === c.id))];
  const [picked, setPicked] = useState({});

  const rows = claims.map((claim) => {
    const managers = directManagersFor(people, claim.claimFor);
    const chosen = managers.some((m) => m.id === picked[claim.id]) ? picked[claim.id] : '';
    return { claim, managers, approverId: chosen || defaultApproverId(claim, managers) };
  });

  return {
    rows,
    pick: (claimId, managerId) => setPicked((p) => ({ ...p, [claimId]: managerId })),
    reset: () => setPicked({}),
  };
}
