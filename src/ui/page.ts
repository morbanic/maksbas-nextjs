/**
 * The dashboard, as one HTML document.
 *
 * Inlined rather than bundled on purpose: a drop-in package cannot assume a
 * bundler config, a `public/` directory, or that the host app will let a script
 * tag reach a CDN. One document also means no asset route to authenticate.
 *
 * The client script deliberately uses no template literals, so this file can
 * stay a plain template literal without escaping every backtick in it.
 */
export function renderPage(adminPath: string): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Maksbas</title>
<style>${STYLES}</style>
</head>
<body>
<div id="root"></div>
<script>window.__MAKSBAS_BASE__ = ${JSON.stringify(adminPath)};</script>
<script>${SCRIPT}</script>
</body>
</html>`
}

const STYLES = /* css */ `
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --border: #e2e5ea;
  --text: #14181f;
  --muted: #6b7482;
  --accent: #2f6feb;
  --accent-text: #ffffff;
  --danger: #c8362c;
  --ok: #17794a;
  --warn: #9a6206;
  --chip: #eef1f5;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --panel: #171a20;
    --border: #272c35;
    --text: #e7eaef;
    --muted: #939cab;
    --accent: #4b86f5;
    --accent-text: #08111f;
    --danger: #f0776c;
    --ok: #5fd39b;
    --warn: #e3ac4b;
    --chip: #222732;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent); }
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 64px; }

header.top { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
.brand { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
.brand span { color: var(--muted); font-weight: 400; }
.spacer { flex: 1; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.stat .value { font-size: 22px; font-weight: 620; margin-top: 2px; font-variant-numeric: tabular-nums; }

nav.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
nav.tabs button {
  background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted);
  padding: 9px 14px; font: inherit; font-weight: 550; cursor: pointer; border-radius: 6px 6px 0 0;
}
nav.tabs button:hover { color: var(--text); }
nav.tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.panel + .panel { margin-top: 16px; }
.panel-head { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.panel-title { font-weight: 600; }
.panel-body { padding: 14px; }

.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

input, textarea, select, button { font: inherit; color: inherit; }
input[type="text"], input[type="password"], input[type="search"], textarea, select {
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; width: 100%;
}
textarea { resize: vertical; min-height: 84px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
label.field { display: block; margin-bottom: 12px; }
label.field > .label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 4px; font-weight: 550; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 640px) { .row { grid-template-columns: 1fr; } }

button.btn {
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 12px; cursor: pointer; font-weight: 550; white-space: nowrap;
}
button.btn:hover { border-color: var(--muted); }
button.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.btn.primary:hover { filter: brightness(1.06); }
button.btn.danger { color: var(--danger); }
button.btn:disabled { opacity: 0.55; cursor: not-allowed; }
button.link { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }

.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--chip); }
.badge.pending, .badge.sending, .badge.retrying { color: var(--warn); }
.badge.completed { color: var(--ok); }
.badge.failed { color: var(--danger); }
.badge.off { color: var(--muted); }

.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { background: var(--chip); border-radius: 6px; padding: 1px 7px; font-size: 12px; }
.chip b { font-weight: 600; }

.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.title-cell { font-weight: 600; }
.body-cell { color: var(--muted); font-size: 13px; }
.empty { padding: 36px 14px; text-align: center; color: var(--muted); }
.actions { display: flex; gap: 6px; justify-content: flex-end; }
.pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid var(--border); }

.toast {
  position: fixed; right: 16px; bottom: 16px; z-index: 40; max-width: 380px;
  background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 8px; padding: 10px 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.16);
}
.toast.error { border-left-color: var(--danger); }
.toast.ok { border-left-color: var(--ok); }

.modal-backdrop {
  position: fixed; inset: 0; background: rgba(8, 10, 14, 0.55); z-index: 30;
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; width: min(560px, 100%); max-height: 86vh; overflow: auto; }
.modal .panel-head { position: sticky; top: 0; background: var(--panel); }

