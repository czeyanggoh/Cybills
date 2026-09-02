# CYBills — Claude working notes

## Repo basics

- Vite + React (JS, not TS in `src/`); TypeScript on the server side
  (`server/src/**/*.ts`)
- Tailwind, eslint, components.json (shadcn-style, new-york)
- Subdirs: `src/` (frontend), `server/` (backend), `scripts/`, `deploy/`
- Default branch: `main`
- Remote: `https://github.com/czeyanggoh/Cybills`
- Public host: `cybills.cy-bm.sg`; backend port `3004`
  (cyworkspace=3001, rejs=3003)

## ALWAYS sync with origin before editing

Before making ANY change (Edit / Write) to a file in this repo, run:

```bash
git fetch --quiet
git status -sb
```

Then act based on result:

- **Up to date, clean tree** → proceed.
- **Behind origin (no local commits/changes)** → pull (or re-clone) so you're
  not acting on stale state, then proceed.
- **Local commits ahead of origin** → STOP. Surface them
  (`git log origin/main..HEAD --oneline`) and ask whether to push first.
- **Uncommitted local changes** → STOP. Call them out (`git status` /
  `git diff`) before overwriting.
- **Diverged** → STOP and let the user choose rebase/merge/discard.

## The practice (CYBM) vs. its clients

CYBills is run BY an accounting practice FOR its clients, so there are two
kinds of person on the roster and they are not variations of one another:

- **Client employees** — belong to exactly one organisation (a linked Xero
  tenant), never see another, and carry the role their own admin gave them.
  This is the Users page (`/users`), which is tenant-scoped.
- **Colleagues** — the practice's own team (`/colleagues`). They belong to no
  single entity; they hold **client access** to the entities they work on, and
  are a **Business Admin** inside each one. Practice roles are Owner /
  Practice Admin / Standard; the first two also run the practice itself.

Server side: roster rows carry `practice` / `practiceRole` / `clientAccess` /
`allClients`, and the predicates that read them (`canAccessOrg`,
`effectiveRoleFor`, `canManagePractice`) live in `server/src/users.ts` next to
the rows. `server/src/practice.ts` is the practice-facing surface over them
(`/api/practice/colleagues`, `/api/practice/clients`). Access is enforced in
one place: an `X-Org-Id` guard in `index.ts` rejects any per-entity API call
naming a client the caller can't open, and `GET /api/organisations` returns
only the entities they may open (`?all=1`, practice managers only, returns
every linked entity for the client-access picker).

Env (server/.env): `PRACTICE_NAME`, `PRACTICE_DOMAIN` (only used to recognise
pre-existing rows as practice staff on first run), `PRACTICE_TIMEZONE`.

