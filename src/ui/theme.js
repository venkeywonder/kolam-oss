import { S, user } from '../core/store.js';
import { renderBoard } from '../canvas/render.js';
import { renderPanel } from './drawer.js';

/* ================= theme ================= */
export function getPref(k, d) { try { return localStorage.getItem('nk-' + k) ?? d; } catch { return d; } }
export function setPref(k, v) { try { localStorage.setItem('nk-' + k, v); } catch {} }
export const darkMQ = matchMedia('(prefers-color-scheme: dark)');
export function isDark() { return document.documentElement.dataset.theme === 'dark'; }
export function applyTheme() {
  const t = getPref('theme', 'system');
  document.documentElement.dataset.theme = t === 'dark' || (t === 'system' && darkMQ.matches) ? 'dark' : 'light';
}
export function setTheme(t) { setPref('theme', t); applyTheme(); if (S) { renderBoard(); renderPanel(); } }
export function inkCol(c) { return isDark() && c === '#1f1f24' ? '#ececf1' : c; }
export function lineCol(p) { return isDark() && p.k === 'dark' ? '#c9c9d1' : p.line; }
export const userName = () => user?.name || 'You';

export function init() {
  darkMQ.addEventListener('change', () => { applyTheme(); if (S) renderBoard(); });
  applyTheme();
}

