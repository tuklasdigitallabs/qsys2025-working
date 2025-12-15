# Option B — Client Firestore Listener

This script uses the Firebase Web SDK to listen to Firestore and **auto-reload** your staff page when a new registration doc appears.

## Install
1) Put `public_js/staff.live.js` into your staff app.
2) In `views/staff.ejs`:
   - Ensure your wrapper exposes the branch:
     ```html
     <main id="staff-root" class="columns" data-branch="<%= branchCode %>">
     ```
   - Inject your Firebase Web config (same project the guest app writes to):
     ```ejs
     <script>
       window.FIREBASE_CONFIG = {
         apiKey: "<%= process.env.FIREBASE_WEB_API_KEY %>",
         authDomain: "<%= process.env.FIREBASE_AUTH_DOMAIN %>",
         projectId: "<%= process.env.FIREBASE_PROJECT_ID %>",
         storageBucket: "<%= process.env.FIREBASE_STORAGE_BUCKET %>",
         messagingSenderId: "<%= process.env.FIREBASE_MESSAGING_SENDER_ID %>",
         appId: "<%= process.env.FIREBASE_APP_ID %>"
       };
     </script>
     ```
   - Include the listener before `</body>`:
     ```html
     <script type="module" src="/public_js/staff.live.js"></script>
     ```

## Notes
- The script listens under `queues/{branchCode}/{YYYY-MM-DD}/{A|B|C}/items` with `status in ["waiting","called"]` ordered by `timestamp`.
- Date is in **Asia/Manila** to match your guest app partitions.
- It checks your rendered `.item[data-ticket]` ids and reloads only if a **new** doc id appears.
- If Firestore rules block reads in the browser, the page still works (no auto-refresh).