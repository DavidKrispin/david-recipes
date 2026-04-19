// Google Identity Services (GIS) wrapper + auth state for the recipe site.
// Exposes window.Auth with: signIn(), signOut(), getToken(), getUser(), onChange(), apiFetch(url, opts)
// Loads the GIS script lazily and renders a sign-in UI inside #auth-mount when needed.

(function () {
  const CLIENT_ID = '292463941706-dp8bjcfkbdal8kuvma252nci750f7osv.apps.googleusercontent.com';
  const TOKEN_KEY = 'recipes-auth-token';
  const USER_KEY = 'recipes-auth-user';
  const EXP_KEY = 'recipes-auth-exp';
  const listeners = new Set();

  function loadStored() {
    try {
      const tok = localStorage.getItem(TOKEN_KEY);
      const usr = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      const exp = Number(localStorage.getItem(EXP_KEY) || 0);
      if (!tok || !usr || !exp) return null;
      if (exp * 1000 < Date.now() + 60_000) return null; // <1 min left → treat as expired
      return { token: tok, user: usr, exp };
    } catch (_) { return null; }
  }

  function clearStored() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(EXP_KEY);
  }

  function decodeJwtPayload(jwt) {
    try {
      const part = jwt.split('.')[1];
      const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
      // Hebrew safe decode
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch (_) { return null; }
  }

  let _state = loadStored();
  function emit() {
    listeners.forEach((fn) => { try { fn(_state); } catch (_) {} });
    window.dispatchEvent(new CustomEvent('auth:change', { detail: _state }));
  }

  function setStateFromCredential(credential) {
    const payload = decodeJwtPayload(credential);
    if (!payload || !payload.email) return;
    const user = {
      email: payload.email,
      name: payload.name || payload.given_name || payload.email,
      picture: payload.picture || '',
      sub: payload.sub,
    };
    localStorage.setItem(TOKEN_KEY, credential);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(EXP_KEY, String(payload.exp || 0));
    _state = { token: credential, user, exp: payload.exp };
    emit();
  }

  function signOut() {
    clearStored();
    _state = null;
    if (window.google?.accounts?.id?.disableAutoSelect) {
      try { window.google.accounts.id.disableAutoSelect(); } catch (_) {}
    }
    emit();
  }

  let _gisLoaded = null;
  function loadGis() {
    if (_gisLoaded) return _gisLoaded;
    _gisLoaded = new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(s);
    });
    return _gisLoaded;
  }

  let _initialized = false;
  async function initGis() {
    await loadGis();
    if (_initialized) return;
    _initialized = true;
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (resp) => {
        if (resp && resp.credential) setStateFromCredential(resp.credential);
      },
      auto_select: false,
      cancel_on_tap_outside: true,
      ux_mode: 'popup',
    });
  }

  // Mount a Sign-In button into the given container.
  async function renderButton(container) {
    if (!container) return;
    await initGis();
    container.innerHTML = '';
    window.google.accounts.id.renderButton(container, {
      theme: document.documentElement.classList.contains('dark') ? 'filled_black' : 'outline',
      size: 'large',
      type: 'standard',
      shape: 'pill',
      text: 'signin_with',
      locale: 'he',
    });
  }

  // Prompt One-Tap if state is missing.
  async function tryOneTap() {
    if (_state) return;
    try {
      await initGis();
      window.google.accounts.id.prompt();
    } catch (_) {}
  }

  function getToken() { return _state?.token || null; }
  function getUser() { return _state?.user || null; }
  function isAuthenticated() {
    if (!_state) return false;
    if (_state.exp * 1000 < Date.now() + 60_000) {
      clearStored();
      _state = null;
      emit();
      return false;
    }
    return true;
  }
  function onChange(fn) { listeners.add(fn); fn(_state); return () => listeners.delete(fn); }

  // Wrapped fetch: adds Authorization, surfaces 401s.
  async function apiFetch(url, opts = {}) {
    if (!isAuthenticated()) {
      throw new Error('not-authenticated');
    }
    const headers = Object.assign({}, opts.headers || {}, {
      'X-Auth-Token': _state.token,
    });
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      // token rejected — drop state
      signOut();
      throw new Error('unauthorized');
    }
    return res;
  }

  // Auto-clear when token expires while page is open
  setInterval(() => {
    if (_state && _state.exp * 1000 < Date.now() + 60_000) {
      signOut();
    }
  }, 60_000);

  window.Auth = {
    CLIENT_ID,
    initGis,
    renderButton,
    tryOneTap,
    signOut,
    getToken,
    getUser,
    isAuthenticated,
    onChange,
    apiFetch,
  };
})();