.login { max-width: 340px; margin: 14vh auto 0; }
.login .panel-body { padding: 18px; }
.detail dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.detail dd { margin: 2px 0 12px; }
pre.json { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow: auto; font-size: 12.5px; margin: 0; }
`

const SCRIPT = /* js */ `
(function () {
  var BASE = window.__MAKSBAS_BASE__;
  var root = document.getElementById('root');

  var state = {
    ready: false,
    authed: false,
    tab: 'notifications',
    stats: null,
    notifications: { rows: [], total: 0, offset: 0, limit: 25 },
    devices: { rows: [], total: 0, offset: 0, limit: 25, q: '', status: 'all' },
    segments: [],
    modal: null,
    busy: false
  };

  // --- tiny DOM helper -------------------------------------------------------
  // Children arrive as text nodes, so every value out of the database is escaped
  // by construction rather than by remembering to escape it.
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // --- transport -------------------------------------------------------------
  function api(method, path, body) {
    var options = { method: method, headers: { 'x-maksbas-admin': '1' }, credentials: 'same-origin' };
    if (body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(BASE + path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (response.status === 401 && state.authed) {
          state.authed = false;
          render();
        }
        if (!response.ok) {
          var error = new Error((payload.error && payload.error.message) || 'Request failed');
          error.code = payload.error && payload.error.code;
          throw error;
        }
        return payload;
      });
    });
  }

  var toastTimer = null;
  function toast(message, kind) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var node = h('div', { class: 'toast ' + (kind || ''), text: message });
    document.body.appendChild(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.remove(); }, 4200);
  }

  function fail(error) { toast(error.message || String(error), 'error'); }

  // --- formatting ------------------------------------------------------------
  function when(value) {
    if (!value) return '—';
    var date = new Date(value);
    var diff = Date.now() - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return date.toLocaleDateString();
  }
  function shortId(id) { return String(id).slice(0, 8); }
  function truncate(value, max) {
    var text = String(value === null || value === undefined ? '' : value);
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  // --- shell -----------------------------------------------------------------
  function render() {
    clear(root);
    if (!state.ready) { root.appendChild(h('div', { class: 'wrap muted', text: 'Loading…' })); return; }
    root.appendChild(state.authed ? dashboard() : loginScreen());
    if (state.modal) root.appendChild(state.modal());
  }

  function loginScreen() {
    var input = h('input', { type: 'password', placeholder: 'Password', autofocus: true });
    var button = h('button', { class: 'btn primary', text: 'Sign in', type: 'submit' });

    var form = h('form', {
      onsubmit: function (event) {
        event.preventDefault();
        button.disabled = true;
        api('POST', '/session', { password: input.value })
          .then(function () { state.authed = true; return refreshAll(); })
          .then(render)
          .catch(function (error) { button.disabled = false; fail(error); });
      }
    }, [
      h('label', { class: 'field' }, [h('span', { class: 'label', text: 'Dashboard password' }), input]),
      button
    ]);

    return h('div', { class: 'wrap' }, [
      h('div', { class: 'login' }, [
        h('div', { class: 'panel' }, [
          h('div', { class: 'panel-head' }, [h('div', { class: 'panel-title', text: 'Maksbas' })]),
          h('div', { class: 'panel-body' }, [form])
        ])
      ])
    ]);
  }

  function dashboard() {
    return h('div', { class: 'wrap' }, [
      h('header', { class: 'top' }, [
        h('div', { class: 'brand' }, [document.createTextNode('Maksbas '), h('span', { text: 'push' })]),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', text: 'Refresh', onclick: function () { refreshAll().then(render).catch(fail); } }),
        h('button', {
          class: 'btn',
          text: 'Sign out',
          onclick: function () {
            api('DELETE', '/session').then(function () { state.authed = false; render(); }).catch(fail);
          }
        })
      ]),
      statsStrip(),
      h('nav', { class: 'tabs' }, [
        tabButton('notifications', 'Notifications'),
        tabButton('devices', 'Devices'),
        tabButton('compose', 'Send')
      ]),
      state.tab === 'notifications' ? notificationsPanel()
        : state.tab === 'devices' ? devicesPanel()
        : composePanel()
    ]);
  }

  function tabButton(id, label) {
    return h('button', {
      text: label,
      'aria-selected': state.tab === id ? 'true' : 'false',
      onclick: function () { state.tab = id; render(); }
    });
  }

  function statsStrip() {
    var stats = state.stats;
    if (!stats) return h('div');
    return h('div', { class: 'stats' }, [
      stat('Devices', stats.devices.total),
      stat('Active', stats.devices.active),
      stat('Notifications on', stats.devices.reachable),
      stat('Sends', stats.notifications.total),
      stat('In flight', stats.notifications.inFlight),
      stat('Messages delivered', stats.notifications.sent)
    ]);
  }

  function stat(label, value) {
    return h('div', { class: 'stat' }, [
      h('div', { class: 'label', text: label }),
      h('div', { class: 'value', text: String(value) })
    ]);
  }

  // --- notifications ---------------------------------------------------------
  function notificationsPanel() {
    var page = state.notifications;

    var rows = page.rows.map(function (item) {
      var unfinished = ['pending', 'sending', 'retrying'].indexOf(item.status) >= 0;
      return h('tr', {}, [
        h('td', {}, [
          h('div', { class: 'title-cell', text: item.title }),
          h('div', { class: 'body-cell', text: truncate(item.body, 90) })
        ]),
        h('td', {}, [h('span', { class: 'badge ' + item.status, text: item.status })]),
        h('td', { class: 'small muted', text: item.audience }),
        h('td', { class: 'num small' }, [
          document.createTextNode(item.sentCount + ' sent'),
          h('br'),
          h('span', { class: 'muted', text: item.failedCount + ' failed' })
        ]),
        h('td', { class: 'num small' }, [
          document.createTextNode(item.delivered + ' delivered'),
          h('br'),
          h('span', { class: 'muted', text: item.opened + ' opened' })
        ]),
        h('td', { class: 'num small muted', text: when(item.createdAt) }),
        h('td', {}, [
          h('div', { class: 'actions' }, [
            h('button', { class: 'btn', text: 'Details', onclick: function () { openNotification(item.id); } }),
            unfinished
              ? h('button', { class: 'btn', text: 'Resume', onclick: function (event) { resume(item.id, event.target); } })
              : h('button', { class: 'btn danger', text: 'Delete', onclick: function () { removeNotification(item); } })
          ])
        ])
      ]);
    });

    return h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('div', { class: 'panel-title', text: 'Sent notifications' }),
        h('div', { class: 'spacer' }),
        h('div', { class: 'small muted', text: page.total + ' total' })
      ]),
      page.rows.length === 0
        ? h('div', { class: 'empty', text: 'Nothing sent yet.' })
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'Message' }), h('th', { text: 'Status' }), h('th', { text: 'Audience' }),
              h('th', { text: 'Delivery' }), h('th', { text: 'Feedback' }), h('th', { text: 'Created' }), h('th', {})
            ])]),
            h('tbody', {}, rows)
          ]),
      pager(page, function (offset) {
        page.offset = offset;
        loadNotifications().then(render).catch(fail);
      })
    ]);
  }

  function openNotification(id) {
    api('GET', '/api/notifications/' + id).then(function (payload) {
      var item = payload.notification;
      state.modal = function () {
        return modal('Notification', [
          h('dl', { class: 'detail' }, [
            h('dt', { text: 'Title' }), h('dd', { text: item.title }),
            h('dt', { text: 'Body' }), h('dd', { text: item.body }),
            h('dt', { text: 'Status' }), h('dd', {}, [h('span', { class: 'badge ' + item.status, text: item.status })]),
            h('dt', { text: 'Audience' }), h('dd', { text: item.audience }),
            item.deeplink ? h('dt', { text: 'Deeplink' }) : null,
            item.deeplink ? h('dd', { class: 'mono', text: item.deeplink }) : null,
            item.image ? h('dt', { text: 'Image' }) : null,
            item.image ? h('dd', { class: 'mono', text: item.image }) : null,
            h('dt', { text: 'Numbers' }),
            h('dd', { text: item.sentCount + ' sent · ' + item.failedCount + ' failed · ' +
              item.delivered + ' delivered · ' + item.opened + ' opened · ' +
              item.pendingRetries + ' awaiting retry' }),
            h('dt', { text: 'Timeline' }),
            h('dd', { class: 'small' , text:
              'created ' + when(item.createdAt) +
              ' · started ' + when(item.startedAt) +
              ' · finished ' + when(item.completedAt) }),
            item.error ? h('dt', { text: 'Error' }) : null,
            item.error ? h('dd', { class: 'mono', text: item.error }) : null,
            item.filter ? h('dt', { text: 'Filter' }) : null,
            item.filter ? h('dd', {}, [h('pre', { class: 'json', text: JSON.stringify(item.filter, null, 2) })]) : null,
            item.data ? h('dt', { text: 'Data' }) : null,
            item.data ? h('dd', {}, [h('pre', { class: 'json', text: JSON.stringify(item.data, null, 2) })]) : null,
            h('dt', { text: 'Id' }), h('dd', { class: 'mono', text: item.id })
          ])
        ], []);
      };
      render();
    }).catch(fail);
  }

  function resume(id, button) {
    button.disabled = true;
    api('POST', '/api/notifications/' + id + '/resume')
      .then(function (payload) {
        toast('Sent ' + payload.report.sent + ' · ' + (payload.report.hasMore ? 'more to go' : 'finished'), 'ok');
        return refreshAll();
      })
      .then(render)
      .catch(function (error) { button.disabled = false; fail(error); });
  }

  function removeNotification(item) {
    confirmThen('Delete "' + truncate(item.title, 40) + '" and its delivery events?', function () {
      return api('DELETE', '/api/notifications/' + item.id).then(function () {
        toast('Deleted', 'ok');
        return refreshAll();
      });
    });
  }

  // --- devices ---------------------------------------------------------------
  function devicesPanel() {
    var page = state.devices;

    var search = h('input', {
      type: 'search', placeholder: 'Search id, token, model or attributes', value: page.q
    });
    search.addEventListener('input', function () {
      page.q = search.value;
      page.offset = 0;
      debounce(function () { loadDevices().then(render).catch(fail); });
    });

    var status = h('select', {
      onchange: function (event) {
        page.status = event.target.value;
        page.offset = 0;
        loadDevices().then(render).catch(fail);
      }
    }, ['all', 'active', 'inactive'].map(function (value) {
      return h('option', { value: value, selected: page.status === value, text: value });
    }));

    var rows = page.rows.map(function (device) {
      var attributes = Object.keys(device.attributes || {});
      return h('tr', {}, [
        h('td', {}, [
          h('div', { class: 'mono', text: shortId(device.id) }),
          h('div', { class: 'small muted', text: (device.deviceModel || device.platform || 'unknown') })
        ]),
        h('td', {}, [
          device.active
            ? h('span', { class: 'badge completed', text: 'active' })
            : h('span', { class: 'badge off', text: 'inactive' }),
          document.createTextNode(' '),
          device.notificationsEnabled
            ? h('span', { class: 'badge', text: 'push on' })
            : h('span', { class: 'badge off', text: 'push off' })
        ]),
        h('td', {}, [
          attributes.length === 0
            ? h('span', { class: 'muted small', text: 'no attributes' })
            : h('div', { class: 'chips' }, attributes.slice(0, 6).map(function (key) {
                return h('span', { class: 'chip' }, [
                  h('b', { text: key + ': ' }),
                  document.createTextNode(truncate(device.attributes[key], 24))
                ]);
              }).concat(attributes.length > 6 ? [h('span', { class: 'chip muted', text: '+' + (attributes.length - 6) })] : []))
        ]),
        h('td', { class: 'small muted' }, [
          document.createTextNode(device.appVersion || '—'),
          h('br'),
          h('span', { text: device.language || '' })
        ]),
        h('td', { class: 'num small muted', text: when(device.lastSeenAt) }),
        h('td', {}, [
          h('div', { class: 'actions' }, [
            h('button', { class: 'btn', text: 'Edit', onclick: function () { editDevice(device); } }),
            h('button', {
              class: 'btn',
              text: device.active ? 'Deactivate' : 'Activate',
              onclick: function (event) {
                event.target.disabled = true;
                api('PATCH', '/api/devices/' + device.id, { active: !device.active })
                  .then(function () { return refreshAll(); })
                  .then(render)
                  .catch(function (error) { event.target.disabled = false; fail(error); });
              }
            }),
            h('button', {
              class: 'btn danger', text: 'Delete',
              onclick: function () {
                confirmThen('Delete device ' + shortId(device.id) + '? Its attributes and events go with it.', function () {
                  return api('DELETE', '/api/devices/' + device.id).then(function () {
                    toast('Device deleted', 'ok');
                    return refreshAll();
                  });
                });
              }
            })
          ])
        ])
      ]);
    });

    return h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('div', { class: 'panel-title', text: 'Devices' }),
        h('div', { class: 'spacer' }),
        h('div', { class: 'toolbar' }, [
          h('div', { style: 'width:280px' }, [search]),
          h('div', { style: 'width:120px' }, [status]),
          h('div', { class: 'small muted', text: page.total + ' matching' })
        ])
      ]),
      page.rows.length === 0
        ? h('div', { class: 'empty', text: 'No devices match.' })
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'Device' }), h('th', { text: 'State' }), h('th', { text: 'Attributes' }),
              h('th', { text: 'App' }), h('th', { text: 'Last seen' }), h('th', {})
            ])]),
            h('tbody', {}, rows)
          ]),
      pager(page, function (offset) {
        page.offset = offset;
        loadDevices().then(render).catch(fail);
      })
    ]);
  }

  function editDevice(device) {
    var editor = h('textarea', { spellcheck: 'false' });
    editor.value = JSON.stringify(device.attributes || {}, null, 2);

    var save = h('button', {
      class: 'btn primary', text: 'Save attributes',
      onclick: function () {
        var parsed;
        try { parsed = JSON.parse(editor.value); }
        catch (error) { fail(new Error('Attributes must be valid JSON')); return; }

        save.disabled = true;
        api('PATCH', '/api/devices/' + device.id, { attributes: parsed })
          .then(function () {
            toast('Attributes saved', 'ok');
            state.modal = null;
            return refreshAll();
          })
          .then(render)
          .catch(function (error) { save.disabled = false; fail(error); });
      }
    });

    state.modal = function () {
      return modal('Device ' + shortId(device.id), [
        h('dl', { class: 'detail' }, [
          h('dt', { text: 'Id' }), h('dd', { class: 'mono', text: device.id }),
          h('dt', { text: 'FCM token' }), h('dd', { class: 'mono', text: device.fcmTokenPreview }),
          h('dt', { text: 'Platform' }), h('dd', { text: (device.platform || '—') + ' · ' + (device.osVersion || '—') }),
          h('dt', { text: 'App' }), h('dd', { text: (device.appVersion || '—') + ' · SDK ' + (device.sdkVersion || '—') }),
          h('dt', { text: 'Locale' }), h('dd', { text: (device.language || '—') + ' · ' + (device.timezone || '—') }),
          h('dt', { text: 'Registered' }), h('dd', { text: when(device.createdAt) })
        ]),
        h('label', { class: 'field' }, [
          h('span', { class: 'label', text: 'Attributes (JSON — values are stored as strings)' }),
          editor
        ])
      ], [save]);
    };
    render();
  }

  // --- compose ---------------------------------------------------------------
  var draft = { title: '', body: '', image: '', deeplink: '', data: '', audience: 'everyone', segment: '', filter: '' };

  function composePanel() {
    function field(key, label, placeholder, type) {
      var input = h(type === 'area' ? 'textarea' : 'input', {
        type: type === 'area' ? null : 'text',
        placeholder: placeholder,
        oninput: function (event) { draft[key] = event.target.value; }
      });
      input.value = draft[key];
      return h('label', { class: 'field' }, [h('span', { class: 'label', text: label }), input]);
    }

    var audiencePicker = h('select', {
      onchange: function (event) { draft.audience = event.target.value; render(); }
    }, [
      h('option', { value: 'everyone', selected: draft.audience === 'everyone', text: 'Everyone (all active devices)' }),
      h('option', { value: 'segment', selected: draft.audience === 'segment', text: 'Saved segment' }),
      h('option', { value: 'filter', selected: draft.audience === 'filter', text: 'Custom filter (JSON)' })
    ]);

    var segmentPicker = h('select', {
      onchange: function (event) { draft.segment = event.target.value; }
    }, [h('option', { value: '', text: state.segments.length ? 'Choose a segment…' : 'No saved segments' })].concat(
      state.segments.map(function (segment) {
        return h('option', { value: segment.name, selected: draft.segment === segment.name, text: segment.name });
      })
    ));

    var filterEditor = h('textarea', { spellcheck: 'false', placeholder: '{ "key": "plan", "op": "eq", "value": "pro" }',
      oninput: function (event) { draft.filter = event.target.value; } });
    filterEditor.value = draft.filter;

    var reach = h('span', { class: 'small muted', text: '' });

    var preview = h('button', {
      class: 'btn', text: 'Preview audience',
      onclick: function () {
        var payload;
        try { payload = audiencePayload(); }
        catch (error) { fail(error); return; }
        api('POST', '/api/audience', payload)
          .then(function (result) { reach.textContent = result.count + ' device(s) will receive this'; })
          .catch(fail);
      }
    });

    var send = h('button', {
      class: 'btn primary', text: 'Send now',
      onclick: function () {
        var body;
        try { body = sendPayload(); }
        catch (error) { fail(error); return; }

        send.disabled = true;
        api('POST', '/api/notifications', body)
          .then(function (payload) {
            toast('Queued — ' + payload.notification.sentCount + ' sent so far', 'ok');
            draft.title = ''; draft.body = ''; draft.image = ''; draft.deeplink = ''; draft.data = '';
            state.tab = 'notifications';
            return refreshAll();
          })
          .then(render)
          .catch(function (error) { send.disabled = false; fail(error); });
      }
    });

    return h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [h('div', { class: 'panel-title', text: 'Send a notification' })]),
      h('div', { class: 'panel-body' }, [
        field('title', 'Title', 'Popust 20%'),
        field('body', 'Body', 'Samo danas', 'area'),
        h('div', { class: 'row' }, [
          field('deeplink', 'Deeplink (optional)', 'app://promo/20'),
          field('image', 'Image URL (optional)', 'https://…')
        ]),
        field('data', 'Extra data (optional JSON)', '{ "campaign": "spring" }', 'area'),
        h('label', { class: 'field' }, [h('span', { class: 'label', text: 'Audience' }), audiencePicker]),
        draft.audience === 'segment'
          ? h('label', { class: 'field' }, [h('span', { class: 'label', text: 'Segment' }), segmentPicker])
          : null,
        draft.audience === 'filter'
          ? h('label', { class: 'field' }, [h('span', { class: 'label', text: 'Filter JSON' }), filterEditor])
          : null,
        h('div', { class: 'toolbar' }, [send, preview, reach])
      ])
    ]);
  }

  function audiencePayload() {
    if (draft.audience === 'segment') {
      if (!draft.segment) throw new Error('Choose a segment first');
      return { segment: draft.segment };
    }
    if (draft.audience === 'filter') {
      if (!draft.filter.trim()) throw new Error('Filter JSON is empty');
      return { filter: parseJson(draft.filter, 'Filter') };
    }
    return {};
  }

  function sendPayload() {
    if (!draft.title.trim()) throw new Error('Title is required');
    if (!draft.body.trim()) throw new Error('Body is required');

    var payload = { title: draft.title.trim(), body: draft.body.trim() };
    if (draft.deeplink.trim()) payload.deeplink = draft.deeplink.trim();
    if (draft.image.trim()) payload.image = draft.image.trim();
    if (draft.data.trim()) payload.data = parseJson(draft.data, 'Extra data');

    var audience = audiencePayload();
    if (audience.segment) payload.segment = audience.segment;
    if (audience.filter) payload.filter = audience.filter;
    return payload;
  }

  function parseJson(text, label) {
    try { return JSON.parse(text); }
    catch (error) { throw new Error(label + ' must be valid JSON'); }
  }

  // --- shared bits -----------------------------------------------------------
  function pager(page, go) {
    if (page.total <= page.limit) return h('div');
    var from = page.offset + 1;
    var to = Math.min(page.offset + page.limit, page.total);
    return h('div', { class: 'pager' }, [
      h('span', { class: 'small muted', text: from + '–' + to + ' of ' + page.total }),
      h('button', {
        class: 'btn', text: 'Previous', disabled: page.offset === 0,
        onclick: function () { go(Math.max(page.offset - page.limit, 0)); }
      }),
      h('button', {
        class: 'btn', text: 'Next', disabled: page.offset + page.limit >= page.total,
        onclick: function () { go(page.offset + page.limit); }
      })
    ]);
  }

  function modal(title, body, footer) {
    var backdrop = h('div', {
      class: 'modal-backdrop',
      onclick: function (event) { if (event.target === backdrop) { state.modal = null; render(); } }
    }, [
      h('div', { class: 'modal' }, [
        h('div', { class: 'panel-head' }, [
          h('div', { class: 'panel-title', text: title }),
          h('div', { class: 'spacer' }),
          h('button', { class: 'link', text: 'Close', onclick: function () { state.modal = null; render(); } })
        ]),
        h('div', { class: 'panel-body' }, body),
        footer && footer.length ? h('div', { class: 'panel-head', style: 'border-top:1px solid var(--border);border-bottom:0' }, footer) : null
      ])
    ]);
    return backdrop;
  }

  function confirmThen(question, run) {
    state.modal = function () {
      var go = h('button', {
        class: 'btn danger', text: 'Yes, do it',
        onclick: function () {
          go.disabled = true;
          run().then(function () { state.modal = null; render(); })
               .catch(function (error) { go.disabled = false; fail(error); });
        }
      });
      return modal('Are you sure?', [h('p', { text: question })], [
        go,
        h('button', { class: 'btn', text: 'Cancel', onclick: function () { state.modal = null; render(); } })
      ]);
    };
    render();
  }

  var debounceTimer = null;
  function debounce(run) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 220);
  }

  // --- loading ---------------------------------------------------------------
  function loadNotifications() {
    var page = state.notifications;
    return api('GET', '/api/notifications?limit=' + page.limit + '&offset=' + page.offset)
      .then(function (payload) {
        page.rows = payload.notifications;
        page.total = payload.total;
        // A page that emptied out from under us (deletes) would otherwise strand
        // the view past the end of the list.
        if (page.rows.length === 0 && page.offset > 0) {
          page.offset = Math.max(page.offset - page.limit, 0);
          return loadNotifications();
        }
      });
  }

  function loadDevices() {
    var page = state.devices;
    var query = '/api/devices?limit=' + page.limit + '&offset=' + page.offset +
      '&status=' + encodeURIComponent(page.status) + '&q=' + encodeURIComponent(page.q);
    return api('GET', query).then(function (payload) {
      page.rows = payload.devices;
      page.total = payload.total;
      if (page.rows.length === 0 && page.offset > 0) {
        page.offset = Math.max(page.offset - page.limit, 0);
        return loadDevices();
      }
    });
  }

  function refreshAll() {
    return Promise.all([
      api('GET', '/api/overview').then(function (payload) { state.stats = payload; }),
      loadNotifications(),
      loadDevices(),
      api('GET', '/api/segments').then(function (payload) { state.segments = payload.segments; })
    ]);
  }

  // --- boot ------------------------------------------------------------------
  api('GET', '/session')
    .then(function (payload) {
      state.authed = payload.authenticated;
      return state.authed ? refreshAll() : null;
    })
    .catch(function () { state.authed = false; })
    .then(function () { state.ready = true; render(); });
})();
`
