# Canonical branch handling (optional but recommended)

Ensure `/staff/:branchParam` normalizes the route param to the *canonical* branch code (e.g., `YL-MOA`) **before** rendering, so the listener subscribes to the exact path the guest app writes under.

Example (Express):
```js
// staff-route (requires a resolveBranchCode helper)
const admin = require('firebase-admin');
const db = admin.firestore();
const { resolveBranchCode } = require('../../shared/resolveBranch');

app.get('/staff/:branchParam', requireAuth, async (req, res) => {
  const canonical = await resolveBranchCode(db, req.params.branchParam);
  if (canonical !== req.params.branchParam) return res.redirect(`/staff/${canonical}`);
  // ...fetch branchName, nowServing, tickets, then:
  res.render('staff', { branchCode: canonical, branchName, tickets, nowServing });
});
```

If you already applied this pattern, you’re good to go.
