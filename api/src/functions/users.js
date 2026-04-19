const { app } = require('@azure/functions');
const {
  authenticate, jsonResp, cors, unauthorizedResp, readJson,
} = require('../auth');
const {
  getHousehold, listUsersByHousehold, addInvite, getInvite, deleteInvite,
  deleteUser, getUser, upsertUser, emailKey,
} = require('../storage');

// GET /api/user → current user + household + members
app.http('user', {
  route: 'user',
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    if (req.method === 'OPTIONS') return cors({ status: 204 });
    let auth;
    try { auth = await authenticate(req); } catch (e) { return unauthorizedResp(e.message); }
    try {
      const household = await getHousehold(auth.user.householdId);
      const members = await listUsersByHousehold(auth.user.householdId);
      return cors(jsonResp({
        user: {
          email: auth.user.email,
          name: auth.user.name,
          picture: auth.user.picture,
          role: auth.user.role,
          householdId: auth.user.householdId,
        },
        household,
        members: members.map((m) => ({
          email: m.email, name: m.name, picture: m.picture, role: m.role, joinedAt: m.joinedAt,
        })),
      }));
    } catch (err) {
      ctx.error('user handler error', err);
      return cors(jsonResp({ error: err.message || 'internal error' }, 500));
    }
  },
});

// POST /api/household/invite { email }  → owner only
app.http('householdInvite', {
  route: 'household/invite',
  methods: ['POST', 'GET', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    if (req.method === 'OPTIONS') return cors({ status: 204 });
    let auth;
    try { auth = await authenticate(req); } catch (e) { return unauthorizedResp(e.message); }
    if (auth.user.role !== 'owner') {
      return cors(jsonResp({ error: 'owner only' }, 403));
    }
    try {
      if (req.method === 'GET') {
        // list invites isn't strictly needed by UI; included for completeness
        return cors(jsonResp({ ok: true }));
      }
      const body = await readJson(req);
      const email = emailKey(body && body.email);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return cors(jsonResp({ error: 'valid email required' }, 400));
      }
      // Don't re-invite an existing member
      const existing = await getUser(email);
      if (existing && existing.householdId === auth.user.householdId) {
        return cors(jsonResp({ ok: true, alreadyMember: true }));
      }
      if (existing && existing.householdId && existing.householdId !== auth.user.householdId) {
        return cors(jsonResp({ error: 'user already belongs to another household' }, 409));
      }
      await addInvite({ email, householdId: auth.user.householdId, invitedBy: auth.user.email });
      return cors(jsonResp({ ok: true, invited: email }));
    } catch (err) {
      ctx.error('invite error', err);
      return cors(jsonResp({ error: err.message || 'internal error' }, 500));
    }
  },
});

// DELETE /api/household/member?email=foo@bar  → owner only
app.http('householdMember', {
  route: 'household/member',
  methods: ['DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    if (req.method === 'OPTIONS') return cors({ status: 204 });
    let auth;
    try { auth = await authenticate(req); } catch (e) { return unauthorizedResp(e.message); }
    if (auth.user.role !== 'owner') {
      return cors(jsonResp({ error: 'owner only' }, 403));
    }
    try {
      const url = new URL(req.url);
      const email = emailKey(url.searchParams.get('email'));
      if (!email) return cors(jsonResp({ error: 'email required' }, 400));
      if (email === auth.user.email) {
        return cors(jsonResp({ error: 'owner cannot remove themselves' }, 400));
      }
      const target = await getUser(email);
      if (!target || target.householdId !== auth.user.householdId) {
        // Maybe just a pending invite — drop it
        await deleteInvite(email);
        return cors(jsonResp({ ok: true, removedInvite: true }));
      }
      // Demote: clear household so they get a fresh one on next login
      await deleteUser(email);
      await deleteInvite(email);
      return cors(jsonResp({ ok: true, removed: email }));
    } catch (err) {
      ctx.error('member delete error', err);
      return cors(jsonResp({ error: err.message || 'internal error' }, 500));
    }
  },
});
