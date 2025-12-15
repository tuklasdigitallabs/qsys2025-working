// routes/staff-route-nested.js
// Staff route reading nested date/group items that the guest app writes.
// Keeps your dark UI and EJS shape (tickets.A/B/C).

const admin = require('firebase-admin');
const db = admin.firestore();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(timezone);
const DEFAULT_TZ = process.env.QUEUE_TIMEZONE || 'Asia/Manila';

// Optional: if you have a resolver already, require it here.
// const { resolveBranchCode } = require('../../shared/resolveBranch');

module.exports = (app, requireAuth) => {
  app.get('/staff/:branchParam', requireAuth, async (req, res) => {
    try {
      const incoming = String(req.params.branchParam || '').trim();
      // Use your own resolver if present; otherwise trust the param as canonical uppercase.
      // const canonical = await resolveBranchCode(db, incoming);
      const canonical = incoming.toUpperCase();

      // Derive today's partition in Asia/Manila
      const today = dayjs().tz(DEFAULT_TZ).format('YYYY-MM-DD');

      // Fetch branch name for header
      const branchSnap = await db.doc(`branches/${canonical}`).get();
      const branchName = branchSnap.exists ? (branchSnap.data().branchName || canonical) : canonical;

      // nowServing remains on the flat path you already use
      const nowRef = db.doc(`queues/${canonical}/nowServing/current`);
      const nowDoc = await nowRef.get();

      // Read items under nested per-group paths
      const groups = ['A','B','C'];
      const tickets = { A:[], B:[], C:[] };

      // We pull 'waiting' and 'called' ordered by timestamp asc
      await Promise.all(groups.map(async (g) => {
        const itemsRef = db.collection('queues').doc(canonical)
          .collection(today).doc(g).collection('items');
        const snap = await itemsRef
          .where('status','in',['waiting','called'])
          .orderBy('timestamp','asc')
          .get();
        snap.forEach(d => tickets[g].push({ id: d.id, ...d.data() }));
      }));

      return res.render('staff', {
        user: req.session.user,
        branchCode: canonical,
        branchName,
        nowServing: nowDoc.exists ? nowDoc.data() : { ticketId: null },
        tickets
      });
    } catch (e) {
      console.error('[staff nested route] error:', e);
      return res.status(500).send('Failed to load staff panel');
    }
  });
};
