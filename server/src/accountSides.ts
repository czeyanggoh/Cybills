// Which part of a Xero chart a document may be coded to, server-side.
//
// Same arrangement as categories.ts: the rule lives in one pure module the
// browser already uses (src/lib/accountSides.js), loaded here by path, so the
// read an emailed document gets offers exactly the accounts the upload's read
// and the Category picker do — expense accounts, plus the asset accounts
// switched on in Lists.

type Account = { code?: string; name?: string; type?: string; systemAccount?: string };

type AccountSides = {
  isExpenseAccount: (a: Account) => boolean;
  isRevenueAccount: (a: Account) => boolean;
  isAssetAccount: (a: Account) => boolean;
  shownAssetKeys: (blob: unknown) => Set<string>;
  accountsForSide: <T extends Account>(accounts: T[], kind?: string, shownAssets?: Set<string>) => T[];
};

let cache: AccountSides | null = null;

export async function loadAccountSides(): Promise<AccountSides> {
  if (cache) return cache;
  // From server/dist (or server/src under tsx) up to the repo root.
  const url = new URL('../../src/lib/accountSides.js', import.meta.url).href;
  cache = (await import(url)) as AccountSides;
  return cache;
}
