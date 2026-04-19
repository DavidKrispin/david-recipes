const { app } = require('@azure/functions');
const { mergeSync } = require('../storage');
const { authenticate, jsonResp, cors, unauthorizedResp, readJson } = require('../auth');

app.http('shoppingSync', {
  route: 'shopping/sync',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    if (req.method === 'OPTIONS') return cors({ status: 204 });
    let auth;
    try { auth = await authenticate(req); }
    catch (e) { return unauthorizedResp(e.message); }
    try {
      const body = await readJson(req);
      const clientData = (body && body.clientData) || { stores: [] };
      const merged = await mergeSync(auth.user.householdId, clientData);
      return cors(jsonResp(merged));
    } catch (err) {
      ctx.error('shopping sync error', err);
      return cors(jsonResp({ error: err.message || 'internal error' }, 500));
    }
  },
});
