import { init as init_canvas_editing } from './canvas/editing.js';
import { init as init_canvas_pointer } from './canvas/pointer.js';
import { init as init_actions_create } from './actions/create.js';
import { init as init_app_navigation } from './app/navigation.js';
import { init as init_ui_floatbars } from './ui/floatbars.js';
import { init as init_ui_menus } from './ui/menus.js';
import { init as init_features_io } from './features/io.js';
import { init as init_ui_search } from './ui/search.js';
import { init as init_ui_toolbar } from './ui/toolbar.js';
import { init as init_app_keyboard } from './app/keyboard.js';
import { init as init_ui_toast } from './ui/toast.js';
import { init as init_ui_theme } from './ui/theme.js';
import { init as init_cards_table } from './cards/table.js';
import { init as init_cards_doc } from './cards/doc.js';
import { init as init_cards_drawing } from './cards/drawing.js';
import { init as init_cards_embeds } from './cards/embeds.js';
import { init as init_cards_extras } from './cards/extras.js';
import { init as init_features_templates } from './features/templates.js';
import { init as init_features_share } from './features/share.js';
import { init as init_core_sync } from './core/sync.js';
import { init as init_core_realtime } from './core/realtime.js';
import { init as init_ui_header, paintAvatar, refreshHelp } from './ui/header.js';
import { routeAccount } from './ui/account.js';
import { init as init_ui_ai } from './ui/ai.js';
import { init as init_features_spaces, inviteLanding, paintSpaceBtn, refreshContexts } from './features/spaces.js';
import { init as init_features_comments } from './features/comments.js';
import { init as init_features_history } from './features/history.js';
import { init as init_ui_notify } from './ui/notify.js';
import { init as init_verify_banner } from './ui/verify-banner.js';
import { init as init_onboarding } from './features/onboarding.js';
import { $, uid } from './core/util.js';
import { api } from './core/api.js';
import { initAnalytics, setAnalyticsUser, track, trackAppEvents } from './core/analytics.js';
import { showConsentBanner } from './ui/consent.js';
import { googleError, showAuth, showReset } from './ui/auth.js';
import { LINK, ROOT, S, VIEW, load, parseHash, save, setCur, setROOT, setS, setSPACE } from './core/store.js';
import { setUser, sharedState } from './core/sync.js';
import { loadStyles } from './core/styles.js';
import { loadFavorites } from './ui/favorites.js';
import { joinLanding, openLink, openReportDialog } from './features/links.js';
import { render } from './canvas/render.js';
import { setLink } from './actions/create.js';
import { toast } from './ui/toast.js';
import { renderPanel, setPanel } from './ui/drawer.js';


init_canvas_editing();
init_canvas_pointer();
init_actions_create();
init_app_navigation();
init_ui_floatbars();
init_ui_menus();
init_features_io();
init_ui_search();
init_ui_toolbar();
init_app_keyboard();
init_ui_toast();
init_ui_theme();
init_cards_table();
init_cards_doc();
init_cards_drawing();
init_cards_embeds();
init_cards_extras();
init_features_templates();
init_features_share();
init_core_sync();
init_core_realtime();
init_ui_header();
init_ui_ai();
init_features_spaces();
init_features_comments();
init_features_history();
init_ui_notify();

