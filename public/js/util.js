export const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder: h('button.primary', { onclick }, 'Save') */
export function h(tag, attrs = {}, ...children) {
  if (attrs == null || attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export function wallClock(startedAt, ms) {
  if (!startedAt) return '';
  return new Date(new Date(startedAt).getTime() + ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Server headlines mark hits with ⟦ ⟧; escape everything, then turn markers into <mark>. */
export function headlineHtml(s) {
  return escapeHtml(s).replace(/⟦/g, '<mark>').replace(/⟧/g, '</mark>');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function editorName() {
  try { return localStorage.getItem('courtscribe.editor') || ''; } catch { return ''; }
}

export function setEditorName(name) {
  try { localStorage.setItem('courtscribe.editor', name); } catch {}
}

/** Stable per-tab id so a reloaded or reconnecting recorder can reclaim its slot. */
export function tabClientId() {
  try {
    let id = sessionStorage.getItem('courtscribe.client');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('courtscribe.client', id); }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const el = h(`div.toast.${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

export async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-editor': encodeURIComponent(editorName()), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
