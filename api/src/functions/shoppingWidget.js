const { app } = require('@azure/functions');
const { loadAll, getUser, emailKey } = require('../storage');
const { jsonResp, cors } = require('../auth');

// Public read-only endpoint for widget access.
// GET /api/shopping/widget-api/:secret
// No auth required — the secret in the URL acts as a bearer token.
// Resolves user email → householdId, then returns shopping data.

const WIDGET_SECRET = process.env.WIDGET_SECRET || 'ZQwcYaJx1fiDhbmJvKZoeAmWshj6BrbJf6Q9Mp1BVOs';
const WIDGET_USER_EMAIL = process.env.WIDGET_HOUSEHOLD || 'guitar1@gmail.com';

app.http('shoppingWidget', {
  route: 'shopping/widget-api/{secret}',
  methods: ['GET', 'PATCH', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    if (req.method === 'OPTIONS') return cors({ status: 204 });

    const secret = req.params.secret;
    if (!secret || secret !== WIDGET_SECRET) {
      return cors(jsonResp({ error: 'forbidden' }, 403));
    }

    try {
      const user = await getUser(emailKey(WIDGET_USER_EMAIL));
      if (!user || !user.householdId) {
        return cors(jsonResp({ error: 'user not found or no household' }, 404));
      }

      // PATCH: toggle bought status ONLY for an existing item.
      // Security: only accepts boolean 'bought' field. No name/qty/add/delete.
      if (req.method === 'PATCH') {
        let body;
        try { body = JSON.parse(await req.text() || '{}'); } catch(_) {
          return cors(jsonResp({ error: 'invalid JSON' }, 400));
        }

        // Strict field validation — only storeId, itemId, bought allowed
        const allowedKeys = new Set(['storeId', 'itemId', 'bought']);
        for (const key of Object.keys(body)) {
          if (!allowedKeys.has(key)) return cors(jsonResp({ error: `unexpected field: ${key}` }, 400));
        }

        const { storeId, itemId, bought } = body;
        if (typeof storeId !== 'string' || typeof itemId !== 'string' || typeof bought !== 'boolean') {
          return cors(jsonResp({ error: 'storeId (string), itemId (string), bought (boolean) required' }, 400));
        }

        const data = await loadAll(user.householdId);
        const store = data.stores.find(s => s.id === storeId);
        if (!store) return cors(jsonResp({ error: 'store not found' }, 404));
        const item = store.items.find(i => i.id === itemId && !i.deletedAt);
        if (!item) return cors(jsonResp({ error: 'item not found' }, 404));

        // Only mutate the bought field — nothing else
        item.bought = bought;
        item.lastModified = Date.now();
        store.lastModified = Date.now();
        data.lastModified = Date.now();

        const { writeAll: doWrite } = require('../storage');
        await doWrite(user.householdId, data);
        return cors(jsonResp({ ok: true }));
      }

      // GET: return stores
      const data = await loadAll(user.householdId);
      const stores = (data.stores || []).map(s => ({
        id: s.id,
        name: s.name,
        items: (s.items || [])
          .filter(i => !i.deletedAt)
          .map(i => ({
            id: i.id,
            name: i.name,
            bought: !!i.bought,
          }))
      }));
      return cors(jsonResp({ stores }));
    } catch (e) {
      ctx.log('Widget API error:', e.message);
      return cors(jsonResp({ error: 'server error' }, 500));
    }
  },
});
