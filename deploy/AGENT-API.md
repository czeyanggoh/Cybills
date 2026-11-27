# Agent API — expense claims and cost documents for a machine caller

`/api/agent/*` (`server/src/agentApi.ts`). It lets an agent do what a person does
by hand on the Costs and Expense claims pages, without scraping the UI. The caller
is CYWorkspace's `cybillsClaims` function, which the cyws MCP connector reaches.

## How it decides who may do what

It makes no decisions of its own.

- **The caller** proves itself with `X-API-Key`. This is the same key CYWS uses on
  `/api/payments` (`inboundKey.ts`).
- **The entity** comes from the Xero tenant the caller names (`tenant_id`). It is
  either the entity linked to that tenant, or a bridge entity that publishes into
  it. When a tenant has several entities, pass `org_id` to say which (a 409
  `which_entity` lists them).
- **The person** may instead be named by `acting_whatsapp`: the WhatsApp number
  on their CYBills profile, digits with the country code. CYWorkspace's CYBot
  sends it when somebody approves a claim in a WhatsApp group. It must be exactly
  one active user's number (`not_a_member` when nobody's, `which_person` when two
  share it). The answer says who it was (`acting_as`, `acting_name`).
- **The person** is named by `acting_email`. It must be an active CYBills user
  who can open that entity. CYWS always sends its own signed-in user here, never
  an address the agent typed.
- **The action** is then made through the same route the page calls
  (`/api/costs/bills`, `/api/claims/*`, `/api/xero/organisations/:id/*`). It goes
  over loopback with a five-minute session for that person. So approving, adding
  to a claim or publishing is allowed or refused exactly as the click would be.

**Never offered:** permanent delete of anything. Archive is offered.

## Actions

`POST /api/agent/<action>` with body
`{ tenant_id, acting_email, org_id?, ...fields }`.
`GET /api/agent/actions` lists the actions by group.

| Group (cyws grant) | Action | Fields |
|---|---|---|
| read | `list_costs` | `supplier` (contains; also matches the description), `owner`, `date_from`, `date_to`, `status` (`unpublished` / `ready` / `to_review` / `archived` / `in_expense_claim` / `published` / `processing`), `amount` or `amount_min` / `amount_max`, `offset`, `limit` (≤ 200) |
| read | `get_cost` | `item_id` (the number people see, or the `bill_…` id) |
| read | `list_expense_claims` | `claim_for` (contains), `month` (YYYY-MM, on the end date), `status` (`draft` / `awaiting_approval` / `approved` / `rejected` / `published` / `paid` / `archived`), `offset`, `limit` |
| read | `get_expense_claim` | `claim_id` |
| read | `list_suppliers` | `offset`, `limit` |
| read | `search_suppliers` | `q`. There is no alias table, so this searches what the documents say (name, description, invoice number, file name). "tanda" → EPI Capital Pty Ltd. |
| records | `create_claim` | `name`, `claim_for`, `date` |
| records | `add_items_to_claim` | `item_ids[]`, plus `claim_id` or `new_claim { claim_for, name, date }`. An item already on another claim is MOVED in the same write. |
| records | `move_items` | `from_claim`, `to_claim`, `item_ids[]`. Refused if an item is not on `from_claim`. |
| records | `remove_items_from_claim` | `claim_id`, `item_ids[]`. The documents go back to Costs. |
| records | `rename_claim` / `update_claim_date` / `archive_claim` | `claim_id`, then `name` / `date` / `archived` |
| records | `update_item` | `item_id`, plus any of `category`, `date`, `supplier`, `tax_rate`, `description` |
| records | `set_item_owner` | `item_id`, `owner` |
| records | `archive_cost` | `item_id`. Refused while the document is on a claim. |
| xero | `submit_claim` | `claim_id`, `approver_email` (which direct manager, needed where the claimant has several; the dry run lists them as `approvers`), `confirm` |
| xero | `approve_claim` | `claim_id`, `confirm` |
| xero | `approve_and_publish_claim` | `claim_id`, `xero_status` (DRAFT by default), `confirm` |
| xero | `publish_costs` | `item_ids[]`, `xero_status`, `confirm` |

An entity in cash mode posts Spend Money: `publish_costs` and
`approve_and_publish_claim` also take `paid_from` (a bank account's name or
AccountID) and `paid_date`. A claim needs both; a cost needs them unless it is
already marked Paid from a bank account. `xero_status` is ignored.

**Xero actions are a dry run unless `confirm: true`.** The dry run returns what
would happen, and the claim or documents it would act on, and changes nothing.

**Every write answers with what it changed:**
- `before`: where each document was;
- `claims`: each claim it touched, with `total`, `item_count`, `items` and
  `history`;
- for a move, `moved_from`.

The caller can check the result without reading again.

## One claim per document

A document is on one claim at a time.
- Adding it to a second claim moves it, in one write (`takeOffOtherClaims`).
- Every claims write is refused if it would leave a document on two claims
  (`ClaimMembershipError` → 409 `item_on_two_claims`).
- Duplicates left by the old code are repaired once at start-up: the document
  stays on the claim that is approved or in Xero, otherwise on the one it was put
  on first, and the other claim's history says so.
- Claim lines are stored under the `bill_…` id, whatever the caller sent.

The Costs list's "In expense claim" comes from claim membership
(`syncClaimStatuses`). Each row also carries `claim: { id, name }`.

## Example

```bash
curl -s https://cybills.cy-bm.sg/api/agent/add_items_to_claim \
  -H "X-API-Key: $CYWS_KEY" -H 'Content-Type: application/json' \
  -d '{"tenant_id":"<xero tenant>","acting_email":"person@cy-bm.sg",
       "claim_id":"<oct claim id>","item_ids":["261029000237"]}'
```

From the cyws MCP connector it is function `cybillsClaims`. The connector fills
in `acting_email` itself, from the key's owner. The function stays off until
`CYBILLS_AGENT_ENABLED=1` is set on the CYWS server.

```json
cyws_call_function {
  "name": "cybillsClaims", "action": "move_items",
  "body": { "tenant_id": "<xero tenant>", "from_claim": "<nov id>", "to_claim": "<oct id>",
            "item_ids": ["261029000237"] }
}
```

Tests: `server/test/agent-api.test.mts` and `server/test/claim-membership.test.mts`
(both run in `npm test`).
