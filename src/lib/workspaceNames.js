// What the app CALLS its workspaces on screen.
//
// The CODE says `costs` everywhere and goes on saying it: the route (/costs,
// and /costs/<ItemID>, which a published Xero bill's "Go to CYBills" button
// points at), the stored `kind`, the settings keys, the table-preference keys,
// the file names. Renaming any of those would break links that are already out
// in the world and stored rows that already say `costs`.
//
// The NAME is a different thing, and it was wrong: the people using that tab
// are looking at bills and receipts — that is what they call the pile on the
// desk and what the uploader has always said it takes — while "Costs" is an
// accounting word for what those documents BECOME. Stated once here because
// the name appears on a rail item, a sub-nav heading, a page title, two tab
// rows, a toggle, three buttons in other workspaces and a dozen sentences: typed
// out in each of them, they drift, and a section called two things is a section
// somebody has to be told about.
export const COSTS_LABEL = 'Bills & Receipts';
