// staff-app patch: normalize /display/:branchParam and include branchName
const admin = require('firebase-admin');
const db = admin.firestore();
const { resolveBranchCode } = require('../../shared/resolveBranch');

module.exports = (app) => {
  app.get('/display/:branchParam', async (req, res) => {
    const canonical = await resolveBranchCode(db, req.params.branchParam);
    if (canonical !== req.params.branchParam) return res.redirect(`/display/${canonical}`);

    const [branchSnap, doc] = await Promise.all([
      db.doc(`branches/${canonical}`).get(),
      db.doc(`queues/${canonical}/nowServing/current`).get()
    ]);
    const branchName = branchSnap.exists ? (branchSnap.data().branchName || canonical) : canonical;

    res.render('display', { branchCode: canonical, branchName, current: doc.exists ? doc.data() : { ticketId:null } });
  });
};
