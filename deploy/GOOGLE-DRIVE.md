# Bill collection through a Google Drive folder

A person shares a folder in their **own** Google Drive with CYBills, and
whatever is saved into it — a scan, a PDF saved out of a mail client, a photo —
is read and filed under them, the way a bill emailed to their CYBills address
or sent into their WhatsApp group is. Once filed, the file is moved into a
`Filed` subfolder, so the folder only ever holds what is still waiting.

CYBills reaches Drive as a **service account** ("the robot"). It sees only the
folders somebody has shared with its address, needs no consent screen, and
works for a Google account at any domain. (Per-user OAuth was the alternative:
reading a folder needs a restricted Drive scope, which Google grants an app's
outside users only after verification and a security assessment.)

## One-time setup (the practice)

1. **Google Cloud console** → pick or create a project (the one holding the
   sign-in OAuth client is fine).
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **IAM & Admin → Service Accounts → Create service account.**
   Name it something people will recognise in a Share box, e.g. `cybills`.
   It needs **no** project roles and **no** domain-wide delegation.
4. Open it → **Keys → Add key → Create new key → JSON.** A file downloads.
   This is the only copy; it is a credential.
5. Put it in `server/.env` on the VPS, base64'd so it is one line:

   ```bash
   base64 -w0 cybills-robot-key.json
   ```

   That is Linux / macOS. In Windows PowerShell there is no `base64`; this
   puts the same line on the clipboard (nothing is printed):

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\cybills-robot-key.json")) | Set-Clipboard
   ```

   Google names the download after the project (`myproject-1a2b3c4d5e6f.json`),
   so use the file's real name. Then:

   ```
   GOOGLE_DRIVE_CREDENTIALS=<that one line>
   ```

   (Or leave the file on the box, readable only by the service user, and set
   `GOOGLE_DRIVE_KEY_FILE=/etc/cybills/drive-key.json` instead.)
6. Restart the server. Business settings → Extraction → **Extract by Google
   Drive** now shows the robot's address, which looks like
   `cybills@<project>.iam.gserviceaccount.com`.

If the organisation policy *"Disable service account key creation"* is on, step
4 is refused; it has to be lifted for this project.

| Env | Default | |
| --- | --- | --- |
| `GOOGLE_DRIVE_CREDENTIALS` | — | The JSON key: raw JSON on one line, or base64 of it. |
| `GOOGLE_DRIVE_KEY_FILE` | — | Path to the JSON key, instead of the above. |
| `DRIVE_POLL_SECONDS` | `120` | How often every connected folder is looked in (min 30). |

Unset, the road is simply not there: the cards say so and nothing is polled.

## Connecting a folder (anybody)

On the person's page — **Users → Manage → Edit user details**, or **Colleagues**
for the practice's own team — under **Connect a Google Drive folder**:

1. In Google Drive, **share the folder with the robot's address as an Editor**.
   Drive will warn that the address is outside the organisation; that is
   expected.
2. **Paste the folder's link** and press Connect.

Whatever is already in the folder is filed straight away; after that it is
looked in every couple of minutes, and **Check now** looks immediately.

A folder that is the *company's* rather than a person's — a shared scanner's
output, say — is connected on the **General** account's page, and files under
it like mail to the entity's own address does.

### Who may connect which folder

One robot address serves every client, so a folder shared with it for one
client must not be connectable by somebody at another who has merely come by
the link. Beyond the robot being able to open it:

- you connect a folder for **yourself**, or for somebody you administer
  (a Business Admin for their entity's people, the practice for anybody);
- the folder has to be **owned by or shared with** the person it will file
  under, or whoever is connecting it — by the address they sign in to CYBills
  with. An Owner / Practice Admin is excused, since they can open every
  client's book already;
- **one folder files under one person.** Connecting it to a second is refused.

Somebody whose Drive is under a different Google account from their CYBills
sign-in shares the folder with their CYBills address too, or asks the practice
to connect it.

## What is filed, and what is not

| In the folder | What happens |
| --- | --- |
| PDF, PNG, JPEG, GIF, WebP | Filed, read, moved into `Filed`. |
| HEIC / TIFF | Filed and moved, but not read (the reader cannot take them) — the document says so. |
| Word, Excel, anything else | Left where it is; the card says "not a PDF or image". |
| Google Docs / Sheets / Slides | Left where it is; download as PDF and save that. |
| Over 20 MB | Left where it is. |
| Subfolders and shortcuts | Ignored. Subfolders are **not** gone into. |

What a file *is* is decided from its bytes, not from Drive's label: a PDF a
scanner saved as `application/octet-stream` is still a PDF.

### The name a filed file wears

As it is moved into `Filed`, a file is renamed with the day it was filed and a
running number in front of its own name:

```
2026-10-01-0001 Grab 12 Sep.pdf
2026-10-01-0002 Singtel Sep.pdf
2026-10-01-0003 Singtel Sep.pdf      <- the same invoice, saved twice
2026-10-02-0001 Canva Oct.pdf
```

Drive lets two files share a name, so without it the same invoice saved twice
sits in `Filed` as two rows nobody can tell apart; with it they sort together
and are plainly two. Sorted by name, the folder is also in the order things were
filed. The number runs per folder per day and starts again at `0001` each
morning (the practice's timezone); it goes past four digits if a day ever needs
it. The document in CYBills keeps the name its owner gave the file, and its
**Google Drive** tab links straight to the file, whatever it is now called.
Files moved into `Filed` before this existed keep the names they have.

A file is filed **once, by its Drive id**. The move into `Filed` is a courtesy
to the person looking at their Drive, and it can fail without anything being
filed twice — a file that could not be moved stays put and is not read again.
Ten new files are taken per look, so a year of receipts dropped in at once
arrives ten at a time.

The file's **name** travels with it, as it does on an upload: "Singtel
tiffinlabs paid.pdf" tells the reader what the document is *for*, never what it
says.

## When the `Filed` folder cannot be made

Google does not let a service account own files in somebody's My Drive, and
depending on the account that can extend to the `Filed` folder itself. When it
does, the card says so and the fix is one step: **make a folder called `Filed`
inside the connected folder by hand.** CYBills finds it on the next look and
moves what it has filed into it. Folders inside a *shared drive* are owned by
the drive and never hit this.

A folder shared with the robot as a **Viewer** is still collected from; nothing
is moved, and the card asks for Editor.

## Disconnecting

**Disconnect** on the folder's card stops CYBills looking in it. Nothing in
Drive is touched, and the documents already filed stay in the book. To stop
CYBills being *able* to open the folder, its owner removes the robot from the
folder's sharing in Drive — which the card then reports as "can't be opened"
until it is disconnected or shared again.

## Troubleshooting

| The card says | Meaning |
| --- | --- |
| *CYBills can't open that folder yet* | Not shared with the robot's address — or shared from an organisation that blocks sharing outside its domain, which its Google Workspace admin has to allow. |
| *That folder is shared with CYBills, but not with …* | The ownership rule above. |
| *Can't be opened* | It was unshared, binned or deleted after connecting. |
| *Google refused CYBills' robot a token* | The key was deleted or disabled in Google Cloud; make a new one. |

Tests: `npm test` at the root (`drive-folder`, the link and file rules) and in
`server/` (`test/drive-folder.test.mts`, over real HTTP against a stub Google).