**A person has one name, and a document has an owner.** `createdBy` on a bill is
who UPLOADED it — always an email, never overwritten. The Document owner (the
Costs "User" column, the drawer's picker, the detail field) is its own field,
`owner`, also always an email, and reassigning it leaves the uploader alone.
They were one field until both write paths started storing a display name in it,
which is how a single colleague came to appear twice in one list — "Cze Yang
Goh" on the documents whose owner had been set, "czeyang.goh" on the rest.
Names are resolved through `GET /api/users/directory` (`peopleForOrg`), which is
deliberately WIDER than the roster `GET /api/users` serves: the roster is a
client entity's own employees, but most of its documents are uploaded by a
practice colleague, who is on no client's roster. `emailForPerson` resolves
either spelling to the one email and refuses to guess an ambiguous name; the
rows written before the split are repaired on the next listing (`backfillOwners`
in `bills.ts`). Covered by `npm test` in `server/`.

**An address is an identity, not a field.** The session resolves by it, every
document a person owns is stored against it, and a claim is made out to it — so
taking it off a row detaches a human being from their own work, and lets the
next person added under that address inherit their seat. Three paths could do
it, and all three are closed: the Edit-details dialog sent `email: ''` whenever
Login access was OFF (which most colleagues are), so saving a NAME or a phone
number wiped it; `applyEditable` now ignores a blank address over an existing
one, whoever sends it; and `/join` used to `Object.assign` the join form over
any row it found, which turned a colleague into a pending employee of whichever
company the form named, under whatever name was typed — it now refuses a
practice row outright and otherwise fills only what is BLANK. Turning login off
says somebody may not SIGN IN; changing an address is its own deliberate act
(Manage -> Change email). `OWNER_EMAILS` is the break-glass, and it now applies
to a row that has LOST its practice membership rather than only to one that
still has it — which was the one case it existed for.

**So one address resolves to one person, on every load.** `normalizeIdentities`
folds live rows sharing an address into one — the practice row wins, the same
preference `memberByEmail` applies — and MERGES rather than discards: a
password, an inbound handle, a mobile and the entity the losing row worked in
all come across (as `clientAccess` for a colleague, `extraAccess` for a client's
employee), so nothing anybody was using is lost. The documents need no repair,
because they are stored against the ADDRESS, which is what both rows agreed on.
It is the same soft `removed: true` the Users page's own delete writes.

**A document moves for free; a CLAIM has to be renamed.** A document is stored
against the ADDRESS, so folding two rows into one moves nothing. A claim is made
out to a NAME — a string, written the day it was raised — so it goes on saying
whatever the roster said then. Not merely cosmetic: the claimant's own address is
resolved back FROM that name (`emailForName`), so a claim naming somebody no
longer on the roster has nowhere to send its approval or rejection.
`canonicalPersonName` reads the trail the fold leaves — the losing row is still
there, soft-removed, carrying the old name and the shared address — and
`claims.ts`'s `load()` repairs stale ones on the next read, the same way document
owners are. A name that resolves to nobody is left exactly as it is rather than
guessed at. Covered by `npm test` in `server/` (`test/identity.test.mts`).

## The document reader: Claude or OpenAI

Uploaded receipts, invoices and Vault documents are read by one of two
interchangeable engines. `server/src/llm.ts` is the whole abstraction: it takes
a file + prompt + JSON schema and returns parsed JSON plus normalised token
counts, so `extract.ts` never branches on provider and a document read by either
comes back in one shape. Notable differences it papers over:

- OpenAI's structured outputs are **strict** — every property of every object
  must be in `required` — so `strictify()` tightens a copy of the schema on the
  way out (Anthropic accepts the looser original).
- A reasoning model (`gpt-5*`, `o*`) spends part of its output budget thinking,
  so the cap is raised and `reasoning.effort` is sent only to those families.
- OpenAI counts cached tokens inside `input_tokens`; they're subtracted back out
  so the 0.1x cache rate isn't charged on top of the full input rate.

Which engine runs is decided per client entity in Business settings ->
Extraction -> **Document reader**, saved in the extraction-settings blob
(`readerProvider`: `'claude'` / `'openai'` / `''` = server default) and sent on
each request. `resolveProvider` has the last word server-side, so a saved choice
whose API key was later removed degrades to a working reader instead of failing
the read. The settings card only offers a provider whose key is present —
`GET /api/auth/status` returns `readerProviders` + `defaultReaderProvider`.

**Line items are their own pass.** `POST /api/costs/extract-lines` reads the
itemised table and nothing else — the general read gave line items three words
of schema description, which is how a "Balance brought forward" row ended up in
the grid as a charge. Its prompt names the rows that are NOT charges, and the
server adds the lines up against the document's own grand total before
returning them: a set that doesn't reconcile is re-read once, told what it got
wrong, and only the better of the two answers is kept. What comes back carries
`reconciled` + `linesTotal` + `grandTotal`, so the caller can say so out loud
rather than pasting rows that don't add up. `npm test` in `server/` runs that
path end to end against a stubbed reader.

**One GST figure becomes per-line GST.** Nearly every SG invoice prints its rows
excluding GST and states it once at the foot ("SUB TOTAL / GST 9% / TOTAL"), so
the rows add up to the SUBTOTAL — and a reader told to make them add up to the
total will load the whole GST onto the last row. The reader is asked for the
summary block (`subTotal` / `taxTotal` / `grandTotal`) and told to leave per-row
tax at 0 unless the document prints it; the server then shares the stated figure
across the rows by net (`apportion` in `store.ts`, largest remainder, so the
parts sum to the whole exactly). Rows printed gross have it taken back out
instead, and a document that breaks tax down per row is left as printed.

Env (server/.env): `ANTHROPIC_API_KEY` + `ANTHROPIC_EXTRACT_MODEL` (default
`claude-sonnet-5`), `OPENAI_API_KEY` + `OPENAI_EXTRACT_MODEL` (default `gpt-5`),
`OPENAI_REASONING_EFFORT` (default `low`), optional `OPENAI_BASE_URL` for an
OpenAI-compatible gateway, and `LLM_PROVIDER` for the deploy-wide default.
Either key alone switches extraction on; both means the toggle appears.

**A bill's own lines can reach Xero.** Line items carry `project` + `project2`
— the org's two Xero tracking categories, per line, editable in the grid and
offered only where the linked org actually has that category. `project` is also
READ per line: `extract-lines` is given the org's project list and asks which
one each row is for, taken from what the row names or from the section heading
above it (one laundry invoice bills Tangs, Vivo City and Four Seasons in three
blocks — every row on the document's single project would throw that away).
`project2` is set by hand. On publish,
`perLineItems` (`xero.ts`) posts those rows as the Xero bill's line items
instead of one summary line, each with its own account code and tracking. It
does so ONLY when the rows are provably the same money as the document: they
add up to its total, and their tax adds up to its tax (a single stated GST
figure is apportioned across the rows by largest remainder, so the parts sum to
the whole exactly). Anything that can't reconcile posts as the single summary
line — a nicer breakdown is never worth changing a published total. Line items
that CONTRADICT the document (they don't add up to its total, or their tax
doesn't add up to its tax) are refused outright, 422, in the dialog and in the
API: a breakdown that disagrees with its own paper is a mistake to fix, not to
post around. Covered by `npm test` in `server/`.

**A read outlives the page that started it.** Reading takes ten to thirty
seconds and a reviewer moves on to the next document rather than watching it, so
a re-read / extract-lines runs as a JOB held at module scope
(`src/lib/extractionJobs.js`), not in the detail page's state. The request was
never cancelled — but everything that KNEW about it died with the page, so the
answer landed on the server while the form still showed the old fields, and the
next keystroke saved those back over it. The job now carries on, the page shows
"Reading…" again whenever it returns to that document, and when the job settles
the page takes the document back from the server rather than trusting what is on
screen. One read per document at a time. A full browser reload still kills it —
that aborts the request itself.

**An emailed document is read with the note it came with.** "recharge this to
CY-Biz" is why somebody emails a receipt in rather than uploading it: the
covering line says what to DO with it. It goes to the reader as the sender's
note (`emailInstruction` in `extract.ts`), after the org's own rules, and is
explicitly pointed at the ACCOUNT DESCRIPTIONS — those are written in the same
words people use when forwarding ("costs incurred on behalf of client, which we
will recharge back to them" is 261), and the accounts guide only ever asked what
was PURCHASED, which a covering instruction is not. It can name a customer,
project or category; it can never override the printed supplier, dates or
amounts. The note is stored on the document (`email`) and sent again on a
RE-READ — read once with it and again without, and the second read quietly
undoes the first.

**A cost can name the client it is recharged to.** `customer` is read like the
category is: an enum of the org's own active Xero customer contacts
(`customerOptionsForOrg`, capped at 300 — a long-lived Xero holds thousands and
the field is not worth that prompt), set only when the document names the client
the cost was incurred for or the covering message says so ("recharge this to
CY-Biz"). A name not on the list is discarded rather than stored: this is the
party who gets invoiced. Never blanks one already set by hand or by a supplier
rule.

**A recharged cost is marked billable in Xero.** Xero calls it a **billable
expense** ("Assign expenses to a customer"); Dext calls it rebillable. It cannot
ride along on the bill: Xero models it as a **LinkedTransaction**, which needs
the `SourceTransactionID` + `SourceLineItemID` of a bill that already exists. So
`publish-bill` posts first, then links each returned line to the customer's
`ContactID` — best-effort like the attachment (the bill is already in the
ledger), but always REPORTED, because a cost meant to be recharged and silently
not marked is money nobody bills for. The document carries `rebillable`, offered
only once it has a customer.

The READER sets it, alongside the customer — same judgement, and Cze asked for
it to be automatic rather than a toggle somebody remembers. Never true without a
customer: the flag says "bill this to that client", so with no client it is an
instruction with no object, and it would publish as a billable expense against
nobody. Enforced in `runExtraction`, and again at publish.

**A note about one document beats a standing rule about every document.** A
supplier rule ("everything from Grab is travel") is a policy; a covering note
("recharge this to CY-Biz") is a person's instruction about THIS receipt, so the
specific one wins for the fields it decided — `overlaySupplierRule` in
`inbound.ts`, mirrored in `readDecisions` for the re-read. The reader says what
it took from the note (`noteFollowed`), which is empty unless it actually took
something, so an emailed document whose message says nothing about coding still
follows the rule. Never the money: a note cannot restate a total, and the tax
code follows the account either way. The Reason field names which of the two was
followed.

## Is this document in the right client's book?

Which entity a document belongs to was decided entirely by **provenance** — who
uploaded it and which entity they had open, which inbound address it was emailed
to, which WhatsApp group it arrived through. Nothing read the paper, and the
reader was told twice not to (`billedTo` was for the PROJECT rule: "IGNORE who
the document is billed TO"). So a United Engineers invoice made out to Dart
Consulting, sitting in Red Alpha's book, looked exactly like a correct one: it
would publish into Red Alpha's ledger, coded against Red Alpha's chart, claiming
Red Alpha's input tax on a supply made to somebody else. The only entity-vs-Xero
check that existed was `tenant_mismatch` in `payments.ts`, which compares the
CALLER's named tenant against the document's own record and can never see this.

The reader now reads the addressee on every road a document arrives by — an
upload, a re-read, and the background reads an emailed or WhatsApp'd document
gets (`readIntoBill`, where the field has to be in `EDITABLE` to be stored at
all: `supplierGstRegNo` sits in the same patch and is silently dropped). It is
`billedTo` plus `billedToRegNo`, the mirror of `supplierGstRegNo`, and and `src/lib/billedTo.js` says what it means (pure,
`npm test` at the root, loaded server-side by `server/src/entityCheck.ts` the way
`taxRateRules.js` and `categoryList.js` are, so the badge on a row and the button
on the page can't disagree). **The registration number decides where there is
one**: it is the only identifier that cannot be a trading name, an abbreviation
or a misread, and it is checked against the entity's own CRN and GST number off
its Business profile. Otherwise the NAME, and the two spellings differ in the
MIDDLE as often as at the end: an entity is listed as "DART Consulting (SGD)" —
a label somebody put on one of its two ledgers — and pays an invoice made out to
"DART CONSULTING AND TRAINING PTE LTD". So neither containment nor a shared word
will do it. What is compared is the words that NAME the company — no legal form,
no ledger label — and the shorter name has to be entirely inside the longer one,
anchored on the first word. Every one of those is load-bearing against a real
client list: "ARC3 Nobel" and "ARCHER NOBEL" share their last word, "CY Business
Management" and "CY-Biz" their first, and "Consulting", "Services" and
"Singapore" are in half the list.

**It is a warning, never a refusal.** An intercompany recharge, a trading name, a
group company paying for its subsidiaries and a landlord billing the tenant a
client sublets from all look exactly like this and are all correct — so the worst
it does is ask, and **This is right** (`entityCheckDismissed`, the same shape and
the same reason `duplicateDismissed` has) settles it for good. Three cases are
never asked about at all: a SALES invoice, which is billed to the customer
because that is what a sales invoice is; a BRIDGE entity, which holds other
people's paperwork by design; and a document naming no customer, which is most
till receipts.

**The verdict is computed, not stored.** It compares two things that both change
— the document's bill-to party and the entity's own registered details — so a
stored answer would go stale the moment somebody fills in the Business profile it
reads. It rides on the listing (once per request, not once per row) so the badge
is on the ROW: a document nobody opens is exactly the one that gets published
into the wrong ledger, and the badge is the only thing that would make anybody
open it. Said again in the publish dialog and in the bulk publish confirmation,
because that is the irreversible half.

**And a misfiled document can be MOVED**, which is the other half of saying so:
without it the only way out is to delete a real cost and ask somebody to upload
it again somewhere else, so the mistake gets left instead.
`POST /api/costs/bills/:id/move-entity` offers only entities the caller can
already open, and only where the paper agrees in a registration number or in two
words of the name — this answer becomes a button that moves a client's paperwork
into another client's book, so a near-miss must produce nothing rather than a
plausible wrong destination.

What travels and what does not is the whole of it. The supplier, the date, the
money, the file, the document number and the owner are facts about the document,
so they come; the CODING does not, because an account code, a tax code and a
tracking option are names in the chart of the entity it has just left, and
carried across they would post the bill to an account of the same number meaning
something else entirely. The duplicate verdict goes too — it pointed at a
document in a book this one has left — and so does the OWNER, because an address
is a person on one entity's roster, not a fact about the paper: most documents
belong to their entity's own **general account**, whose identity is INTERNAL
(`org_….general@cybills.local`) and names the organisation it was minted in. Sent
across as it stood, it resolved to nobody and the destination's owner picker
offered the raw string above the real people, looking like a person somebody had
added. So the owner is re-resolved against the entity it arrives in
(`ownerHere`), and anybody that entity cannot place becomes its own general
account — the row that already owns the paperwork nobody claimed. `createdBy` is
untouched: who UPLOADED a document does not stop being true because it moved. The
same rule repairs the documents moved before it existed, off the listing beside
`backfillOwners`, and only for an INTERNAL address — a real external one is
somebody we simply don't know here, which is the existing rule and not a mistake.
**And it reads itself again on arrival.** It has never been coded against THIS
chart — that is the whole reason the coding was dropped — so leaving it there
hands somebody three empty fields to type in on a document CYBills has already
read once. The read runs against the entity it has arrived in: its accounts, its
categories, its tax rules, its projects and its own supplier rules. Started AFTER
the switch rather than at the moment of the move, because moving reloads the app
into the new entity (every store and request in flight is scoped to the old one)
and a reload aborts a read in progress — so the move leaves a note in
sessionStorage and the document page picks it up, taking it once so a refresh
cannot pay for the same read twice. Not for a document with no file: there is
nothing to read, and the attempt would only report an error on a page nobody
asked to read anything on.

The document lands in the inbox with `movedFrom` on it, which is what the History tab reads to say why its category is
blank. The stored file needs nothing done to it: a bill records the whole storage
key it was written with and every read routes by that key alone.

Four refusals, each a way of accounting for one payment twice: a bill already in
Xero (its money is in THAT ledger), one on an expense claim (it reaches the
ledger as a line of the claim's own bill), one merged away (another document's
money), and one already there. Every one of them is a state the reviewer can undo
first, so the message is the instruction. Covered by `npm test` at the root and
in `server/` (`test/entity-check.test.mts`).

## Merge detection: which uploads are really one document

Two separate uploads are often one cost, and the two ways that happens do not
look alike, so `src/lib/mergeDetect.js` looks for both:

- **Pages of one document** — page 1 (supplier, reference, date) and page 2
  (line items, totals), e.g. a forwarded order confirmation screenshotted in
  halves. SAME supplier.
- **A payment papered twice** — the merchant's itemised receipt and the card
  slip for it. Same total, DIFFERENT suppliers.

The distinction between "pages of one document" and "the same document uploaded
twice" is **complementarity**: pages fill each other's blanks, a re-upload
repeats them. So a page pair needs compatible suppliers, nothing that both
documents state contradicting (total / reference / date / card), at least one
substantive field present on exactly one side, and a positive tie (a shared
reference, a shared total, or the same supplier uploaded in one go) — that last
one is what stops two half-read documents pairing just for being incomplete.

When the reader gets NOTHING off one half (a blank row — no supplier, total,
date or reference), there is no shared fact left to tie it with, so provenance
carries it: arriving in the same upload as the other half. That evidence is much
weaker, so such a pair is **provisional** — offered only where each side has
exactly one candidate. Several blank rows in one upload is genuinely unknowable
and gets nothing rather than a guess; the rows wear a **"Nothing read"** badge
instead, so the reviewer can re-read the document (Cost detail → Re-read) or
pick the two halves by hand.

So three passes, strongest evidence first, and they never chain into each other:
pages tied by a shared fact (these DO chain — a three-page document is one
group), then provisional blank pairs, then a receipt with its card slip. The
last two are forced-choice only, so three documents at one total is left to the
reviewer. Detection runs continuously over the inbox in `Costs.jsx`
(`mergeGroups`), so a row wears a badge instead of the reviewer having to press
a button; nothing is combined until the merge review modal is confirmed.

**The strongest tier merges on its own; the guesses still ask.** The three
passes were always graded and the grade was thrown away in the return, so a
caller could not act on the strong ones without also acting on the weak ones.
`findMergeCandidates` now returns `confidence` — `'firm'` for pass 1 (tied by a
shared reference, a shared total, or the same supplier uploaded together, plus
the pages this app itself cut from one PDF, which are a RECORD rather than
evidence) and `'provisional'` for the other two. Business settings -> Extraction
-> **Merge suggestions** decides what that buys: Automatic combines a firm group
without asking, Review manually keeps every merge behind the modal, Off stops
suggesting at all. Only `kind: 'pages'` and only `'firm'` is ever taken
automatically, one group at a time, and a preview carrying ANY warning is left
alone — the loudest of those is "these look like the same document", where the
right act is to archive the copy, and doing it backwards turns two real costs
into one. Nothing is announced, which is what Automatic means; nothing is lost
either, because the combined document points at its sources and Unmerge puts
them back. A group that fails is attempted once and then left in the toolbar.

**Neither scan is a button any more.** Merge detection already ran on every
change; the whole-book duplicate check now does too — `autoScanDuplicates` in
`bills.ts`, off the listing endpoint, guarded by `bookRevision()` so an
unchanged book costs nothing and honouring Duplicate items = Off. It matters
because a document often becomes a duplicate AFTER it was uploaded (the second
copy arrives later, or an edit makes two rows agree), which the read-time check
can never see and a button only catches when somebody remembers to press it.
The toolbar keeps only the review affordances — "Merge suggestions (N)" and
"Review duplicates (N)", each shown only when there is something to review.
`npm test` at the repo root runs the rules.

**Inbox and Archive are one tab, split by whether Xero has the money.** They
were two tabs over one pile of paper, and the split was never where the work
is: publishing is what archives a document (`markBillPosted`), so a document
somebody archived BY HAND and never published sat behind the tab labelled
"done". The tab is now **Costs**, and a toggle above the toolbar says how much
of it to look at — **Unpublished** (the default) or **All costs**, each carrying
its own count. `isUnpublished` / `inCostsList` (`readiness.js`, pure, tested by
`npm test`) draw the line: unpublished is a document with no Xero bill of its
own, excluding one riding on an EXPENSE CLAIM (its route to the ledger is the
claim's bill) and one MERGED away (the document it was folded into carries its
money). Both are still there under All costs. `rowsFor` keeps `'inbox'` and
`'archive'` because the things that genuinely mean one or the other still ask
for them — merge detection leaves settled documents alone, and the document
page's "next item" walks the inbox.

**But the Costs tab is the WORK, and the settled documents have their own tab.**
Folding the two piles together put archived rows in the working list, which is
what made the first badge say 15 while the three beside it added up to 8 —
Processing 0, To review 0, Ready 8, and seven settled documents sitting in the
list wearing a badge that said they were finished. So Costs is now exactly
`inCostsTab` = processing + inbox, the sum of the three tabs after it, and
**Archived** is where the settled work is looked at. `inCostsList` stays as the
wider reach behind Archived's own scope — Unpublished is the documents archived
by hand and never published, All costs adds the published, the claimed and the
merged.

**Archive is the pile kept just in case, and history is a SCOPE of the working
tab.** A duplicate invoice, a screenshot of a bank screen, the document that is
not a cost but is worth not throwing away — that is what somebody archives by
hand, and it is not the same pile as the documents Xero already has. So the
Unpublished / All costs toggle is drawn on **Costs** as well, and on that tab
All costs is the whole book bar the set-aside pile: the published invoices are
in the list, which is the only way the page can answer "which month of this
subscription is missing?" — toggle, filter the supplier, count the months.
`inCostsAll` (`readiness.js`, pure, `npm test`) is that reach, and the two are
told apart by the money rather than by a new status, since publishing archives a
document too: `isPublished` is `xeroInvoiceId`, `isSetAside` is an archived
document without one, so nothing had to be migrated. A CLAIMED document is in
All costs — a real cost that happened, which only reached the ledger by another
road — and a MERGED-away one is not: merging says two uploads were always one
document, so the combined document is the cost and its sources have ceased to be
documents. Left in, they sat beside the document that replaced them, three rows
at 31.99 for one 31.99 spent, which is the very miscount a supplier filter is
being used to find. They are gone from EVERY list, Archived included —
`rowsFor` drops them whatever key it is asked for — but the rows survive in the
book, because a merge is a judgement about two uploads and a wrong one has to be
undoable: the row is what the combined document points at (`mergedFrom`) and
what Unmerge puts back. Hidden, not deleted. The toggle's counts are per tab (what each scope reaches
HERE, never the whole book), and the tab badge follows the list the way
Archived's always has.

**Coming BACK to a list lands where you left it.** Reviewing is a loop —
narrow the list down, open what you found, come back for the next one — and the
scope, the tab and the narrowing all lived in component state that died with the
page, so "Back" landed on an unfiltered Unpublished every time and the filter had
to be redone per row. Worst exactly where the list is longest.
`useListView` (`src/lib/listView.js`) is useState with the same signature,
remembered in sessionStorage: a stretch of work, not a saved preference, so a new
tab is its own and tomorrow starts clean. Used by Costs and Expense claims for
scope, tab, search and both filter sets. Deliberately not the URL — a claim
page's own Previous/Next walks the list, so history back does not mean "the list"
there. What is restored is trusted only as far as its SHAPE (`restoreView`, pure,
`npm test`): an object is merged OVER the fallback so a field added since has a
value, and anything of the wrong type falls back whole, because a filter object
from an older release would otherwise show an empty list nobody could explain.

**Archive and Unarchive share the row, and each moves only its own half.**
Written across the whole selection they would each do real damage: Archive would
strip `expenseclaim` off a document sitting on a live claim, Unarchive would
knock a Ready inbox document back to New. So each is handed its own id list and
is disabled when the selection holds nothing it can move. Unarchive is
deliberately narrower than the old Archive tab's button — only a plain
`archived` document — because pulling a claimed or merged-away one back into the
inbox would make a second copy of money already accounted for.

**A row that states two of its three figures has stated the third.** Net, Tax
and Total are one row seen three ways, so a stored row carrying a net and an
empty total is not a row with a missing field — it is a row that does not add
up. The grid totals it as nothing ("Out by 33.00" against a document that is
perfectly correct) and the publish path refuses the whole breakdown for failing
to reconcile, falling back to one summary line. `completeLine` /`completeLines`
(`lineItems.js`) fill whichever figure is absent, mirrored in
`normaliseLineItems` (`bills.ts`) so nothing is STORED that way and applied in
`billToDoc` so rows written before it read as what they are worth. A row with
nothing in it at all is left alone — that is an empty row somebody just added,
not a contradiction.

**No Tax means no tax anywhere on the document.** A code that carries no tax and
a line still carrying GST contradict each other, and the publish path refuses a
breakdown that disagrees with its own paper — so a half-applied correction locks
the bill out of Xero rather than merely looking odd. `zeroTaxRate`
(`taxRateRules.js`) says whether a code carries tax — from the org's own rates
where they are to hand, from the names Xero ships for zero-tax codes where they
are not, which is the server's case; `foldTaxIntoCost` (`lineItems.js`) moves
each row's tax into its own net, leaving the row worth exactly what it was
worth. Both are applied wherever a rate is chosen: the capture path, the write
path, the document page's picker, and a repair sweep off the listing for what is
already stored. The TOTAL never moves — only the split — which is what makes it
a repair rather than a revision of somebody's figures, and a published document
is left alone regardless.

**Input tax is claimed only on evidence.** GST is recorded only when the
SUPPLIER quotes a Singapore GST registration number and the document calls the
tax GST. The numbers can't settle it — Thailand's VAT is 7% and Malaysia's SST
8%, exactly Singapore's 2022 and 2023 rates — so the reader extracts
`supplierGstRegNo` + `taxLabel` and `claimableSgGst` decides: a UEN or M-number
(OVR counts) plus a tax the document doesn't call VAT/SST/Sales Tax. Without
that the document codes to No Tax and the tax amount is NOT recorded — it stays
inside the cost, which is what foreign tax is. The total never changes.

**A foreign-currency invoice says what it is worth in SGD, and that is the half
that matters.** A Singapore GST-registered supplier billing in USD has to
restate the supply in SGD on the face of the invoice, because that is the figure
its customer puts in a SGD GST return — Microsoft prints "Total Charges
(excluding VAT) SGD 20.36 / Total GST SGD 1.84 / Total Charges (including GST)
SGD 22.20 / Exchange rate: 1 USD = 1.29300000008314 SGD". Three things ride on
reading that block (`restatement` in `extract.ts`, stored as `baseCurrency` /
`baseTotal` / `baseTax` / `exchangeRate`, kept only when its own halves agree —
a tax inside its total, and a rate that carries the billing total onto the
stated one):

- **It is the proof.** Only a Singapore GST-registered supplier prints it, so
  `claimableSgGst` now takes it as evidence in its own right. It answers the
  very question the registration number and the wording were standing in for:
  the Thai and Malaysian invoices those exist to catch state their tax in baht
  and ringgit, never in SGD. A number the reader missed, or a template that says
  "excluding VAT" one line above "Total GST", no longer costs the client input
  tax it plainly paid.
- **It is the percentage.** The SGD pair is the supplier's exact one; the
  billing-currency pair beside it is that divided by a rate and rounded to two
  places. Foreign currency itself is no longer a reason to decline: a document
  that reached that step already passed the evidence gate, so 9% is ordinary
  input tax whatever it was billed in, and only a rate that is not a Singapore
  rate at all is still coded No Tax for being foreign.
- **It is the rate Xero posts at.** `CurrencyRate` on the bill (`currencyRateFor`
  in `xero.ts`), sent only when the entity's own base currency IS the currency
  the document restated itself in. Without it Xero converts at its XE.com day
  rate, which puts a GST figure in the return that appears nowhere on the
  invoice and that nobody can ever reconcile. **The two rates point opposite
  ways**: the document prints base per foreign (1 USD = 1.2930 SGD), Xero's
  CurrencyRate is foreign per base (1 SGD = 0.7734 USD) and it DIVIDES by it. So
  `exchangeRate` is stored as the paper says it — that is what the page shows
  and what the SGD figures come from — and inverted at that one boundary. Sent
  as printed, a USD 17.17 bill landed in a SGD ledger as 13.28: a
  plausible-looking figure on a live bill, wrong by the square of the rate.
  Which is why the test asserts the ARITHMETIC (divide the posted total, get the
  stated one) and never the bare number — 1.2930 and 0.7734 are twins, and the
  value alone will never tell you they have been swapped.

The document page shows the pair the way Dext does — **Total amount (SGD)**
editable, **Tax amount (SGD)** derived — because the three parts are one fact:
editing the base total re-derives the tax and the rate from the document's own
split, and editing the billing total or tax moves the base pair at the settled
rate. Where the supplier printed nothing, this is where somebody supplies it
rather than letting the ledger pick. `baseTax` is given up wherever `tax` is
(No Tax, not registered, not claimable) — the base TOTAL stays, because the
money is unchanged and only the split moves. Covered by `npm test` at the root
(`test/tax-rate-rules.test.mjs`) and in `server/` (`restatement`,
`publish-bill`).

**A tax code is chosen, or the blank says why.** `src/lib/taxRateRules.js` (pure,
re-exported by `extractionSettings.js`, tested by `npm test`) decides in order:
the ACCOUNT's own default tax code in Xero when the printed GST matches its rate
— what Xero's own UI does, and the only route that can legitimately reach a code
arithmetic must not guess, e.g. an account defaulting to Disallowed Expenses at
9%; then the standard-rated vintage at that percentage; then No Tax for a
foreign-currency document whose rate isn't in the chart. Import GST, reverse
charge and partial exemption all print as a percentage too, so anything else is
left for a human — but only when the rate isn't a standard one at all. A
standard rate always answers: `INPUTY24` IS 9% standard-rated purchases in every
Singapore Xero (7% `INPUT`, 8% `INPUTY23`; `OUTPUT*` on the sales side), so when
an org has written no rule and its visible list can't supply the code — switched
off in Lists, or not loaded — the standard code for the printed rate is used
anyway, named the way that org names it when the unfiltered list can say.
Nothing is silent either way: `taxRateOutcome` returns a `reason`, and a decline
names the rate, what IS visible at it, and points at Business settings → Lists →
Tax rates. A blank field with no explanation is
indistinguishable from a bug, which is exactly how one was reported.

## A workspace an entity doesn't use is not a tab

Most CYBM clients raise their own invoices in Xero and never file a sales
document here, so **Sales** was a whole section of the app — a rail tab, a
Customers list, its own exports, an uploader tab, a "Move to" destination and
four settings rows — pointing at paper that never arrives. It is now the
entity's own answer, `cybills.workspaces.v1` (`src/lib/workspaceSettings.js`,
per entity like the profile it sits under), set in Business settings ->
Business profile -> **Workspaces**. **Off by default**: the practice asked for
the section to be gone, and a client that does send sales documents in switches
it back on.

**Hidden means hidden everywhere, not merely off the rail.** A tab removed with
its routes left open is a bookmark, a browser history entry and a `Move to`
button that all still reach it. So one hook (`useSalesEnabled`) gates the rail
item, the `/sales*` and `/customers` routes, the Add-documents drawer's Sales
tab, the Exports tabs, the Cost page's "Move to", and the settings rows that
only configure Sales (its default tax rate, its due dates, its CSV format) —
a setting for a workspace that isn't there is a control with nothing to apply
to. Nothing is deleted: sales documents stay in the book and in Submission
history, and switching it back on returns the tab with its contents.

**The route waits for the answer; nothing else does.** A blob arrives from the
server a moment after the page mounts, and every other reader is happy with the
default in the meantime — but a route that REDIRECTS on it would throw somebody
off their own Sales page for as long as the fetch takes. `blobStore` therefore
says whether the server has answered at all (`ready()`, settled on a refusal or
an unreachable server too, or the guard waits for ever) — distinct from holding
a value, since an entity that has never saved one settles on the fallback.

## The Costs inbox's bulk actions

Every bulk action is a **button**. The "Move to" and "Actions" dropdowns this
replaced were a menu of things that are each one click on their own, so reaching
them took a second click and a hunt through a list. The row wraps instead.

Beyond archive/claim/merge, the toolbar carries **Bulk edit**
(`BulkEditModal.jsx`), **Rerun processing**, **Publish to Xero**, and **Delete**
(red — it drops the stored file too, and confirms first). One **Export** button
covers both cases: the ticked rows when anything is ticked, otherwise everything
the tab shows.

**A claim's "Add items" uploads onto the claim.** It used to navigate to the
Costs inbox and leave the reviewer to find what they had just uploaded and press
"Add to expense claim" — a round trip through another page to do the thing the
button names. It now opens the same Add-documents drawer, pointed at the claim
(`claim` + `onAdded` on `AddDocumentsDrawer`), and each document is handed back
the moment its read finishes, so lines appear one by one while the rest are
still being read. Two things change while that prop is set, and both follow from
a claimed cost reaching Xero as a LINE OF THE CLAIM'S BILL rather than as a bill
of its own: **auto-publish is skipped** (a published document cannot also be
claimed — it is the one thing the inbox's own "Add to expense claim" refuses),
and only the Costs tab is offered. The claimant is the default document owner,
and is always in the picker: a claim can be made out to somebody the owner list
would not otherwise offer. The claim line is written BEFORE the document's
status, so a failure leaves the document in the inbox rather than marked as
claimed by a claim that never took it — which is invisible in both places.

**Removing an ITEM from a claim archives it; DELETING the claim hands its
documents back to the Costs tab.** Two different acts, and the difference is
deliberate. Taking one line off says "this doesn't belong on this claim", so the
document goes to Archive — kept, out of the way, never back at the top of the
inbox where it reads as new work somebody has to clear again. Losing the whole
claim says the opposite: the work has to be done again, and work to be done lives
in the inbox, so those documents come back READY (readiness is derived, so a
complete one is not presented as something to type in again).

This REVERSES the original decision, which was to delete them permanently, files
included, because they were captured to be claimed and had nothing left to be.
That was wrong about what they ARE: the spending happened whether or not the
claim survived, and the ordinary reason a claim is deleted is that it was raised
WRONGLY — the wrong person, the wrong period, the wrong items — every one of
which ends with those receipts needing to go on a DIFFERENT claim. Throwing away
a client's paperwork over a badly raised claim is not recoverable.

Except where the claim reached XERO: its documents are already accounted for, as
lines of the claim's own bill, so they are ARCHIVED rather than returned. In the
inbox they would look like unpublished work, and publishing them pays the same
spending a second time — the same rule that keeps a merged-away document out of
every list. `returnBillsToInbox` is the writer, beside `unmarkBillsClaimed`
(which stays as it was, for the single-item case). Both confirmations say which
of the three will happen, and the claim itself is still only soft-deleted, so the
record of what was claimed outlives it either way. Covered by `npm test` in
`server/` (`test/claim-delete.test.mts`). Removing an item previously did nothing at all to the document: it
kept `expenseclaim` with no claim to belong to, which made it invisible in the
inbox, in Archive, and to anybody else's claim. `deleteBillsHard` splices the
CACHED list in place — persisting a copy would leave every later read serving
rows that were just deleted, and the next write would put them back.

**A claim's dates are of two kinds, and only one of them was ever a date.** An
end date is TYPED, in whatever shape somebody types it — ISO, DD/MM/YYYY,
DDMMYYYY, "31 Jul 2026" — and `parseDateParts` has always folded those into one
"31 Jul 2026". A decision, a rejection, an activity entry and Xero's settlement
date are STAMPED, by the server, as `new Date().toISOString()`, and matched none
of those shapes — so the Approved column printed
`2026-08-27T02:50:29.683Z` raw in a column of dates. The rules moved to
`src/lib/claimDate.js` (pure, `npm test`, re-exported by `claimStore.js`) and
now read a stamp as an INSTANT: rendered as the reader's own calendar day, since
an approval given at 1:30am in Singapore is stamped 17:30Z the day before and
must not read as yesterday. A bare `2026-08-27` is still split by hand rather
than through `Date`, which reads it as midnight UTC and would render it as the
26th anywhere west of Greenwich. `formatClaimStamp` is the same moment with its
hour kept, for the activity feed — a trail of events where a bare date would say
three things happened on Wednesday without saying which came first.

Mark as paid / not paid and Move to review / ready are NOT there. Paid is a
field, set on the document or across a selection in Bulk edit; readiness is
derived, so a "Move to ready" button could only ever agree with the server or
be overruled by it a moment later.

**Ready and To review are both derived, and between them they are the whole
inbox.** `src/lib/readiness.js` (pure, tested by `npm test`) decides from the
document, never from its stored status: a cost carrying a Supplier, Date,
Category and a Total above 0 is Ready; every other inbox document is waiting on
a person — most often for the account code the reader could not choose. To
review used to be a STATUS only the toolbar could write, so a document needing
attention landed there only if somebody had already noticed it and pressed the
button. Rows in To review wear a **"Needs: …"** badge naming the missing fields
(`missingFields`), except where "Nothing read" already says it better.

**And a document being READ says so, on every road.** An emailed or WhatsApp'd
document was created as `new` and read in the background, so for the ten to
thirty seconds the read takes it sat in the inbox wearing "New" and a **Nothing
read** badge — which is precisely what a document the reader could get nothing
off looks like once it has FINISHED. The reviewer had no way to tell "wait" from
"this one needs typing in". Both filing paths now create it as `processing`, and
`autoRead` clears that in a `finally` (`settleProcessing` in `store.ts`) so no
exit can skip it — a reader that is switched off returns at the first line, and a
document saying "Processing" for ever is worse than one never marked at all.
Deliberately NOT folded into `reconcileReadiness`, which must not demote
`processing`: the browser sets that status on its own upload and clears it
itself, so a PATCH arriving mid-read would end the state early.
`sweepStuckProcessing` stays the backstop for the process dying mid-read, not
for an ordinary return. Covered by `npm test` in `server/`.

Two rules run through all of them:

- **A tick is what makes a field part of a bulk edit.** An untouched field is not
  sent, so "code these forty receipts to Entertainment" can't also blank forty
  different suppliers. Ticking a field and leaving it empty clears it on purpose.
- **A document already published to Xero is left alone**, and the result says how
  many were skipped. Its figures are in the ledger; editing the copy here would
  only make the two disagree.

Changing a field never sets a status: the server re-derives ready vs inbox from
completeness (`reconcileReadiness`), so bulk-coding a category moves those
documents to Ready by itself. A bulk tax-rate change computes each document's tax
from its OWN total, the same sum the inline Tax rate cell does.

**Rerun processing reads the documents again**, and the precedence it applies is
decided in one place: `src/lib/reRead.js` (`readDecisions`) — supplier rule, then
the document's own printed due date, then this read, then what the document
already carried (a PERSON's tax code, existing line items are never clobbered).
The document page's single re-read and the inbox's bulk one both call it, so they
can't drift. It exists because a first read can come back with
nothing — a dark photo, a PDF that is really a scan — leaving the document in the
inbox as "Unknown supplier / 0.00" with no way forward but typing it in; it is
also how a supplier rule written AFTER the upload reaches the documents it was
written for.

**A re-read may revise the code CYBills itself chose — only a person's is
kept.** It used to protect ANY existing tax rate, which made a re-read unable to
do the very thing it is usually pressed for: the document kept the answer
somebody was trying to change, and kept it silently, because the reason is
written in the same breath and so was held back too. The two can be told apart
now, because a person's decision is recorded as one — `taxRateEdited` for a code
they picked, `taxRateCleared` for the blank they chose on purpose — by the
document page, the inline cell and Bulk edit alike. Neither flag had ever
reached the server: `PATCH /api/costs/bills/:id` took only strings, so
`taxRateCleared` was dropped on every write and the listing's backfill and the
supplier rules were guarding on a flag that could never be set. A document
written before the markers existed carries neither, which is exactly the
population a re-read needs to re-decide.

**And a blank Reason is a bug wherever it appears.** Two paths through
`taxRateOutcome` still returned one: a code the reader picked from the org's own
rule, and — the one that matters — "no tax charged", which is where a document
whose tax the reader never FOUND ends up. Coded No Tax with nothing said, that
is indistinguishable from a document that was judged and declined; "No tax is
shown on this document — a total of 22.20 with nothing recorded as tax" is the
sentence that sends the reviewer to the Tax amount field. Only two silences
remain, both deliberate: an entity that isn't GST-registered (the screens say so
themselves) and a code an org's own written rule matched, where the reader's
reason is preferred and this is merely the floor under it.

A read that comes back with neither a supplier nor a total is
reported as such rather than counted as a success: twice blank is the FILE's
fault, and running it a third time won't help. The run goes one document at a
time — each read is a model call billed to that client entity.

Publishing in bulk is as conservative as the automatic publish: it skips rather
than guesses (already published, on an expense claim, incomplete, or a category
that isn't in the org's chart), asks first because it writes to a live ledger,
and the server enforces the same gates again.

**A bill is published as Approved, because that is the state it has to reach.**
Xero will not take a payment against a DRAFT or SUBMITTED bill, so a book of
drafts is a second queue somebody works through in Xero after working through
this one. `publishStatus` (Business settings -> Extraction -> **Publishing**)
is the entity's answer, and all three places a PERSON presses Publish read it —
the document page's dialog opens on it, and the inbox's bulk publish and a
claim's send it — so pressing Publish in two places cannot put two different
statuses in one ledger. The automatic publish-after-reading is deliberately NOT
covered: nobody looked at that document, so it posts as SUBMITTED into an
approval queue rather than straight into the payable ledger.

## What a Costs export is a file OF

CSV, PDF and ZIP are three different things over the same selection, and only
the first describes rows. The PDF is the DOCUMENTS — one page per receipt image,
a multi-page PDF receipt keeping its own pages — and the ZIP is those files
individually, so a row entered by hand has nothing to contribute to either and
simply isn't there. The dialog says so before it runs: how many of the selection
have a stored file, and, where none does, that there is nothing for the PDF to
contain (Export is refused rather than handing over one page saying so). It stays
open afterwards ONLY when the result fell short of that promise — a stored file
that would not fetch or would not parse — since repeating a shortfall already
named would read as a second, new problem. `exportDocs` returns
`{ filename, added, total }` for exactly that.

**The file is named for the ENTITY and dated**, `red-alpha-cybersecurity-st-eng-
2026-08-31.csv`, which is how Dext names it and how the claim exports name
theirs (one rule, `docsExportName` beside them in `exportFormat.js`). It is read
outside the app — in Excel, in somebody's mail — where `cybills-costs-…` says
nothing about whose costs these are, and two entities exported on one day
produced two files with one name.

**The "(SGD)" pair is the entity's OWN currency**, not the billing amount under
another heading. Dext prints both pairs because for a USD invoice they differ,
and the second is what reaches the ledger and the GST return. So the columns
carry the document's own restatement (`baseTotal` / `baseTax` — see the
foreign-currency notes above) when it has one, the billing figures when the
document IS in the entity's currency, and BLANK when neither: CYBills holds no
exchange rate of its own, so there is nothing true to put there, and the
Currency column beside it says what the amount actually is. The heading takes
the entity's own code, so a non-SGD entity is not labelled SGD. Same rule for
Custom CSV's "Base net/total amount", which had the same fault.

## Links that leave the app

An exported CSV's Image column, and the Item IDs in a claim PDF, are opened
OUTSIDE CYBills — by an accountant with the file in Excel, by an approver who
was emailed the claim. They used to be the bare file URL, which only worked
because `/api/costs/bills/:id/file` skipped the session guard on the reasoning
that a bill id is an unguessable capability token. An Item ID is a TIMESTAMP
(`260826113257`), so it isn't: a day of one client's receipts could be
enumerated by counting.

So the capability is explicit now. `server/src/shareLinks.ts` signs a token that
names one document and expires (30 days); `POST /api/costs/share-links` mints
them a batch at a time, and only for documents the caller can already read.
Whether they're minted at all is the entity's own decision — Business settings
-> Exports -> **Image sharing**, Dext's toggle, on by default — and that
decision is read again on every request, so switching it off revokes the links
already sitting in somebody's spreadsheet. Without a signed link the CSV's Image
column is blank and a claim PDF's Item ID points at the document page instead.
Covered by `npm test` in `server/`.

**A published bill can be corrected.** A mistake found after publishing used to
have nowhere to go: the document could be fixed here and the ledger kept the
first answer, leaving the two to disagree quietly — the exact thing publishing
from here exists to prevent. **Update in Xero** (document page, beside Open in
Xero) sends the document's CURRENT figures to the bill it already created:
`POST /api/xero/organisations/:id/update-bill`, which is Xero's update (POST
with `InvoiceID`) rather than the create-only PUT, so it restates that bill
instead of adding a second one for somebody to find and void later.

Both routes assemble the invoice through ONE builder (`buildBillInvoice`), so a
correction is built exactly as the original was — two copies would drift, and
the drift would silently restate a figure in a live ledger. It holds the same
completeness bar as publish (a document that has since LOST its category can't
blank it in Xero), refuses a document with no bill to update, and sends a
`Status` only when the reviewer picks one — correcting an approved bill's coding
must not knock it back to Draft and out of somebody's approval queue. What may
still change is Xero's call: a PAID or VOIDED bill refuses, and its refusal is
passed through in its own words. The reply names the bill's state, so the
document's Xero fields are refreshed from it rather than waiting for a webhook.
Covered by `npm test` in `server/`.

**And the paperwork links forward.** A claim's "Published to Xero" chip was a
dead label: it stated that a bill EXISTS and left somebody to go and find it,
while the cost page beside it had carried "Open in Xero" all along. It is the
same chip with the same wording — the status stays the label, because
"Reimbursed 25 Aug" is what the claimant is waiting to read — wrapped in a link
to `xeroBillUrl(claim.xeroInvoiceId)` with the arrow that says it opens
elsewhere.

**A published bill links back.** Xero renders an invoice's `Url` as a
**"Go to CYBills"** button — the way a Dext-published bill carries "Go to Dext".
A document's bill points at `/costs/<ItemID>`, a claim's at
`/expense-claims/<id>`, so somebody reviewing the ledger opens the paperwork it
came from instead of hunting for it. Set in `publish-bill` and `publish-claim`
(`server/src/xero.ts`), from `appOrigin(req)` so it names the host the user is
actually on. The link carries **`?org=<id>`**: the app opens whichever entity
that browser last had, so a claim living in a bridge entity was looked for in
CYBM and reported missing. `adoptOrgFromUrl` (`src/lib/organisations.js`)
switches to it and reloads once with the parameter stripped — a reload rather
than a re-render, because every store and request in flight is scoped to the old
entity.

## One mail domain, many clients

Every client entity collects bills through the SAME domain — one Cloudflare
catch-all, one Worker, one inbound endpoint — so a handle is unique across the
whole deployment rather than inside an entity. The first Martin took `martin`
and Red Alpha's Martin was handed `martin2`, which is an address nobody can be
told over the phone without explaining it.

**So an entity has a short form**, `emailSuffix` on the organisation record, set
in Business settings -> Extraction -> Extract by Email: its people become
`martin.redalpha@cybills.sg`. Handles then only have to be unique as ADDRESSES,
which is the thing that actually must not collide — `ensureEmailHandles` and the
roster's own check (`addressClash`) both measure the whole local part, so a name
already spent in another client's roster is free again here.

**Setting one ADDS an address, it does not swap one.** `userByEmailHandle`
answers to the full address first and to the bare handle second, so a forwarding
rule written before the short form existed keeps arriving. Where two entities
both have a `martin` the bare form resolves to whichever of them has no suffix —
the person whose address IS the bare one — and to NOBODY when neither does: the
delivery 404s and is reported, which is the only honest answer when the address
cannot say which of them was meant.

**Two entities may not share a short form**, and a short form that would hand
somebody an address another person already answers to is refused by name
(`PUT /api/organisations/:id/email-suffix`, `suffix_taken` / `address_taken`).
It is a route rather than a settings blob because that is the only place both
checks can be made. The entity's own Business Admin sets it — it is this
entity's name in an address, and the people who have to be told the address work
here.

**The short form standing ALONE is the entity's own address.** `dart@cybills.sg`
— where a person's handle would normally be — is the company's address rather
than anybody's: the one to put on a supplier's file, or to point a shared
mailbox at, where naming an employee is wrong the day they leave. It resolves to
the entity's GENERAL account (`generalUserByEmailSuffix`), the row that already
owns the paperwork nobody claimed, so a bill arriving there is attributed
exactly as one a colleague adds without naming an owner. A PERSON resolves
first, always, so nobody's mail moves.

One address must not mean two things, and the collision is silent in the
direction that matters — a person wins the lookup, so the ENTITY would simply
stop receiving, with nothing on either page to say why. All three roads are
closed: `addressClash` refuses a hand-typed handle equal to a live short form,
`ensureEmailHandles` seeds its taken set with them (nobody chooses an
auto-assigned handle — it is made from a name), and `PUT /email-suffix` refuses
a short form somebody's bare handle already answers to. Only an entity with NO
short form can collide at all: inside one that has a suffix every person's
address carries the dot that separates the two halves.

The practice's own entity has one too, and it is the case that needed saying out
loud: a colleague opening CYBM is redirected off the Users page to Colleagues,
so the General row is there in the data and unreachable in the UI. Colleagues
prints the address instead.

**The address is offered where the OWNER is picked**, not only in Business
settings. Emailing a bill in and uploading it are the same act by two roads, and
which road it takes must not change who it files under — so the Add-documents
drawer prints an **Extract by Email** block under the uploader carrying the
SELECTED owner's own address, and it moves when the picker does. That is a fact
no settings page can show, since the address depends on the owner. It comes from
the server (`address` on `GET /api/users/directory`, `addressForOwnerName` in
`userStore.js`), never assembled in the browser, so the address a page offers is
the one that actually files under that person; the general account's is the
entity's own. Not on a claim: a bill emailed in lands in the Costs inbox, not on
the claim the drawer is pointed at.

The rules live in `server/src/users.ts` next to the rows they read
(`normaliseSuffix`, `localPart`, `addressForUser`), mirrored for the browser in
`src/lib/inboundAddress.js` so the address a page previews is the address that
gets saved. Covered by `npm test` at the root and in `server/`.

## Bill collection over WhatsApp (with CYWorkspace)

The people who hold a client's invoices are not the people who log into CYBills,
and asking them to is how a month of receipts ends up in a shoebox. So each
client entity can have a **WhatsApp group**: they send photos and PDFs into it,
CYWorkspace runs the number (CYBot, on its own WAHA server) and classifies every
attachment, and the SUPPLIER BILLS among them are handed to CYBills. Receipts,
sales invoices, bank statements and holiday photos are classified and left
alone. `server/src/whatsapp.ts` is both ends of that pipe; `deploy/WHATSAPP.md`
is the contract, and the page an operator is handed.

**A group is a real group.** Creating one puts real phone numbers into a real
WhatsApp group in front of a client, so exactly one thing in the app can do it —
Business settings -> Connections -> **Set up the group** — never a page load, a
save, or a retry loop. The submission id (`CYB-<orgId>-<hex>`) is written to disk
BEFORE the call goes out, because the failure that matters is not "the call
failed" but "the call succeeded and the answer was lost": CYWS is idempotent on
that id, so pressing the button again adopts the group it may already have made.
A fresh id would have made a second one, in front of the client, with nothing to
say which was real.

**A group belongs to a PERSON.** The ordinary way to open one is their own page
(Users / Colleagues -> Edit details -> **Connect to WhatsApp**): one group, one
person in it, named with their own CYBills address (`astrid4@cybills.sg`) — the
same pipe under a second name, since a bill emailed to that address and one sent
into that group are filed under exactly the same person. The number typed there
IS the connection: it opens the group AND it is what a bill arriving from that
number is matched back to, so it is saved as part of connecting rather than
waiting on Save — unstored, everything they send lands on the entity's General
account. A colleague's group is filed under their own organisation, else the
practice's primary one: the same rule an emailed document of theirs follows. The
entity-wide group under Connections is the same thing with more people in it.

**The number and the group are two different things.** Saving a new number
changes who a bill is MATCHED to from then on; it cannot change the group,
because WhatsApp has no way to swap a number inside one. Said as a bare warning
with no action — which is what it was, since the Connect button hides once a
group is open — it read as the number failing to save, and was reported as one.
So the card says what Save does, prints the number the group was opened with
beside it, and the group gets buttons of its own.

**WhatsApp cannot swap a number inside a group, but it can hold both.** So
**Add this number to the group** leads (`POST /api/whatsapp/channels/:id/
participants`, CYWS's `add-participants`): same group, same submission id, same
thread, one more person in it. **Open a new group with this number**
(`replace: true`, the only way a second group is ever made) is the fallback, for
when the group is pointed at the wrong person altogether — a second group is a
second conversation in front of a client with the paperwork split across the
two, which is what the additive answer exists to avoid. The old channel is then
marked `replaced`, never deleted — CYWS still files that group's messages under
its submission id, and they have to keep arriving until somebody deletes the
group at the WhatsApp end. A replaced channel is also never RESUMED, or its
submission id would hand back the very group being replaced.

Adding STORES the number as that person's, exactly as connecting does and for
the same reason (unstored, everything they send lands on the General account),
and it records it in `participantsRequested` — which is what makes the mismatch
warning, and the buttons with it, go away. What WhatsApp acknowledged is kept
separately, so an empty `participants_added` (its silent refusal for somebody
whose privacy settings disallow being added) is reported as a shortfall rather
than as either an error or a success. The two groups it refuses to touch are the
rename's two: an ADOPTED conversation is the client's own, and a CLOSED one is
over. Covered by `npm test` in `server/`
(`test/whatsapp-add-participant.test.mts`).

**A group that already exists is NAMED, not made.** Every button above creates a
real group, which is wrong for a client who has been sending bills into one of
their own for months: it puts a second, empty group in front of them and leaves
the one with the paperwork filed under nobody. The pipe could already adopt
(CYWS answers `already_existed` for an id it holds, and `createChannel` keeps
that group) but nothing could ask, because the id is minted inside the same call
that makes the group. `POST /api/whatsapp/channels/attach` is the missing half —
inbound key, no session, no mobile, nothing opened in WhatsApp: it mints the id
against a chat CYWS already has, and CYWS stamps it on that chat. `/directory`
carries a `people` list so CYWS can offer the roster. Contract:
`deploy/WHATSAPP.md`.

**A closed group leaves the tab, and the conversation does not.** The WhatsApp
tab is for the groups bills still arrive through, so `GET /api/whatsapp/threads`
now drops a collection that is `replaced`, `disconnected` or `deleted` — with
`?all=1` and a **Collecting / All groups** toggle carrying both counts, the same
shape the Costs tab's Unpublished / All costs has. Nothing is thrown away: the
conversation is the record of what was said and closing a group does not unsay
it, so the rows are still there under All groups wearing their state, and a
thread always opens by id. The close control is on the thread page too — the
list is where clutter is noticed, but the group's own page is where there is
enough on screen to decide.

**A retired collection is listed, never offered.** `/directory` hands CYWS every
channel CYBills has ever recorded, because a collection filing to nobody is
exactly what an operator needs to see — but a chat pointed at one fails
SILENTLY: documents post to a submission id nothing reads, and the WhatsApp tab
hides those channels, so it is indistinguishable from nothing arriving. Rows
accumulate for good reasons and are never deleted (a `replaced` group still has
CYWS filing its messages until somebody deletes it at the WhatsApp end; a
`pending`/`failed` one owns the id a retry reuses; a closed one owns its own
history), so one person legitimately shows several — which is how three
`czeyanggoh` entries came to sit in one dropdown. Each row now carries
**`assignable`** (`status === 'open'`), said by CYBills rather than derived at
the far end, because what a status MEANS is CYBills' to know;
`set_chat_cybills_submission` refuses a dead one (`submission_not_collecting`)
and the picker leaves them out altogether, the chat's own assignment included —
the notice above the select already names that collection and says it has
stopped collecting, so keeping the row only put a dead option in a list of
destinations looking as pickable as the live ones. Nor is a collection that
already belongs to ANOTHER group a destination (`chat_id` on each row,
`submission_belongs_to_another_chat`): a submission id is the collection, so
pointing a second chat at one folds two conversations into one row and one
thread rather than giving the chat a collection. Since a collection is bound to
a group the moment it opens or is attached, a chat with none has none to share,
and the right action is always the person list — which mints one against THAT
chat. Names differ between a
person's rows because only a live, non-adopted group is renamed when their
address moves — `czeyanggoh@cybills.sg` and `czeyanggoh.cybm@cybills.sg` are the
same person before and after the entity got its short form.

**One GROUP one person, but a person may have several.** Attaching used to
refuse somebody who already collected through a group (`already_connected`), so
that a second id could not split their bills across two collections. That is
right about OPENING a group and wrong about adopting one: the conversation
already exists and bills are already going into it, so refusing prevents no
split — it forces an ALIAS, because the operator's only remaining way to point
the chat at that person is to hand it their existing group's submission id. And
two chats on one id is strictly worse than two ids, because a submission id IS
the collection here: CYBills cannot tell them apart at all, and both fold into
one row and one thread. Which is how a bridge chat came to appear as somebody's
personal group, with CYWS itself printing the warning nobody could act on.

Nothing actually splits: every channel names the same `userId`, so the documents
file under the same person into the same book. What stays apart is the THREAD
and its counts, which is what they are for. `chat_in_use` survives untouched —
it is about a group, not a person, and two channels on one chat id really would
file one bill into two people's books. The card on a person's page shows the
group CYBot OPENED (the only one opened with a number, so the only one a changed
number can have drifted from) and lists the adopted ones beside it; **Open a new
group with this number** only ever retires a group of our making, since marking
an adopted conversation replaced would quietly stop collecting from a chat the
client is still using. Covered by `npm test` in `server/`
(`test/whatsapp-attach.test.mts`).

**WhatsApp not adding somebody is not an error, and not silence either** — but
what it will say is usually only a count. `participants_added` comes back as
**LIDs** (`217630539546875`), the opaque per-user ids WhatsApp uses so a group
doesn't leak everyone's number, so measured against the numbers we asked with,
every person who WAS added looks like a stranger: that is how somebody sitting in
the group on her own phone was reported as having refused to join it. A name is
claimed only where a returned id really is a number we sent; otherwise the
shortfall is reported as a number, and the LIDs are never printed — two 15-digit
ids under "In the group" say nothing about whose they are. There is no invite
link to offer either (CYWS mints none), so the instruction is the one that can
actually be followed: somebody already in the group adds them.

**The bytes never move.** Both systems hold the same R2 bucket, so CYWS passes
the object KEY and the document stores a reference to it — `shared:` in
`storage.ts`, which reads exactly like one of ours and is NEVER deleted:
that object is also CYWS's own record of the message. The signed `file_url` is
the fallback for a deploy with no R2 credentials, and is only followed when it
points at CYWS itself — whoever holds the inbound key could otherwise hand the
server any URL at all.

**A caption is a covering note.** "recharge this to CY-Biz" typed with the file
is the same KIND of thing as the line somebody writes when they forward a
receipt by email, so it goes through the same machinery: `coveringNote()`
(`src/lib/coveringNote.js`) reads either envelope into one shape, the reader is
told which road it came in on (`emailInstruction`'s `via`), and it beats a
standing supplier rule for the fields it decides — never for the money. It is
kept on the document, so a RE-READ sees it too.

**A group's name follows the address, because they are one pipe.** A group is
named after the person's own CYBills address — send a bill to
`gcy.cybm@cybills.sg` or into the group called `gcy.cybm@cybills.sg` and it
files under exactly the same person — but the name was a SNAPSHOT, written when
the group was created and never touched again. So changing a handle, or giving
an entity a short form, left the group standing under the address its owner used
to have: the card read `czeyanggoh.cybm@cybills.sg` directly beneath an
Extract-by-email field reading `gcy.cybm`, with nothing to say they were the same
thing. Both routes that MOVE an address now take the group with it —
`renameChannelsForUser` (`waRename.ts`) off the handle change in `users.ts` and
the short form in `organisations.ts`, computing the name through the one
`groupSubjectFor` the group was opened with, so the two cannot drift. CYWS does
the renaming (`POST /api/webhooks/cybills/rename-group`, `deploy/WHATSAPP.md`);
CYBills decides WHICH groups may be renamed, and never an ADOPTED one — that
conversation is the client's, and renaming it from an accounting app is the same
species of act as taking it apart — nor a closed one. Best-effort like the
reaction: nobody waits on it, and the row records only what WhatsApp actually
took, so a refusal is retried by the next address change rather than leaving the
two silently disagreeing. Nothing about filing rides on it — a channel names its
`userId`, never its subject. A group opened BEFORE any of this is repaired on the
next read of the channels listing, the way document owners and stale claim
names are: the Edit dialog only sends a handle that CHANGED, so re-saving the
right one would ask for nothing at all. The channel rows moved to `waChannels.ts` to make
that possible, a leaf like `waThread.ts`, so the rename reads them without
importing the router that imports `users.ts`. Covered by `npm test` in `server/`
(`test/whatsapp-rename.test.mts`).

**A receipt sent into a group is answered in that group.** The sender gets no
receipt of their own — the message sits there looking exactly like one nobody
picked up, so the next thing they do is send it again, or ask. So CYBills reacts
on their own message: **☑️ grey** once it has read the document, **✅ green**
once Xero says the bill was paid. WhatsApp keeps ONE reaction per account per
message, so the green REPLACES the grey rather than sitting beside it — the tick
they are already looking at changes as the document moves, and nobody has to
type into a client's chat. CYBills holds no WhatsApp session, so it asks CYWS
(`POST /api/webhooks/cybills/react`), naming the message by SUBMISSION ID rather
than chat id: the shared key opens every chat on that number, and the group is
resolved at CYWS's end from its own record.

Which tick is decided from the DOCUMENT — `reactionFor` in `waReactions.ts` —
never from which caller reached it, and that is the whole safety of it. Xero's
"paid" arrives by three routes (the invoice webhook, the payments sweep, the
reply to an Update in Xero) and between them they produce exactly one reaction;
a re-read pressed AFTER the bill was paid cannot knock green back to grey, which
would tell the sender their paid bill had come undone. A read that came back
with neither a supplier nor a total is left BARE deliberately — the file was
unreadable, and ticking it would say the receipt is in hand when what it needs
is to be sent again. `whatsappReaction` on the document records only what
actually reached WhatsApp, so a refusal retries on the next thing to happen to
it; nothing is ever cleared, because taking a tick off says something happened
to the document and nothing here ever means that. Sending is best-effort
throughout: filing is never held up by it, and an older CYWS answers 404 into
the log. Covered by `npm test` in `server/` (`test/whatsapp-reaction.test.mts`).
The mirror's storage lives in `waThread.ts` and the reaction in
`waReactions.ts`, both leaves — kept in `whatsapp.ts` the reaction had to reach
back into the router module, and through it into the Xero routes that trigger
one.

**Closing a group is two acts, and both are offered on every group.** **Stop
collecting here** leaves it standing in WhatsApp with everyone in it and simply
stops taking anything from it; **Delete the group** has CYBot remove everyone
and leave. Which one is right depends on something only the person pressing
knows — a group CYBot opened for a colleague is usually finished with, while a
client's own conversation that was merely POINTED at CYBills (`adopted`, set by
`/channels/attach`) is theirs, and taking it apart from an accounting app would
destroy something that was never ours. So the panel SAYS which kind it is rather
than deciding.

`POST /api/whatsapp/channels/:id/close` (`{deleteGroup}`) asks CYWS's
`/api/webhooks/cybills/delete-group`, where the ORDER is the whole of it:
members first, CYBot last, because leaving is irreversible from our side — once
out it is no longer an admin — so a failure to remove somebody aborts BEFORE the
leave rather than walking out of a group named after a client's bills with the
client still in it. A refusal leaves the collection **open** and passes CYWS's
own words back: a group somebody believes is gone, still sitting in front of a
client, is the failure that matters. Neither act touches the documents already
collected (accounting records, they belong to the book) or the mirrored thread
(the record of what was said), and the channel row survives carrying
`disconnected` or `deleted` — all three reference its submission id. A closed
collection then refuses deliveries HERE, 409 `channel_closed`, logged: that is
CYBills' decision and it must hold even if the call telling CYWS to stop never
landed. It is NOT a delete for everyone — WhatsApp has none — so the group stays
in the ex-members' chat lists showing they were removed, which the panel says
out loud because it is the half people assume works. Covered by `npm test` in
`server/` (`test/whatsapp-close.test.mts`).

**The Connections card lists EVERY group the entity collects through**, its
people's own included. Showing only the entity-wide one had it report "0 bills"
beside a group nobody was using, while the group three bills had just arrived
through was not on the page at all. The status beside the heading is a status,
not a button: WhatsApp has no link that opens a group by its id and CYWS mints
no invite link, so there is nothing there to click and it no longer looks as
though there is.

**The whole conversation is mirrored, not only the bills.** CYWS posts every
message in a collection group to `POST /api/whatsapp/message` (same inbound key,
allowlisted past the session guard), text included, and the **WhatsApp** tab in
the left rail is where they are read: groups for the entity, an unfiled count,
and the thread. It exists because Costs can only ever show what the classifier
picked OUT — so a receipt it read as a holiday photo appeared nowhere, and "I
sent that last week" had no answer here.

Three rules hold it together. Messages are **upserted on `wa_message_id`**,
because CYWS sends each one twice by design — once on arrival so the thread is
live, once more when its classifier has decided what an attachment is. A
category **set in CYBills is marked `manual` and never overwritten** by a later
re-send; the model guessed from a photo, the reviewer opened the document, and a
correction that gets quietly reverted is worse than no correction. And **the classification is what
files it**: `supplier_bill` or `receipt` becomes a cost document on the send
that carries that verdict, everything else stays in the thread until a person
says otherwise. That is why it is ONE post per message — CYWS briefly also
called `/invoice` for those two, which posted the same bill twice, filed by one
call and shown as unfiled by the other with a button that would have made a
second copy. Auto-filing, `/invoice` and the tab's **Add to Costs** all go
through the one `fileWhatsappDocument` builder and share the `message_id`
ledger, so a document is identical however it got there and can only be filed
once. Its collection is `whatsapp-thread` — deliberately NOT
`whatsapp-messages`, which is the delivery dedup ledger. Covered by `npm test`.

This REPLACED a first version of the tab that derived the conversation from the
documents that had been filed (`GET /api/whatsapp/chats`, `WhatsappChats.jsx`),
which could only ever show the classifier's picks and said so at the top. The
mirror is what that page was waiting for, so the endpoint and page are gone. Its
access rule was kept, though, and widened in scope rather than relaxed: the tab
shows everybody's documents AND everybody's messages in the entity, so it stays
**Business Admin** — the same bar as the Costs inbox it sits beside — on the
route and in the rail.

**The pipe can be tested without CYWS.** Extraction -> Extract by WhatsApp ->
**Send a test bill** posts one document to CYBills's OWN public endpoint — real
URL, real key, real group — so everything from the network in is exercised:
reachability, the key, the group lookup, the shared bucket, filing, the read. It
splits "nothing turned up" in half, which is the only question worth answering
first. Needs R2, and says so plainly when there is no bucket rather than failing
later as `file_unavailable`.

**Every call to the endpoint is recorded, refusals included.** "I sent a bill and
nothing turned up" has two answers — CYWS never called, or it called and was
turned away — and they need different people to fix them, so the app has to be
able to tell them apart instead of guessing. The last 50 attempts (Extraction ->
Extract by WhatsApp -> **What has arrived**, practice team only) name the outcome
of each: filed, already had it, wrong key, unknown group, file unreadable. An
EMPTY log is itself the answer — CYWS has not called at all, which is either the
handback never done or its classifier deciding the attachment was not a supplier
bill. The key is never written down; only that one did not match.

**Deduped on `message_id`, and answered before it is read.** CYWS does not retry
on its own — an operator re-tags a message — so a repeat is answered 2xx with the
document that already exists; a non-2xx would leave it undelivered and invite a
third send. The reply goes out as soon as the document is durably stored, because
a model call takes 10-30s and CYWS gives up at 30.

**Who owns it is settled by the GROUP, not the sender field.** A group opened
for one person is a conversation with that person, and that was decided when it
was made — so it is not worked out again from whatever WhatsApp puts in
`sender`, which is increasingly a LID rather than a number. Matched against a
roster of phone numbers a LID is a stranger, and every bill she sent landed on
the General account. The entity-wide group genuinely has several people in it,
so there the sender's number is matched against the roster's Mobile field, in
any spelling; failing that, the entity's GENERAL account, which is what it is
for. Never the person who created the group.

Env (server/.env): `CYWORKSPACE_API_KEY` (the same key the Xero relay uses —
creating groups switches on with it), `CYWORKSPACE_PUBLIC_URL` (the only host a
file link may point at), `WHATSAPP_INBOUND_KEY` (the key CYWS sends BACK,
generated and kept if unset so a practice admin can read it out of the app).
Practice team only, like the inbound-email secret: it files documents into any
client's book. Covered by `npm test` in `server/`.

## AI API spend

Every model call records its token usage (`server/src/usage.ts`), attributed to
the client entity it was made for and priced at the published per-model rates —
Claude and OpenAI models are both in the table. Practice -> Clients shows today's
cost per client and its cost **over a period you pick**. There is no billing API
behind this — it is an estimate from real token counts. Override a rate with
`LLM_PRICES='{"gpt-5":{"input":1.25,"output":10}}'` (`ANTHROPIC_PRICES` still
works; the two are merged).

**"What did last month cost?" is the question, so the period is the control.**
Today and month-to-date were the only two windows, which answered it only on the
first of the month. Everything on the page — both stat cards and the per-client
column — is now totalled over one chosen window (`?range=last-month`, or
`?range=custom&from=&to=` on `GET /api/practice/clients`), with today kept
alongside it because that is what is running right now; picking Today drops the
duplicate column rather than printing the same figure twice.

**The key travels, not the dates.** A week starts on Monday and a day rolls over
in the PRACTICE's timezone, which the browser asking may not be in, so the
browser sends `today` / `week` / `last-month` / … and `resolveRange`
(`usage.ts`) turns it into two day keys against the practice's own clock. The
vocabulary and the words for it live in `src/lib/usageRange.js`; a server test
walks that list and asserts every key it offers resolves, so the two halves
can't drift. An unrecognised key resolves to this month and SAYS so — the page
labels itself from the window that came back, never from the one it asked for.
Retention is 400 days, so a range reaching past that is showing less than it
asks for, and the page says that too. Covered by `npm test` at the root and in
`server/`.

## A bridge entity (Red Alpha - ST Engineering)

Some people who submit costs don't work for any client entity CYBills holds. ST
Engineering staff claim against **Red Alpha's** ledger without being Red Alpha
employees, and they have never seen a chart of accounts. So an entity can be
**standalone**: `kind: 'standalone'` + `parentOrgId` on the organisation record,
no Xero tenant of its own, its own isolated Costs book (`dataScopeForOrg` gives
it one for free), and its claims posting into the parent's Xero
(`publishTargetFor`). `requireOrganisation` refuses the chart/tax/contact routes
for it with `no_xero_connection`; `requirePublishTarget` is the one that resolves
the parent, and publishing is the only Xero thing it can do.

**Its categories are plain names.** "Transport - Taxi", "Meal Weekday (after
9pm)" — the rows off the client's own claim form. The list and the add/hide
rules live in one pure module (`src/lib/categoryList.js`) because BOTH sides
read it: the dropdown (`useCategoryOptions`) and the document reader, including
the emailed-document path, which loads it by file path
(`server/src/categories.ts`, same arrangement as `taxRules.ts`). The reader is
given the names instead of accounts (`categories` on `/extract` +
`/extract-lines`, which no client had ever sent) plus a guide for what a plain
name MEANS — the mode a transport receipt names, the date and time deciding a
weekday-late meal from a weekend one, "Others" rather than the closest-sounding
guess.

**" - " does not mean "code - name".** Half the claim-policy names contain that
separator, and the old split read "Transport - Taxi" as the account code
"Transport": a code no chart has, on a line that would post to the wrong place,
and a Name-only dropdown showing a column of unrelated categories all called
"Taxi", "Train", "Bus". A code always has a digit in it — `categoryCode` /
`categoryName` / `categoryCodeEnd` in `categoryList.js` decide it once, for the
display path and the publish path both (`codeFromCategory` in `xero.ts` applies
the same rule server-side). Covered by `npm test` at the repo root.

**The map is what lets it publish.** One setting per bridge entity,
`cybills.category-accounts.v1`, `{ "Transport - Taxi": "493" }`, edited on Lists
-> Categories -> **Posts to** against the PARENT's accounts. `publish-claim`
consults it first and falls back to the label's own digits, so a linked entity
is unaffected. An unmapped category is refused (422, `unpostable_lines`) and
NAMED — never posted around, the same rule a bill's own line items follow — and
the message says to map it rather than to "use a coded category", which would
send those people looking for a chart they don't have. `npm test` in `server/`
posts a bridge claim end to end against a stubbed relay.

**A bridge claim posts with NO TAX**, at the full amount. The entity has no GST
registration and no tax position of its own, so there is no input tax to claim;
the tax the claim recorded is folded into the cost rather than dropped, so the
bill is worth exactly what the claim is worth. `TaxType: 'NONE'` is named
explicitly — left to the account's default rate, Xero would put GST on a figure
that has none. The bill's **Reference** is the claim's own name, date and Claim
ID ("ST Eng Exp Claim 20-Aug-2026 21324972410"), built from the same pure module
that prints that number on the claim page, the PDF and the CSV
(`src/lib/claimReference.js`, loaded server-side by `claimRef.ts`). It rides in
**`InvoiceNumber`**, not `Reference`: the box a BILL labels "Reference" in Xero
is the API's InvoiceNumber, and `Reference` is a sales-invoice field that an
ACCPAY accepts and silently drops. Its **Date** is the claim's own, else the
period it covers, else the latest date among its items — every expense on it
happened on or before that. Only a claim with nothing dated at all falls back to
today, which is what every claim used to do: August's expenses landing in
whichever month somebody pressed the button.

**One person can work in two entities.** Sign-in is by email, so a second roster
row for the same address would be a second identity — their documents, their
claims and their manager would split between the two, and only one could ever
sign in. So adding somebody who already exists elsewhere GRANTS their existing
row access here (`extraAccess: [{orgId, role}]` in `users.ts`, read by
`canAccessOrg` / `effectiveRoleFor` / `inOrg`) rather than creating a row. The
role is per entity — an admin of their own company is not an admin of somebody
else's — and a role edited on this entity's roster writes to `extraAccess`, never
to their own company's `role`. Deliberately NOT `clientAccess`, which belongs to
the practice team and is wiped from every non-practice row on load. Covered by
`npm test` in `server/`.

Still to do: privilege enforcement inside the entity is `docs/roles-enforcement.md`,
which is deliberately untouched here: until it lands, everyone in a bridge
entity sees every document in it. Fine for testing, not for real ST Eng staff.

## Paying a bill from CYWorkspace

CYBills collects the paper and codes it; CYWS runs the payment — it holds the
supplier's bank details, builds the bank upload file, and emails the run out.
The two met only in Xero, and CYWS's Bills Listing is built from AUTHORISED
ACCPAY invoices, so **a document CYBills had read and marked Ready but not yet
published did not exist as far as a payment run was concerned**. Three
machine-to-machine routes are the seam (`server/src/payments.ts`, contract in
`deploy/PAYABLES.md`): what is waiting to be paid, the paper the payee's bank
details are read off, and the publish that puts a document in the ledger so it
can be paid. Same `X-API-Key` CYWS already proves itself with on the WhatsApp
routes, now in its own leaf (`inboundKey.ts`) because the payables router cannot
import the WhatsApp one — it would import back.

**The contact is made FIRST, and the bill names it by ID.** Xero matches a
contact by NAME when given one and CREATES one when the name is new — which is
right for a publish from this app, where the supplier is whatever the paper says,
and quietly wrong here: CYWS creates the contact and saves the payee's bank
details on it before asking us to publish, so a bill posted as "A1 Consultancy
Pte Ltd" against a contact CYWS made as "A1 Consultancy" would land on a SECOND,
bank-detail-less contact and the payment file would have nowhere to send the
money. `buildBillInvoice` takes a `contactId` and the payables route requires
one; there is no name fallback on that road.

**AUTHORISED, because Xero will not accept a payment against a DRAFT or
SUBMITTED bill.** Publishing at either would produce a bank file for a bill the
ledger refuses to settle. Ticking a document into a run only selects it — the
contact and the publish happen when the run is COMMITTED, so unticking leaves
nothing in the ledger for somebody to void.

**One publish path, not two.** `postBillToXero` (`xero.ts`) is the whole of
publishing minus the request: the button in this app and the payables hand-off
post into the same live ledger, so they cannot hold different standards about
what may be posted, and the drift between two copies would be a wrong figure in
somebody's accounts rather than a wrong pixel. The account code and tax code a
machine caller cannot compute are worked out server-side by `postingCodesFor` /
`postingCodesFrom`, in the same three steps the browser has always used
(`autoPublish.js`): the category's own code, LIVE in this org's chart; the org's
rate matching the document's tax rate by name; else the account's default. Never
guessed — a bill posted under an invented tax code puts a figure in somebody's
GST return that nobody chose.

**What is offered is narrow, and every exclusion is a way of paying money twice
or paying it for nothing.** A cost document (not a sales one), still in the
INBOX (archived is somebody setting it aside, a claimed one reaches the ledger as
a line of the claim's bill, a merged one is another document's money), not
already in Xero, complete, and **not marked paid** — that last one matters most,
because much of what CYBills collects is receipts, money already handed over at
the merchant, and a receipt in a payment run pays the supplier a second time.
Each row also carries `postable` + `blocked_reason`, decided against the org's
live chart, because a row that looks payable and only refuses AFTER a contact has
been created for it in Xero is worse than one that never offered itself.

**A link Xero refuses costs the whole bill, so it is checked rather than
assumed.** Xero validates an invoice's `Url` — no custom port, no IP host, a
publicly addressable domain — and rejects the INVOICE when it doesn't like it.
The origin comes from the request (`appOrigin`), and a browser's request carries
the public host, so publishing from the app had always been fine; the first bill
published by MACHINE was the first one Xero refused, because CYWS calls across
the VPS on `http://127.0.0.1:3004` and that breaks all three rules at once.
`xeroInvoiceUrl` drops a link that would be refused rather than risking the bill
for a button, on both the bill and the claim road. `APP_ORIGIN` is how a deploy
gets the button back on the machine road — it is the only thing that CAN know
the public host when the request itself arrived on a loopback address.

**The caller names the ledger it is posting into.** One key opens every client's
book, so publish refuses a document whose entity is on a different tenant
(`tenant_mismatch`) — without it a mis-set tenant in a payment run would post one
client's bill into another client's accounts, and both sides would look fine.
Publishing is idempotent for the same reason a run is re-pressed after a failure
half way through: a document already in Xero answers with the invoice it has
rather than posting a second copy. Covered by `npm test` in `server/`
(`test/payables.test.mts`), driven over real HTTP against the real server —
mounting the router directly would never meet the session guard, which is where
the allowlist that lets these through lives.

## Xero via the cyworkspace relay

CYBills never holds Xero credentials. All Xero traffic goes through
cyworkspace's authenticated relay
(`ANY /api/webhooks/xero-relay/<XeroPath>?tenant_id=<UUID>`, `X-API-Key`
header) — cyworkspace owns the OAuth client, token refresh, and 429 retries.
Server-side consumer lives in `server/src/xero.ts`; organisations (client
entities linked to a Xero tenant) in `server/src/organisations.ts`.

Env (server/.env): `CYWORKSPACE_RELAY_URL` (on the VPS use
`http://127.0.0.1:3001` — both apps share the box) and `CYWORKSPACE_API_KEY`
(same value as cyworkspace's `WEBHOOK_API_KEY`). Xero endpoints 503 until the
key is set, so deploys are safe before the env is configured.

**Xero talks back: a paid bill says so itself.** A published bill's Paid field
was only ever ticked by hand, so a bill settled in Xero stayed unpaid here until
somebody noticed. Xero's invoice webhook is the notice — but it says only that
an invoice CHANGED, never what changed or what it changed to: there is no "paid"
event and no PAYMENT category at all, and the payload carries just the invoice's
id. So every event ends in a read-back (`server/src/xeroWebhook.ts`): match
`resourceId` against a document's `xeroInvoiceId`, ask Xero what that invoice is
now (`fetchXeroInvoice`), and record what it says.

**Xero's answer is not the Paid toggle.** They are two questions and only one of
them is Xero's. `paid` is the reviewer's own flag in DEXT's sense — "this was
already settled when it was captured, so publish it as paid" — defaulted per
document type in Extraction settings and written by supplier rules. What the
webhook records is the ledger's answer about the bill AFTER it was published:
`xeroStatus` / `xeroPaidDate` / `xeroPaymentRef`, written only by
`markBillXeroPayment` (never through `updateBill`, whose `EDITABLE` list is the
surface a PERSON may change) and never edited in the app. Folding the second
into the first would overwrite somebody's setting with a different question's
answer, so a document can legitimately show an unticked Paid toggle and a Paid
status, or the reverse.

Stored as Xero words it — PAID, AUTHORISED, VOIDED — rather than reduced to a
boolean, because "not paid" covers a bill awaiting payment and a bill that was
voided, and a reviewer needs those told apart. `Status`, not `AmountDue`: Xero
calls a bill PAID only when nothing is left on it, so a PARTLY paid one stays
AUTHORISED. The wording lives in one pure module (`src/lib/xeroPaidStatus.js`,
tested by `npm test` at the root) because the Costs list and the document page
both read it; a status nobody has heard yet is shown as a dash, never guessed.
It surfaces as the **Paid status** column — ON by default, since a published
bill being settled is what the reviewer is waiting to see — a **Payment
reference** column beside it, and a read-only **In Xero** block on the document
page. The `paid` toggle keeps its own opt-in column.

Matching locally comes FIRST, and only an **UPDATE** is read at all. The webhook
is configured per Xero **app**, so it fires for every invoice in every client
cyworkspace has connected — the whole client list, sales invoices included — and
an event naming an invoice CYBills never published must not cost a relay call.
A CREATE naming one it DID publish is the echo of that publish a second earlier,
so reading it back can only confirm what was just written. The read-back is the
only thing here that spends Xero's rate limit (60/min, 5,000/day per tenant per
app); the deliveries themselves are free.

Three of Xero's own rules shape the route, which is why it looks unlike every
other one here: the signature covers the **raw** body, so it is mounted with
`express.raw` ahead of `express.json` AND ahead of the session guard (it carries
its own proof — the `x-xero-signature` HMAC — instead of a session); the reply
must land inside 5 seconds as 200 or 401, so it goes out BEFORE the read-back,
which is queued; and the first delivery is an "intent to receive" handshake
carrying a deliberately wrong signature, which the same 401 answers. Enough
failed deliveries and Xero disables the webhook at its end.

**A claim is paperwork over the same kind of bill**, so the three fields sit on
a claim too (`claims.ts`: `claimsByXeroInvoiceId` / `markClaimXeroPayment`), and
one webhook event asks about both — a Xero invoice can have a cost document
behind it or an expense claim, and the person waiting on the answer differs. An
approval is the company saying it owes the money; this is the bank saying it
left, which is the claimant's actual question. It shows on Expense claims as
**Paid status** + **Paid date** — the same two columns, with the same names,
that the Costs list has, because a claim's bill and a cost's bill are the same
kind of thing in the same ledger; folded into one "Reimbursed · 25 Aug 2026"
cell they read as a different fact and could not be sorted by when the money
actually left. And as the claim page's own chip, which reads "Reimbursed 25 Aug
2026" once Xero says so rather than staying on "Published to Xero" forever, and
which LINKS to the bill. A claim carries no tenant of its own — a bridge entity's claims
post into the PARENT's Xero — so the sweep asks `publishTargetFor`, never the
claim.

**The webhook can only hear the future**, so there is a backfill for the past:
Business settings → Connections → **Payment status** → "Check now"
(`POST /api/xero/organisations/:id/sync-payments`). It reads every published
bill in that entity's book through Xero's `?IDs=` filter — 50 invoices a call,
so a book of 500 costs ten calls rather than 500 — and records the same three
fields through the same `paymentFromInvoice` (`xero.ts`), so a bill paid before
webhooks existed ends up saying exactly what one paid after them says. Read-only
and re-runnable, which also makes it the repair for a delivery Xero dropped. A
`?IDs=` response can omit `Payments`, so a PAID bill that comes back without a
reference is fetched by name (bounded, since that is a minority of any book);
`FullyPaidOnDate` arrives as ISO or as `/Date(ms+0000)/` and both are read. A
bill Xero no longer has is COUNTED and reported, never silently skipped — it
means the two disagree.

Delivery URL to paste into My Apps → Webhooks: `https://cybills.cy-bm.sg/api/webhooks/xero`,
notifying about **Invoices**. Env (server/.env): `XERO_WEBHOOK_KEY`, the key that
page shows. Unset, nothing can be verified and every delivery is refused — which
is what an unconfigured deploy should do. Covered by `npm test` in `server/`.

## Two-step sign-in (TOTP), for the password login

A Google account already carries its own second factor, so this exists for the
people who reach CYBills through the PASSWORD form — ST Engineering's staff, and
anyone else without a Google account. For them the password was the only thing
between an outsider and a client's whole book of paperwork.

`server/src/totp.ts` is RFC 6238 written out rather than pulled in: it is thirty
lines of HMAC, and the RFC ships test vectors, so it is checked against the
standard itself (`test/totp.test.mts`) instead of against a library's behaviour.
Six digits, thirty seconds, one step of tolerance either side — a phone's clock
drifts and a person takes a moment to type, and refusing a code that was right
four seconds ago fails honest people far more often than it stops anybody.

**The password stops minting a session on its own.** For an enrolled user
`/login` answers with a CHALLENGE instead: a five-minute token that says "this
password was right, for this person" and grants nothing. `kind: 'totp'` is
checked on the way back, because without it a session cookie would verify at the
second step and skip the very thing it stands in front of.

**The secret is sealed at rest** (`sealSecret`, the same AES-GCM-from-
SESSION_SECRET arrangement `mailAccount.ts` uses) and stripped from
`publicUser`: it is password-equivalent, so neither a copy of the data file nor
a browser should ever hold one. A PENDING secret is kept apart from a live one,
so a half-finished enrolment can never gate a sign-in.

**Ten recovery codes, hashed, shown once**, and spent on use. Without them a
lost phone means waiting for an admin. An admin's reset (Users -> Manage) only
ever CLEARS — there is nothing an admin can read that would let them sign in as
somebody else — and it is logged.

**Nobody signs in with a password alone.** A password user with no second
factor is sent to set one up AT the sign-in form, before any session exists —
a requirement that let people through "just this once" would be one in name
only, and the accounts it exists for are the ones that never get round to it.
`/totp/start` and `/totp/enable` therefore accept the CHALLENGE in place of the
session those people do not have yet, and finishing enrolment is what gives them
one. Google sign-in is untouched: that branch is only ever reached through the
password form.

**A trusted browser is asked once, then not again for 30 days** (`cyb_trust`,
its own cookie). Without it a second factor on a daily tool is a tax, and the
way people pay a tax like that is by choosing a worse password. The token names
ONE person and the moment their factor was enrolled, so it cannot be replayed
for somebody else, and a reset or a re-enrolment silently retires every browser
trusted before it — which is what you want on the day the laptop is the thing
that went missing. A RECOVERY code never trusts the browser it was used on,
whatever the checkbox said: reaching for one is what it looks like when the
phone is missing, and also what it looks like when the account is being taken.

`/api/users/login/totp` is allowlisted past the session guard, and has to be:
whoever is standing at the code prompt has no session yet, which is the entire
point of the step. Guarding it locked out precisely the people it exists for —
found by driving the real HTTP path, since a test mounting the router directly
never meets the guard at all.

## Account email via Microsoft Graph (delegated)

Invitations, password resets, and password-changed notices are sent from a
Microsoft 365 mailbox through Graph's `sendMail`, using **delegated** auth. The
Azure app registration holds Microsoft Graph **`Mail.Send`, Delegated type** —
deliberately NOT the Application permission, which is tenant-wide. Delegated
means CYBills can only ever send as the one account that consented, and can read
nothing.

Because a password reset is triggered by someone who isn't signed in, there's no
live session to borrow: an admin connects the mailbox once (Settings → Email,
OAuth code flow) and the refresh token is kept, encrypted at rest with a key
derived from `SESSION_SECRET`. A lapsed grant (password change, revoked consent)
surfaces as "Reconnect needed" rather than silent failure.

**It is the deployment's mailbox, so it lives in the practice's entity.** One
mailbox sends every client's invitations and password resets; nothing about it
is Red Alpha's or ST Engineering's. Listed under each client's Business settings
it read as that client's own — and handed their Business Admin a Disconnect
button for everybody's account email. So Settings -> Email is offered only to
the practice team, in the PRIMARY entity (`useIsPrimaryOrganisation` +
`isPracticeTeam`), and a deep link naming it from anywhere else lands on
Business profile. Enforced again on the server (`mayManageMail` in `mail.ts`,
status included, the same posture the inbound secret has), because hiding a
section is a decision the browser makes and anybody can ask the API directly.
Covered by `npm test` in `server/` (`test/secrets-access.test.mts`).

Server-side: `server/src/mailer.ts` (token redemption + `sendMail` + templates),
`mailAccount.ts` (sealed token store), `mail.ts` (connect/callback/disconnect/
test); the flows live in `server/src/users.ts` (invite / reset / change
password). Env (server/.env): `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET`, `GRAPH_REDIRECT_URI`, optional `GRAPH_SHARED_SENDER`
(needs `Mail.Send.Shared` + Send As), `MAIL_REPLY_TO`, `INVITE_TTL_DAYS`. With
them unset, mail no-ops and invite/reset links are returned to the admin to
share by hand, so deploys are safe before the app registration exists. Setup
walkthrough: `deploy/EMAIL.md`.

## Push policy: auto-deploy enabled

The operator has granted standing authorization to push to `main` after each
cohesive commit (see the global auto-push memory). **Each push to `main` is a
real production deploy** to cybills.cy-bm.sg — treat every push as shipping to
prod.

Deploys are **pull-based**, not GitHub-Actions-based. The VPS runs a
long-running daemon (`scripts/auto-deploy-poll.sh`, the
`cybills-autodeploy` systemd service) that polls `origin/main` over outbound
HTTPS every ~1 min; when it advances it `git reset --hard` + runs
`scripts/deploy.sh` (build + restart + health check). So a push lands on the
box within ~1 minute with **no GitHub Actions run** — don't wait on
`gh run list` to confirm a deploy; there won't be one.

Guidelines:

- Push after a complete, self-contained change (don't push half-done work).
- Type-check before pushing if server-side TS changed
  (`cd server && npm run build`).
- If a change is destructive (ENV, breaking API), surface it for explicit
  confirmation before pushing.
- Never `git push --force` or push to `main` from a half-merged state.

To revoke this authorization, the operator removes this section.
