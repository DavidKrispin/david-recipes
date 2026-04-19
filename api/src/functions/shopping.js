const { app } = require('@azure/functions');
const { loadAll, replaceAll, upsertStore } = require('../storage');
const { authenticate, jsonResp, cors, unauthorizedResp, readJson } = require('../auth');

app.http('shopping', {
  route: 'shopping',
  methods: ['GET', 'PUT', 'PATCH', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    if (req.method === 'OPTIONS') return cors({ status: 204 });
    let auth;
    try { auth = await authenticate(req); }
    catch (e) { return unauthorizedResp(e.message); }
    const householdId = auth.user.householdId;
    try {
      if (req.method === 'GET') {
        const data = await loadAll(householdId);
        return cors(jsonResp(data));
      }
      const body = await readJson(req);
      if (req.method === 'PUT') {
        const data = await replaceAll(householdId, body || { stores: [] });
        return cors(jsonResp(data));
      }
      if (req.method === 'PATCH') {
        if (!body || !body.id) return cors(jsonResp({ error: 'store.id required' }, 400));
        const data = await upsertStore(householdId, body);
        return cors(jsonResp(data));
      }
      return cors(jsonResp({ error: 'method not allowed' }, 405));
    } catch (err) {
      ctx.error('shopping handler error', err);
      return cors(jsonResp({ error: err.message || 'internal error' }, 500));
    }
  },
});
