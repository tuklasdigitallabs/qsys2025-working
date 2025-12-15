# staff.live.js (custom token variant)

This script signs the browser into Firebase Auth with the **custom token** your server minted (including the `role` claim), then listens to Firestore and **auto-reloads** when a new ticket arrives under today’s A/B/C.

## Requirements
- In your `server.js`, pass `customToken` to the EJS (already done in your latest file).
- In `views/staff.ejs`, define:
  ```html
  <script>
    window.FIREBASE_CONFIG = {
      apiKey: "<%= process.env.FIREBASE_WEB_API_KEY %>",
      authDomain: "<%= process.env.FIREBASE_AUTH_DOMAIN %>",
      projectId: "<%= process.env.FIREBASE_PROJECT_ID %>",
      storageBucket: "<%= process.env.FIREBASE_STORAGE_BUCKET %>",
      messagingSenderId: "<%= process.env.FIREBASE_MESSAGING_SENDER_ID %>",
      appId: "<%= process.env.FIREBASE_APP_ID %>"
    };
    window.STAFF_CUSTOM_TOKEN = "<%= customToken %>";
  </script>
  ```
- Your `<main>` tag should be:
  ```html
  <main id="staff-root" class="columns" data-branch="<%= branchCode %>">
  ```

## Use
1) Copy `public_js/staff.live.js` into your app.
2) Include it at the bottom of `views/staff.ejs`:
   ```html
   <script type="module" src="/public_js/staff.live.js"></script>
   ```

## What it watches
- `queues/{branchCode}/{YYYY-MM-DD}/{A|B|C}/items`
- Filters `status in ["waiting","called"]`
- Orders by `timestamp`

If the browser console shows an index error, click the link to create the composite index for `status + timestamp`.
