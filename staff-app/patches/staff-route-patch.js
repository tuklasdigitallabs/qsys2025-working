// staff-app patch: normalize /staff/:branchParam to canonical + show branchName
const admin = require('firebase-admin');
const db = admin.firestore();
const { resolveBranchCode } = require('../../shared/resolveBranch');

module.exports = (app, requireAuth) => {
  app.get('/staff/:branchParam', requireAuth, async (req, res) => {
    const canonical = await resolveBranchCode(db, req.params.branchParam);
    if (canonical !== req.params.branchParam) return res.redirect(`/staff/${canonical}`);

    const [branchSnap, nowDoc, ticketsSnap] = await Promise.all([
      db.doc(`branches/${canonical}`).get(),
      db.doc(`queues/${canonical}/nowServing/current`).get(),
      db.collection(`queues/${canonical}/tickets`).where('status','in',['waiting','called']).orderBy('createdAt','asc').get()
    ]);
    const branchName = branchSnap.exists ? (branchSnap.data().branchName || canonical) : canonical;

    const tickets = { A:[], B:[], C:[] };
    ticketsSnap.forEach(d => { const t = { id:d.id, ...d.data() }; (tickets[t.group] ||= []).push(t); });

    res.render('staff', { user: req.session.user, branchCode: canonical, branchName,
      nowServing: nowDoc.exists ? nowDoc.data() : { ticketId:null }, tickets });
  });
};