/* ================= boot ================= */
(async () => {
  if (VIEW) {
    document.body.classList.add('viewonly', 'public-view');
    const d = await openLink(VIEW);
    if (!d) return;
    // a join link opened as a view link: go to the join page
    if (d.kind === 'join') return location.replace(location.pathname + '?join=' + VIEW);
    LINK.kind = d.kind; LINK.role = d.role;
    sharedState(d);
    setROOT(d.root);
    const pill = $('#viewPill');
    pill.hidden = false; pill.textContent = d.role === 'commenter' ? 'Can comment' : 'View only';
    $('.brand').href = '#/b/' + ROOT;
    const reportBtn = $('#reportLink');
    if (reportBtn) { reportBtn.hidden = false; reportBtn.onclick = () => openReportDialog(VIEW); }
  } else {
    // /signup and /login (the website's buttons) serve this page; open that form, then show the app's own address
    const authPath = location.pathname.match(/\/(signup|login)\/?$/)?.[1] || null;
    if (authPath) history.replaceState(null, '', location.pathname.replace(/(signup|login)\/?$/, '') + location.search + location.hash);
    const q = new URLSearchParams(location.search);
    const invite = /^[a-f0-9]{48}$/.test(q.get('invite') || '') ? q.get('invite') : null;
    const joinToken = /^[a-f0-9]{24}$/.test(q.get('join') || '') ? q.get('join') : null;
    const resetToken = /^[a-f0-9]{64}$/.test(q.get('reset') || '') ? q.get('reset') : null;
    const verifyToken = /^[a-f0-9]{64}$/.test(q.get('verify') || '') ? q.get('verify') : null;
    // a join link: what it's for (and its password, if it has one) before signing in
    const join = joinToken ? await openLink(joinToken) : null;
    if (joinToken && !join) return;
    if (join && join.kind !== 'join') return location.replace(location.pathname + '?view=' + joinToken);
    let me;
    try { me = await api('auth/me'); } catch (e) {
      document.body.innerHTML = `<div class="err-page"><div><h2>Can’t reach the server</h2><p>${e.message}. Check your connection and reload.</p></div></div>`;
      return;
    }
    if (initAnalytics(me.config.analytics, me.config.consent)) showConsentBanner(me.config.site);
    let fresh = false;   // signed in just now, from an invitation
    let restored = false;
    let authMessage = '';
    // back from Google (server/src/Google.php): ?google=signup|login|linked (&restored=1), or ?gerr=<why>; then tidy the address
    const google = q.get('google'), googleErr = q.get('gerr');
    if (google || googleErr) {
      if (q.get('restored')) restored = true;
      for (const k of ['google', 'gerr', 'restored']) q.delete(k);
      history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '') + location.hash);
      if (google === 'signup' || google === 'login') { fresh = true; track(google === 'signup' ? 'sign_up' : 'login', { method: 'google' }); }
      if (google === 'linked') toast('Google is connected. You can sign in with it from now on.');
      const msg = googleErr ? googleError(googleErr) : '';
      if (msg && me.user) toast(msg); else authMessage = msg;
    }
    if (resetToken) {
      const user = await showReset(resetToken);
      if (user.restored) restored = true;
      me = await api('auth/me');
      fresh = true;
      history.replaceState(null, '', location.pathname + location.hash);
    } else if (verifyToken) {
      try {
        const { email } = await api('auth/verify', { method: 'POST', body: { token: verifyToken } });
        if (me.user) toast('Email verified'); else authMessage = `Your email (${email}) is verified. Sign in to continue.`;
        me = await api('auth/me');
      } catch (e) { authMessage = e.message; }
      history.replaceState(null, '', location.pathname + location.hash);
    }
    if (!me.user) {
      let info = null;
      if (invite) try { info = { token: invite, ...await api('invites/' + invite) }; } catch {}
      const user = await showAuth({ signup: me.signup, invite: info?.status === 'pending' && !info.expired ? info : null,
                       join: join ? { ...join, token: joinToken, key: LINK.key } : null, config: me.config, message: authMessage, start: authPath });
      if (user?.restored) restored = true;
      me = await api('auth/me');
      fresh = true;
    }
    setUser(me.user);
    loadStyles(me.user.styles);
    loadFavorites(me.user.favorites);
    paintAvatar();
    refreshHelp();
    init_verify_banner(me.user, me.config);
    init_onboarding(me.user, me.config);
    setAnalyticsUser(me.user.id);
    trackAppEvents();
    if (restored) toast('Welcome back. Your account will not be deleted.');
    addEventListener('nk:signedout', () => location.reload(), { once: true });
    // which space to open: the one in the link, or your home workspace (the web clipper always saves there)
    const h = parseHash();
    setSPACE(!q.get('clip') && h?.space ? h.space : me.user.space);
    let err = null;
    try { await load(); } catch (e) { err = e; }
    if (err?.status === 404 && h?.space) {   // a shared board you can't open any more: show your home workspace
      toast('You don’t have access to that board');
      setSPACE(me.user.space);
      history.replaceState(null, '', location.pathname + location.search);
      err = null;
      try { await load(); } catch (e) { err = e; }
    }
    if (err) {
      console.error(err);
      if (err.status === 401) return location.reload();
      document.body.innerHTML = `<div class="err-page"><div><h2>Couldn’t load your boards</h2><p>${err.message}</p></div></div>`;
      return;
    }
    if (invite) setTimeout(() => inviteLanding(invite, fresh), 0);
    if (join) setTimeout(() => joinLanding(joinToken, join, fresh), 0);
  }
  const h = parseHash();
  setCur(h && S.boards[h.board] ? h.board : ROOT);
  render();
  document.body.classList.add('ready');
  if (!VIEW) { paintSpaceBtn(); refreshContexts(); dispatchEvent(new CustomEvent('nk:space')); routeAccount(); }
  if (!VIEW) {
    // web clipper: ?clip=<url>&t=<title>
    const q = new URLSearchParams(location.search);
    const clipUrl = q.get('clip');
    if (clipUrl && /^https?:\/\//i.test(clipUrl)) {
      const it = { id: uid(), board: '__unsorted', type: 'link', x: 0, y: 0, w: 280, z: 1, col: null, order: Date.now(), color: null, data: { url: clipUrl, title: (q.get('t') || '').slice(0, 200) } };
      S.items[it.id] = it;
      save();
      history.replaceState(null, '', location.pathname + location.hash);
      setPanel('unsorted'); renderPanel();
      toast('Saved to Unsorted');
      localStorage.setItem('nk:clipped', '1');
      setLink(it.id, clipUrl).then(() => { renderPanel(); if (window.opener) setTimeout(() => window.close(), 1800); });
    }
  }
})();
