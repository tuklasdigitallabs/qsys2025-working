// guest-app patch: routes/register.js
const admin = require('firebase-admin');
const db = admin.firestore();
const { resolveBranchCode } = require('../../shared/resolveBranch');

module.exports = (app) => {
  app.post('/register/:branchParam', async (req, res) => {
    try {
      const canonical = await resolveBranchCode(db, req.params.branchParam);
      const { name, pax, phone } = req.body;
      const group = pax <= 2 ? 'A' : pax <= 4 ? 'B' : 'C';

      const counterRef = db.doc(`queues/${canonical}/counters/${group}`);
      let nextNum;
      await db.runTransaction(async tx => {
        const c = await tx.get(counterRef);
        const cur = (c.exists && c.data().nextNumber) || 0;
        nextNum = cur + 1;
        tx.set(counterRef, { nextNumber: nextNum }, { merge: true });
      });

      await db.collection(`queues/${canonical}/tickets`).add({
        branch: canonical,
        group, number: nextNum,
        name, pax: Number(pax), phone: phone || null,
        status: 'waiting',
        createdAt: admin.firestore.Timestamp.now()
      });

      return res.redirect(`/ticket/${canonical}`);
    } catch (e) {
      console.error('[register]', e);
      return res.status(400).send('Invalid branch.');
    }
  });
};
