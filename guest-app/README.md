# OG QSys – Guest Registration App (Nested Firestore Schema)

Express + EJS app backed by Firebase Firestore.

## Routes
- `GET /register/:branchCode` → registration form.
- `POST /register/:branchCode` → creates a ticket inside the nested path and redirects to ticket.
- `GET /ticket/:branchCode/:date/:group/:id` → confirmation page.

## Firestore (Guest project)
```
queues/{branchCode}/{yyyy-mm-dd}/{group}/items/{queueId}
queues/{branchCode}/{yyyy-mm-dd}/{group}/meta/counter   (docId: counter)
```
**Fields (items):**
`{ code, branchCode, branchName, group, number, name, pax, phone, status, timestamp, date }`

- **Grouping:** A = 1–2 pax, B = 3–4, C = 5+
- **Ticket code:** `<GROUP><NN>` (width via `QUEUE_NUMBER_WIDTH`)

## Quick Start
1. `.env` (copy from `.env.example`)
2. Put your Firebase service account at `FIREBASE_SERVICE_ACCOUNT` path.
3. Install & run:
```bash
npm install
npm run dev
```
Open `http://localhost:3000/register/moa`

## Notes
- Per SOT, Guest data is isolated in the Guest Firebase project.
- Future Staff/Admin modules should not share this Admin key; use replication or server-side cross-reads only.

## Branches collection
Create branch docs once (managed by Admin tools or console):

Collection: `branches`
Doc ID (slug): `moa`
```json
{
  "name": "Yakiniku Like MOA",
  "code": "YL-MOA"
}
```
Another example:
- slug: `megamall`
```json
{
  "name": "Yakiniku Like Megamall",
  "code": "YL-MEGAMALL"
}
```

> The app fetches `branches/{slug}` on both GET and POST. If missing, it falls back to a generic display name and uses the slug as code.

## Firestore Security Rules (guest project)
See `firestore.rules` in this folder. Deploy with:
```bash
firebase deploy --only firestore:rules
```
