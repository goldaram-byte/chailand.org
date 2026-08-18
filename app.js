/* ============================================================================
 * Чайлэнд · мост между демо-панелью (index.html) и реальным API (server/).
 * Подключается как обычный <script> и работает в общей области видимости с
 * inline-скриптом index.html, поэтому переиспользует его массивы (TARIFFS,
 * clients, sales, leads ...) и функции рендера (renderTariffs, renderClients ...).
 *
 * Возможности:
 *   • Экран входа (реальная авторизация, роли) — пункт 2
 *   • Гидрация UI живыми данными из БД (каталог, клиенты, продажи, воронка)
 *   • Онлайн-запись операций кассы в API + офлайн-очередь (IndexedDB) — пункт 3
 *   • Индикатор соединения и фоновая синхронизация
 *   • Если сервера нет (открыт как файл) — тихий демо-режим, ничего не ломается
 * ========================================================================== */
(function () {
  'use strict';

  var TOKEN_KEY = 'gab_token';
  var ME = null;
  var ONLINE = navigator.onLine;
  var SERVER = false; // доступен ли backend
  var DASH_USERS = []; // кассиры для фильтра дашборда

  /* ------------------------------ HTTP-клиент ----------------------------- */
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var t = localStorage.getItem(TOKEN_KEY);
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401) {
        logout();
        throw new Error('Не авторизован');
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        return j;
      });
    });
  }

  /* ------------------------------- Утилиты -------------------------------- */
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function mapMethod(m) { return m === 'cash' ? 'cash' : (m === 'bonus' ? 'online' : 'card'); }
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function val(id) { var e = document.getElementById(id); return e ? e.value : 'all'; }
  function setText(id, html) { var e = document.getElementById(id); if (e) e.innerHTML = html; }
  function stat(v, l, cls) { return '<div class="stat"><div class="sv ' + (cls || '') + '">' + v + '</div><div class="sl">' + l + '</div></div>'; }
  function fmtNum(n) { return typeof fmt === 'function' ? fmt(n) : n + ' ₽'; }
  function dmyLocal(s) { return String(s).split('-').reverse().join('.'); }

  function dashQuery() {
    var period = (typeof dashState !== 'undefined' && dashState.period) || '30';
    var params = [];
    var label;
    if (period === 'custom') {
      var from = val('dashFrom'), to = val('dashTo');
      if (from && to && from !== 'all' && to !== 'all') {
        if (from > to) { var t = from; from = to; to = t; }
        params.push('from=' + from, 'to=' + to);
        label = 'Период: ' + dmyLocal(from) + ' — ' + dmyLocal(to);
      } else { params.push('period=30'); label = 'Последние 30 дней'; }
    } else {
      params.push('period=' + period);
      label = period === 'today' ? 'Сегодня' : (period === '7' ? 'Последние 7 дней' : 'Последние 30 дней');
    }
    var g = val('dashGroup'), m = val('dashMethod'), c = val('dashCashier'), pos = val('dashPosition'), loc = val('dashLocation');
    if (g && g !== 'all') params.push('group_id=' + g);
    if (pos && pos !== 'all') params.push('item=' + encodeURIComponent(pos));
    if (m && m !== 'all') params.push('method=' + m);
    if (c && c !== 'all') params.push('cashier_id=' + c);
    if (loc && loc !== 'all') params.push('location_id=' + loc);
    return { query: '?' + params.join('&'), label: label };
  }

  /* ------------------------- Гидрация из API в UI ------------------------- */
  function mapSale(s) {
    return {
      id: s.id, serverId: s.id, uuid: s.client_uuid,
      time: fmtTime(s.created_at),
      items: (s.items || []).map(function (i) { return { name: i.name, qty: Number(i.qty), price: Number(i.price) }; }),
      client: s.client_name || '—',
      total: Number(s.total),
      method: mapMethod(s.method),
      paid: Number(s.cash_amount) + Number(s.card_amount),
      bonus: Number(s.bonus_used), earned: Number(s.bonus_earned),
      fd: s.fiscal && s.fiscal.fd_number ? 'ФД №' + String(s.fiscal.fd_number).padStart(6, '0') : '—',
      status: s.status === 'returned' ? 'refunded' : 'done',
    };
  }

  function hydrateAll() {
    return Promise.all([
      api('/catalog'),
      api('/settings'),
      api('/clients'),
      api('/crm/leads').catch(function () { return []; }),
      api('/pos/sales?limit=200').catch(function () { return []; }),
      api('/settings/acquiring').catch(function () { return null; }),
      api('/reports/cashiers').catch(function () { return []; }),
    ]).then(function (res) {
      var cat = res[0], settings = res[1], cl = res[2], ld = res[3], sl = res[4], acq = res[5];
      DASH_USERS = (res[6] || []).map(function (u) { return { id: u.id, name: u.full_name }; });

      GROUPS = cat.groups.map(function (g) { return { id: g.id, name: g.name }; });
      TARIFFS = cat.products.map(function (p) {
        return { id: p.id, pid: p.id, name: p.name, day: p.day_kind || 'any', price: Number(p.price), doc: p.requires_document, group: p.group_id, loc: p.location_id || null };
      });
      SERVICES = cat.services.map(function (s) { return { id: s.id, name: s.name, price: Number(s.price), options: '' }; });
      ROOMS = cat.rooms.map(function (r) { return { id: r.id, name: r.name, cap: r.capacity, price: 2000 }; });

      if (settings.cashback != null) CFG.cashback = Number(settings.cashback);
      if (settings.holidays) CFG.holidays = settings.holidays;
      // Фискализация: 'emulation' (по умолчанию) | 'shtrih' (печать на кассе через
      // локальный HTTP-драйвер Штрих-М) | 'taxcom' (облачный ОФД, печатает сервер).
      window.FISCAL_DRIVER = settings.fiscal_driver || 'emulation';
      window.SHTRIH_URL = settings.shtrih_url || 'http://localhost:5893';
      if (acq) { ACQUIRING.bank = acq.bank || '—'; ACQUIRING.mode = acq.mode; ACQUIRING.connected = !!acq.connected; ACQUIRING.tid = acq.terminal_id || ''; ACQUIRING.merchant = acq.merchant_id || ''; }

      clients = cl.map(function (c) {
        return { id: c.id, name: c.full_name, phone: c.phone || '', card: c.card_no || '', bonus: Number(c.bonus), buys: 0, app: !!c.app_installed, history: null, kids: null };
      });
      leads = (ld || []).map(mapLead);
      sales = (sl || []).filter(function (s) { return !s.is_return; }).map(mapSale);

      // Перерисовать всё, что зависит от данных
      safe(renderTariffs); safe(renderClients); safe(renderClientSlot); safe(renderCheck);
      safe(renderSales); safe(function () { if (typeof renderCrm === 'function') renderCrm(); });
      safe(function () { if (curPage === 'report') renderReport(); if (curPage === 'dash') renderDash(); });
      safe(function () { if (typeof renderPartyForm === 'function') renderPartyForm(); if (typeof renderBookings === 'function') renderBookings(); });
      safe(function () { if (typeof pollNewLeads === 'function') pollNewLeads(); });
      safe(function () { if (typeof loadLocations === 'function') loadLocations(); });
    });
  }

  var STAGE_MAP = { new: 'Новый лид', contact: 'В работе', booking: 'Записан', won: 'Купил', lost: 'Отказ' };
  var STAGE_REV = { 'Новый лид': 'new', 'В работе': 'contact', 'Записан': 'booking', 'Купил': 'won', 'Отказ': 'lost' };
  function stageRu(s) { return STAGE_MAP[s] || 'Новый лид'; }
  function mapLead(l) {
    return {
      id: l.id, name: l.name, phone: l.phone || '', source: l.source || '',
      // Заявку прячем из воронки только когда её закрыли как «Купил» и завели
      // в базу клиентов. Просто наличие client_id (заявка от зарегистрированного
      // клиента из приложения) НЕ повод её скрывать — иначе она не видна в доске.
      stage: stageRu(l.status), note: l.note || '', converted: !!l.client_id && l.status === 'won',
      client_id: l.client_id || null,
      tasks: (l.tasks || []).map(function (t) { return { id: t.id, text: t.title, done: t.done, due: t.due_date || '' }; }),
      notes: (l.notes || []).map(function (n) { return { id: n.id, text: n.text }; }),
      created: (l.created_at || '').slice(0, 10),
    };
  }
  // Освежить список воронки с сервера и перерисовать доску (без полного hydrateAll).
  // Нужно, чтобы новая заявка появлялась сразу по уведомлению и при открытии воронки.
  function refreshLeads() {
    if (!SERVER || !localStorage.getItem(TOKEN_KEY)) return Promise.resolve();
    return api('/crm/leads').then(function (ld) {
      leads = (ld || []).map(mapLead);
      if (typeof renderCrm === 'function') renderCrm();
    }).catch(function () {});
  }
  function safe(fn) { try { if (fn) fn(); } catch (e) { console.warn('[render]', e.message); } }

  /* --------------------- Офлайн-очередь (IndexedDB) ----------------------- */
  var idb = null;
  function openIDB() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open('gab-pos', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('outbox', { keyPath: 'uuid' }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function idbAll() {
    return new Promise(function (resolve) {
      if (!idb) return resolve([]);
      var tx = idb.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      tx.onsuccess = function () { resolve(tx.result || []); };
      tx.onerror = function () { resolve([]); };
    });
  }
  function idbPut(op) {
    return new Promise(function (resolve) {
      if (!idb) return resolve();
      var tx = idb.transaction('outbox', 'readwrite').objectStore('outbox').put(op);
      tx.onsuccess = function () { resolve(); }; tx.onerror = function () { resolve(); };
    });
  }
  function idbDel(id) {
    return new Promise(function (resolve) {
      if (!idb) return resolve();
      var tx = idb.transaction('outbox', 'readwrite').objectStore('outbox').delete(id);
      tx.onsuccess = function () { resolve(); }; tx.onerror = function () { resolve(); };
    });
  }

  function enqueue(op) {
    return idbPut(op).then(function () { updatePill(); flush(); });
  }

  var flushing = false;
  function flush() {
    if (flushing || !ONLINE || !SERVER) return Promise.resolve();
    flushing = true;
    return idbAll().then(function (ops) {
      if (!ops.length) { flushing = false; return; }
      return api('/sync', { method: 'POST', body: { ops: ops } }).then(function (resp) {
        var results = resp.results || [];
        var done = results.filter(function (r) { return r.status === 'ok'; });
        return Promise.all(done.map(function (r) { return idbDel(r.client_uuid); })).then(function () {
          flushing = false; updatePill();
          // Подтянуть серверную правду после успешной отправки
          if (done.length) hydrateAll().catch(function () {});
        });
      }).catch(function () { flushing = false; updatePill(); });
    }).catch(function () { flushing = false; });
  }

  /* ------------------------- Индикатор соединения ------------------------- */
  function updatePill() {
    var pill = document.getElementById('gabPill');
    if (!pill) return;
    idbAll().then(function (ops) {
      var n = ops.length;
      if (!SERVER) { pill.innerHTML = '🟠 Демо-режим'; pill.className = 'gab-pill demo'; return; }
      if (!ONLINE) { pill.innerHTML = '🔴 Офлайн' + (n ? ' · ' + n + ' в очереди' : ''); pill.className = 'gab-pill off'; }
      else if (n) { pill.innerHTML = '🟡 Синхронизация · ' + n; pill.className = 'gab-pill sync'; }
      else { pill.innerHTML = '🟢 Онлайн' + (ME ? ' · ' + ME.name : ''); pill.className = 'gab-pill on'; }
    });
  }

  /* ------------------------------ Экран входа ----------------------------- */
  function showLogin() {
    var ov = document.getElementById('gabLogin');
    if (ov) { ov.style.display = 'flex'; return; }
    ov = document.createElement('div');
    ov.id = 'gabLogin';
    ov.className = 'gab-login';
    ov.innerHTML =
      '<div class="gl-card">' +
      '  <img class="gl-logo-img" src="/logo.png" alt="Чайлэнд" style="width:210px;max-width:72%;height:auto;display:block;margin:0 auto 8px">' +
      '  <div class="gl-sub">Админ-панель парка · вход для сотрудников</div>' +
      '  <input id="glLogin" placeholder="Логин" autocomplete="username">' +
      '  <input id="glPass" type="password" placeholder="Пароль" autocomplete="current-password">' +
      '  <div id="glErr" class="gl-err"></div>' +
      '  <button id="glBtn" class="gl-btn">Войти</button>' +
      '  <div class="gl-hint">Демо-доступы: owner / admin / cashier · пароль *123</div>' +
      '  <button id="glDemo" class="gl-demo">Продолжить в демо-режиме</button>' +
      '</div>';
    document.body.appendChild(ov);
    document.getElementById('glBtn').onclick = doLogin;
    document.getElementById('glDemo').onclick = function () { ov.style.display = 'none'; SERVER = false; updatePill(); };
    document.getElementById('glPass').onkeydown = function (e) { if (e.key === 'Enter') doLogin(); };
    document.getElementById('glLogin').focus();
  }

  function doLogin() {
    var login = document.getElementById('glLogin').value.trim();
    var pass = document.getElementById('glPass').value;
    var err = document.getElementById('glErr');
    err.textContent = '';
    if (!login || !pass) { err.textContent = 'Введите логин и пароль'; return; }
    api('/auth/login', { method: 'POST', body: { login: login, password: pass } }).then(function (r) {
      localStorage.setItem(TOKEN_KEY, r.token);
      ME = r.user;
      document.getElementById('gabLogin').style.display = 'none';
      applyRole();
      return hydrateAll();
    }).then(function () {
      updatePill(); flush(); markLive();
      if (typeof toast === 'function') toast('Вход выполнен: ' + ME.name + ' (' + (ME.roleName || ME.role) + ')');
    }).catch(function (e) { err.textContent = e.message || 'Ошибка входа'; });
  }

  function applyRole() {
    // Синхронизировать роль/навигацию демо с ролью с сервера
    if (typeof setRole === 'function' && ME) {
      try { setRole(ME.role); } catch (e) {}
      // Подставить реальное имя сотрудника
      var pn = document.getElementById('profName'); if (pn) pn.textContent = ME.name;
      var pr = document.getElementById('profRole'); if (pr) pr.textContent = ME.roleName || ME.role;
      // Вкладка «Сотрудники» в настройках — только для владельца
      var ts = document.getElementById('tabStaff'); if (ts) ts.style.display = ME.role === 'owner' ? '' : 'none';
      // Скрыть демо-переключатель ролей (в реальной системе роль задаётся входом)
      var pm = document.getElementById('profMenu'); if (pm) {
        var hint = pm.querySelector('.pm-hint');
        pm.querySelectorAll('button').forEach(function (b) { if (/setRole/.test(b.getAttribute('onclick') || '')) b.style.display = 'none'; });
        var out = document.createElement('button'); out.textContent = '🚪 Выйти'; out.onclick = logout; pm.appendChild(out);
      }
    }
  }

  function markLive() {
    var badge = document.getElementById('demoBadge');
    if (badge) { badge.textContent = '● Данные с сервера · PostgreSQL'; badge.style.color = '#065f46'; }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY); ME = null;
    updatePill();
    if (SERVER) showLogin();
  }

  /* -------------------- Перехват операций кассы -> API -------------------- */
  function wrap(name, before) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      if (SERVER) { try { before.apply(null, arguments); } catch (e) { console.warn('[' + name + ']', e.message); } }
      return orig.apply(this, arguments);
    };
  }

  var ROLE_RU = { owner: 'Владелец', admin: 'Администратор', cashier: 'Кассир' };

  function installStaff() {
    // Показать список сотрудников в настройках → «Сотрудники» (только владелец)
    window.staffRender = function () {
      if (!SERVER) return;
      api('/users').then(function (list) {
        var tb = document.getElementById('setStaff');
        if (!tb) return;
        tb.innerHTML = (list || []).map(function (u) {
          return '<tr><td>' + u.full_name + '</td><td><b>' + u.login + '</b></td>' +
            '<td>' + (ROLE_RU[u.role_code] || u.role_code) + '</td>' +
            '<td>' + (u.is_active ? '<span style="color:var(--green);font-weight:700">активен</span>' : '<span class="muted">отключён</span>') + '</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="staffPass(' + u.id + ')">Пароль</button> ' +
            '<button class="btn btn-ghost btn-sm" onclick="staffToggle(' + u.id + ',' + (u.is_active ? 'false' : 'true') + ')">' + (u.is_active ? 'Отключить' : 'Включить') + '</button></td></tr>';
        }).join('') || '<tr><td colspan="5" class="muted">Пока нет сотрудников</td></tr>';
      }).catch(function () {
        var tb = document.getElementById('setStaff');
        if (tb) tb.innerHTML = '<tr><td colspan="5" class="muted">Доступно только владельцу</td></tr>';
      });
    };

    window.staffAdd = function () {
      var name = (document.getElementById('stName') || {}).value || '';
      var login = (document.getElementById('stLogin') || {}).value || '';
      var pass = (document.getElementById('stPass') || {}).value || '';
      var role = (document.getElementById('stRole') || {}).value || 'cashier';
      if (!name.trim() || !login.trim() || !pass) { if (typeof toast === 'function') toast('Заполните имя, логин и пароль', true); return; }
      api('/users', { method: 'POST', body: { full_name: name.trim(), login: login.trim(), password: pass, role_code: role } })
        .then(function () {
          document.getElementById('stName').value = ''; document.getElementById('stLogin').value = ''; document.getElementById('stPass').value = '';
          if (typeof toast === 'function') toast('Сотрудник добавлен: ' + login.trim());
          window.staffRender();
        })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };

    window.staffPass = function (id) {
      var p = prompt('Новый пароль для сотрудника:');
      if (!p) return;
      api('/users/' + id, { method: 'PUT', body: { password: p } })
        .then(function () { if (typeof toast === 'function') toast('Пароль изменён'); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };

    window.staffToggle = function (id, active) {
      api('/users/' + id, { method: 'PUT', body: { is_active: active } })
        .then(function () { window.staffRender(); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };

  }

  function installExtras() {
    var STAGES = ['Новый лид', 'В работе', 'Записан', 'Купил', 'Отказ'];
    var STAGE_CODE = { 'Новый лид': 'new', 'В работе': 'contact', 'Записан': 'booking', 'Купил': 'won', 'Отказ': 'lost' };
    var rc = function () { if (typeof renderCrm === 'function') renderCrm(); };
    var findLead = function (id) { return leads.find(function (x) { return x.id === id; }); };

    // --- Воронка: операции через сервер ---
    window.moveLead = function (id, dir) {
      var l = findLead(id); if (!l || l.converted) return;
      var i = STAGES.indexOf(l.stage) + dir; if (i < 0 || i >= STAGES.length) return;
      l.stage = STAGES[i]; rc();
      if (SERVER) api('/crm/leads/' + id, { method: 'PUT', body: { status: STAGE_CODE[l.stage] } }).catch(function () {});
    };
    window.closeOrder = function (id) {
      var l = findLead(id); if (!l) return;
      l.stage = 'Купил'; rc(); if (typeof toast === 'function') toast('Заказ закрыт — «Купил»');
      if (SERVER) api('/crm/leads/' + id, { method: 'PUT', body: { status: 'won' } }).catch(function () {});
    };
    window.addLeadTask = function (id) {
      var l = findLead(id); if (!l) return;
      var text = (document.getElementById('lt-' + id) || {}).value || '';
      var due = (document.getElementById('ltd-' + id) || {}).value || '';
      if (!text.trim()) { if (typeof toast === 'function') toast('Введите текст задачи', true); return; }
      if (SERVER) {
        api('/crm/leads/' + id + '/tasks', { method: 'POST', body: { title: text.trim(), due_date: due || null } })
          .then(function (t) { (l.tasks = l.tasks || []).push({ id: t.id, text: t.title, done: false, due: t.due_date || '' }); rc(); })
          .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
      } else { (l.tasks = l.tasks || []).push({ text: text.trim(), done: false, due: due }); rc(); }
    };
    window.toggleLeadTask = function (id, i) {
      var l = findLead(id); if (!l || !l.tasks[i]) return;
      l.tasks[i].done = !l.tasks[i].done; rc();
      var t = l.tasks[i];
      if (SERVER && t.id) api('/crm/tasks/' + t.id, { method: 'PUT', body: { done: t.done } }).catch(function () {});
    };
    window.addLeadNote = function (id) {
      var l = findLead(id); if (!l) return;
      var el = document.getElementById('ln-' + id); var text = el ? el.value : '';
      if (!text || !text.trim()) return;
      if (SERVER) {
        api('/crm/leads/' + id + '/notes', { method: 'POST', body: { text: text.trim() } })
          .then(function (n) { (l.notes = l.notes || []).unshift({ id: n.id, text: n.text }); if (el) el.value = ''; rc(); })
          .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
      } else { (l.notes = l.notes || []).push({ text: text.trim() }); if (el) el.value = ''; rc(); }
    };
    window.convertLead = function (id) {
      var l = findLead(id); if (!l) return;
      if (!confirm('Перенести лида «' + l.name + '» в базу клиентов и выдать карту?')) return;
      if (SERVER) {
        api('/crm/leads/' + id + '/convert', { method: 'POST', body: {} })
          .then(function (c) { l.converted = true; rc(); if (typeof toast === 'function') toast('Лид перенесён · карта ' + (c.card_no || '')); hydrateAll().catch(function () {}); })
          .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
      } else { l.converted = true; rc(); }
    };

    // --- Настройки: реферальная программа ---
    window.saveReferral = function () {
      var body = {
        referral_enabled: (document.getElementById('refEnabled') || {}).value === 'true',
        referral_referrer_percent: Number((document.getElementById('refReferrer') || {}).value || 0),
        referral_referee_bonus: Number((document.getElementById('refReferee') || {}).value || 0),
      };
      api('/settings', { method: 'PUT', body: body })
        .then(function () { if (typeof toast === 'function') toast('Реферальная программа сохранена'); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    function loadReferral() {
      if (!SERVER) return;
      api('/settings').then(function (s) {
        var e = document.getElementById('refEnabled'); if (e) e.value = (s.referral_enabled === true || s.referral_enabled === 'true') ? 'true' : 'false';
        var r = document.getElementById('refReferrer'); if (r) r.value = s.referral_referrer_percent != null ? s.referral_referrer_percent : 10;
        var f = document.getElementById('refReferee'); if (f) f.value = s.referral_referee_bonus != null ? s.referral_referee_bonus : 100;
      }).catch(function () {});
    }

    // --- Настройки: KPI кассиров ---
    window.saveKpi = function () {
      var body = { kpi_targets: {
        revenue: Number((document.getElementById('kpiRevenue') || {}).value || 0),
        checks: Number((document.getElementById('kpiChecks') || {}).value || 0),
        avg_check: Number((document.getElementById('kpiAvg') || {}).value || 0),
      } };
      api('/settings', { method: 'PUT', body: body })
        .then(function () { if (typeof toast === 'function') toast('Цели KPI сохранены'); window.loadKpi('month'); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    window.loadKpi = function (period) {
      if (!SERVER) return;
      api('/reports/kpi?period=' + (period || 'month')).then(function (r) {
        var t = r.targets || {};
        var rv = document.getElementById('kpiRevenue'); if (rv && !rv.value) rv.value = t.revenue || 0;
        var ck = document.getElementById('kpiChecks'); if (ck && !ck.value) ck.value = t.checks || 0;
        var av = document.getElementById('kpiAvg'); if (av && !av.value) av.value = t.avg_check || 0;
        var tb = document.getElementById('kpiTable'); if (!tb) return;
        function money(val, target) { var ok = target && val >= target; return '<td' + (ok ? ' style="color:var(--green);font-weight:700"' : '') + '>' + fmtNum(val) + (target ? ' <span class="muted" style="font-size:11px">/ ' + fmtNum(target) + '</span>' : '') + '</td>'; }
        function num(val, target) { var ok = target && val >= target; return '<td' + (ok ? ' style="color:var(--green);font-weight:700"' : '') + '>' + val + (target ? ' <span class="muted" style="font-size:11px">/ ' + target + '</span>' : '') + '</td>'; }
        tb.innerHTML = (r.staff || []).map(function (s) {
          return '<tr><td>' + s.name + '</td>' + money(s.revenue, t.revenue) + num(s.checks, t.checks) + money(s.avg_check, t.avg_check) + '<td>' + s.returns + '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="muted">Нет данных</td></tr>';
      }).catch(function () {});
    };

    // --- Вкладка «Товары» ---
    function eH(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    window.renderProducts = function () {
      var tb = document.getElementById('setProducts');
      if (!SERVER) { if (tb) tb.innerHTML = '<tr><td colspan="4" class="muted">Доступно при работе с сервером</td></tr>'; return; }
      api('/catalog').then(function (c) {
        var groups = c.groups || [], products = c.products || [];
        var gname = {}; groups.forEach(function (g) { gname[g.id] = g.name; });
        var sel = document.getElementById('pdGroup');
        if (sel) sel.innerHTML = groups.map(function (g) { return '<option value="' + g.id + '">' + eH(g.name) + '</option>'; }).join('');
        var locOpts = function (cur) {
          return '<option value="">Все ТЦ</option>' + LOCS.map(function (l) {
            return '<option value="' + l.id + '"' + (Number(cur) === l.id ? ' selected' : '') + '>' + eH(l.name) + '</option>';
          }).join('');
        };
        var pdLoc = document.getElementById('pdLoc');
        if (pdLoc) pdLoc.innerHTML = locOpts(null);
        if (!tb) return;
        tb.innerHTML = products.map(function (p) {
          return '<tr>' +
            '<td>' + eH(p.name) + '</td>' +
            '<td>' + eH(gname[p.group_id] || '—') + '</td>' +
            '<td><input type="number" value="' + Number(p.price) + '" style="width:96px" onchange="editProductPrice(' + p.id + ',this.value)"></td>' +
            '<td><select onchange="editProductLoc(' + p.id + ',this.value)" style="width:120px">' + locOpts(p.location_id) + '</select></td>' +
            '<td><button class="btn btn-ghost btn-sm" onclick="delProduct(' + p.id + ')">Удалить</button></td>' +
            '</tr>';
        }).join('') || '<tr><td colspan="5" class="muted">Пока нет товаров</td></tr>';
      }).catch(function () {});
    };
    window.addProduct = function () {
      var g = document.getElementById('pdGroup'), n = document.getElementById('pdName'), p = document.getElementById('pdPrice'), lc = document.getElementById('pdLoc');
      if (!n || !n.value.trim()) { if (n) n.focus(); return; }
      api('/catalog/products', { method: 'POST', body: { group_id: +g.value || null, name: n.value.trim(), price: +p.value || 0, location_id: (lc && lc.value) ? +lc.value : null } })
        .then(function () { n.value = ''; p.value = ''; window.renderProducts(); if (typeof toast === 'function') toast('Товар добавлен'); hydrateAll().catch(function () {}); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    window.editProductPrice = function (id, val) {
      api('/catalog/products/' + id, { method: 'PUT', body: { price: +val || 0 } })
        .then(function () { if (typeof toast === 'function') toast('Цена обновлена'); hydrateAll().catch(function () {}); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    window.editProductLoc = function (id, val) {
      api('/catalog/products/' + id, { method: 'PUT', body: { location_id: val ? +val : null } })
        .then(function () { if (typeof toast === 'function') toast('ТЦ товара обновлён'); hydrateAll().catch(function () {}); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    window.delProduct = function (id) {
      api('/catalog/products/' + id, { method: 'DELETE' })
        .then(function () { window.renderProducts(); hydrateAll().catch(function () {}); })
        .catch(function () {});
    };

    // --- Подгрузка данных при переключении вкладок настроек ---
    var _setTab = window.setTab;
    if (typeof _setTab === 'function') {
      window.setTab = function (name) {
        var r = _setTab.apply(this, arguments);
        if (name === 'staff' && window.staffRender) window.staffRender();
        if (name === 'referral') loadReferral();
        if (name === 'kpi') window.loadKpi('month');
        if (name === 'products') window.renderProducts();
        return r;
      };
    }
  }

  /* ---------------------- Фильтр в разделе «Клиенты» --------------------- */
  function elv(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function mapCli(c) {
    return {
      id: c.id, name: c.full_name, phone: c.phone || '', card: c.card_no || '',
      bonus: Number(c.bonus), buys: Number(c.buys || 0), app: !!c.app_installed,
      history: null, kids: null, kidBdayIn: c.kid_bday_in,
    };
  }

  function installTasks() {
    injectTaskStyles();

    // ---------- фильтр в разделе «Клиенты» ----------
    var _rc = window.renderClients;
    window.renderClients = function () {
      if (typeof _rc === 'function') _rc.apply(this, arguments);
      ensureClientFilter();
    };

    function ensureClientFilter() {
      if (!SERVER) return;
      var tbl = document.getElementById('cliTbl');
      if (!tbl) return;
      var card = tbl.closest('.card');
      if (!card || document.getElementById('cliFilter')) return;
      var bar = document.createElement('div');
      bar.id = 'cliFilter';
      bar.className = 'gab-filter';
      bar.innerHTML =
        '<input id="cfSearch" placeholder="🔍 Имя, телефон, карта">' +
        '<select id="cfApp"><option value="">Приложение: все</option><option value="1">С приложением</option><option value="0">Без приложения</option></select>' +
        '<select id="cfBonus"><option value="">Бонусы: любые</option><option value="100">от 100</option><option value="300">от 300</option><option value="500">от 500</option></select>' +
        '<select id="cfBuys"><option value="">Покупки: любые</option><option value="1">от 1</option><option value="5">от 5</option><option value="10">от 10</option></select>' +
        '<select id="cfBday"><option value="">ДР ребёнка: неважно</option><option value="7">ближайшие 7 дней</option><option value="14">14 дней</option><option value="30">30 дней</option></select>' +
        '<select id="cfRef"><option value="">Рефералы: все</option><option value="invited">Пригласившие</option><option value="referred">Приглашённые</option></select>' +
        '<button class="btn btn-ghost btn-sm" id="cfReset">Сброс</button>' +
        '<span id="cfCount" class="muted"></span>';
      var anchor = card.querySelector('.tbl-wrap');
      card.insertBefore(bar, anchor);
      var t = null;
      function deb() { clearTimeout(t); t = setTimeout(applyClientFilter, 250); }
      document.getElementById('cfSearch').addEventListener('input', deb);
      ['cfApp', 'cfBonus', 'cfBuys', 'cfBday', 'cfRef'].forEach(function (id) {
        document.getElementById(id).addEventListener('change', applyClientFilter);
      });
      document.getElementById('cfReset').addEventListener('click', function () {
        ['cfSearch', 'cfApp', 'cfBonus', 'cfBuys', 'cfBday', 'cfRef'].forEach(function (id) { document.getElementById(id).value = ''; });
        applyClientFilter();
      });
    }

    function applyClientFilter() {
      if (!SERVER) return;
      var qs = [];
      var m = { search: elv('cfSearch'), app: elv('cfApp'), min_bonus: elv('cfBonus'), min_buys: elv('cfBuys'), bday_days: elv('cfBday'), referral: elv('cfRef') };
      Object.keys(m).forEach(function (k) { if (m[k]) qs.push(k + '=' + encodeURIComponent(m[k])); });
      api('/clients' + (qs.length ? '?' + qs.join('&') : '')).then(function (cl) {
        clients = cl.map(mapCli);
        if (typeof _rc === 'function') _rc();
        var c = document.getElementById('cfCount'); if (c) c.textContent = 'Найдено: ' + cl.length;
      }).catch(function () {});
    }

    // отрисовать фильтр сразу, если страница уже в DOM
    ensureClientFilter();
  }

  function injectTaskStyles() {
    if (document.getElementById('gabFilterCss')) return;
    var st = document.createElement('style');
    st.id = 'gabFilterCss';
    st.textContent =
      '.gab-filter{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}' +
      '.gab-filter input,.gab-filter select{padding:7px 10px;border:1px solid #cbd5e1;border-radius:9px;font-size:13px}' +
      '.gab-filter #cfSearch{min-width:200px;flex:1}' +
      '.skud-status{display:flex;flex-wrap:wrap;gap:8px}' +
      '.skud-chip{display:inline-flex;align-items:center;gap:6px;background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:12px;padding:6px 12px;font-size:13px;font-weight:600}' +
      '.skud-chip small{color:#059669;font-weight:500}' +
      '.nav-badge{display:inline-block;min-width:18px;height:18px;line-height:18px;padding:0 5px;margin-left:auto;' +
      'background:#dc2626;color:#fff;border-radius:9px;font-size:11px;font-weight:800;text-align:center}' +
      '.nav-badge.pulse{animation:navpulse 1s ease-in-out 3}' +
      '@keyframes navpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.35);box-shadow:0 0 0 4px rgba(220,38,38,.25)}}';
    document.head.appendChild(st);
  }

  /* ------------- Уведомление о новых заявках (бейдж + звук) -------------- */
  var newLeadsCount = 0, lastLeadId = 0, newLeadsInit = false, leadAudioCtx = null, leadAlertsOn = false;

  function ensureAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null;
      if (!leadAudioCtx) leadAudioCtx = new Ctx();
      if (leadAudioCtx.state === 'suspended') leadAudioCtx.resume();
      return leadAudioCtx;
    } catch (e) { return null; }
  }

  // Заметный сигнал «динь-динь-динь» — восходящее трезвучие A5·D6·G6, дважды.
  function leadChime() {
    var ctx = ensureAudio(); if (!ctx) return;
    try {
      var notes = [880, 1174.66, 1567.98];
      for (var rep = 0; rep < 2; rep++) {
        var base = ctx.currentTime + rep * 0.55;
        notes.forEach(function (f, i) {
          var at = base + i * 0.14;
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'triangle'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
          o.connect(g); g.connect(ctx.destination);
          o.start(at); o.stop(at + 0.26);
        });
      }
    } catch (e) {}
  }

  function updateCrmBadge() {
    var btns = document.querySelectorAll('#navMain button, #navBottom button');
    btns.forEach(function (b) {
      if (!/go\('crm'\)/.test(b.getAttribute('onclick') || '')) return;
      var badge = b.querySelector('.nav-badge');
      if (newLeadsCount > 0) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; b.appendChild(badge); }
        badge.textContent = newLeadsCount > 99 ? '99+' : String(newLeadsCount);
        badge.style.display = '';
      } else if (badge) { badge.style.display = 'none'; }
    });
  }

  function pulseCrmBadge() {
    var badge = document.querySelector('#navMain .nav-badge, #navBottom .nav-badge');
    if (!badge) return;
    badge.classList.remove('pulse'); void badge.offsetWidth; badge.classList.add('pulse');
  }

  function pollNewLeads() {
    // Не дёргаем до входа (нет токена) — иначе 401 сбросит сессию.
    if (!SERVER || !localStorage.getItem(TOKEN_KEY)) return;
    api('/crm/leads/new-count').then(function (r) {
      var n = r.count || 0, lid = r.last_id || 0;
      // Звук — именно на НОВУЮ заявку (появился лид с бо́льшим id),
      // а не на изменение статусов внутри воронки.
      if (newLeadsInit && lid > lastLeadId) {
        leadChime(); pulseCrmBadge();
        if (typeof toast === 'function') toast('🔔 Новая заявка в воронке!');
        // Подтянуть новую заявку в доску сразу (иначе видно только бейдж).
        refreshLeads();
      }
      newLeadsCount = n;
      lastLeadId = Math.max(lastLeadId, lid);
      newLeadsInit = true;
      updateCrmBadge();
    }).catch(function () {});
  }

  function installLeadAlerts() {
    if (leadAlertsOn) return;
    leadAlertsOn = true;
    // бейдж переживает перерисовку меню
    var _rn = window.renderNav;
    window.renderNav = function () { if (typeof _rn === 'function') _rn.apply(this, arguments); updateCrmBadge(); };
    // При открытии воронки — подтянуть свежие заявки с сервера.
    var _go = window.go;
    if (typeof _go === 'function') {
      window.go = function (p) { var r = _go.apply(this, arguments); if (p === 'crm') refreshLeads(); return r; };
    }
    // Разблокировать звук при первом действии пользователя (политика автоплея браузера).
    var unlock = function () { ensureAudio(); document.removeEventListener('click', unlock); document.removeEventListener('keydown', unlock); };
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
    pollNewLeads();
    setInterval(pollNewLeads, 15000);
  }

  /* ----------------------- СКУД / Табель персонала ---------------------- */
  function installSkud() {
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function fmtT(iso) { try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

    function renderStatusBox(st) {
      var box = document.getElementById('skudStatus'); if (!box) return;
      var on = (st || []).filter(function (p) { return p.on_shift; });
      box.innerHTML = on.length
        ? on.map(function (p) { return '<span class="skud-chip">🟢 ' + esc(p.full_name) + (p.position ? ' · ' + esc(p.position) : '') + ' <small>с ' + fmtT(p.last_at) + '</small></span>'; }).join('')
        : '<div class="muted">Сейчас никого нет на смене</div>';
    }

    function renderPersonnel(list, st) {
      var onById = {}; (st || []).forEach(function (s) { onById[s.id] = s.on_shift; });
      var tb = document.getElementById('skudPersonnel'); if (!tb) return;
      tb.innerHTML = (list || []).map(function (p) {
        var on = onById[p.id];
        var status = !p.active ? '<span class="muted">отключён</span>'
          : (on ? '<span style="color:var(--green,#059669);font-weight:700">на смене</span>' : '<span class="muted">не на смене</span>');
        return '<tr>' +
          '<td>' + esc(p.full_name) + '</td>' +
          '<td>' + esc(p.position || '—') + '</td>' +
          '<td><input value="' + esc(p.fingerprint_id || '') + '" placeholder="—" style="width:130px" onchange="skudSetFp(' + p.id + ',this.value)"></td>' +
          '<td><input type="number" min="0" value="' + Number(p.hourly_rate || 0) + '" style="width:80px" onchange="skudSetRate(' + p.id + ',this.value)"></td>' +
          '<td>' + status + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="skudPunch(' + p.id + ',\'in\')">Приход</button> <button class="btn btn-ghost btn-sm" onclick="skudPunch(' + p.id + ',\'out\')">Уход</button></td>' +
          '<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="skudToggle(' + p.id + ',' + (p.active ? 'false' : 'true') + ')">' + (p.active ? 'Откл.' : 'Вкл.') + '</button> <button class="btn btn-ghost btn-sm" onclick="skudDel(' + p.id + ')">✕</button></td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="7" class="muted">Пока нет сотрудников</td></tr>';
    }

    window.renderSkud = function () {
      if (!SERVER) return;
      var tf = document.getElementById('tsFrom'), tt = document.getElementById('tsTo');
      var now = new Date();
      if (tf && !tf.value) tf.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      if (tt && !tt.value) tt.value = now.toISOString().slice(0, 10);
      Promise.all([api('/skud/personnel'), api('/skud/status').catch(function () { return []; })]).then(function (r) {
        renderStatusBox(r[1]); renderPersonnel(r[0], r[1]);
      }).catch(function () {});
      renderSchedule();
      window.loadTimesheet();
    };

    window.loadTimesheet = function () {
      if (!SERVER) return;
      var f = document.getElementById('tsFrom'), t = document.getElementById('tsTo');
      var qs = '?from=' + ((f && f.value) || '') + '&to=' + ((t && t.value) || '');
      api('/skud/timesheet' + qs).then(function (r) {
        var tb = document.getElementById('skudTimesheet'); if (!tb) return;
        var staff = (r && r.staff) || [];
        tb.innerHTML = staff.map(function (s) {
          return '<tr><td>' + esc(s.full_name) + '</td><td>' + esc(s.position || '—') + '</td>' +
            '<td>' + (s.rate || 0) + '</td><td>' + (s.planned_hours || 0) + '</td>' +
            '<td><b>' + s.total_hours + '</b></td><td><b>' + fmtNum(s.salary) + '</b></td></tr>';
        }).join('') +
          (staff.length ? '<tr><td colspan="5" style="text-align:right"><b>Итого к выплате:</b></td><td><b>' + fmtNum((r && r.payroll_total) || 0) + '</b></td></tr>' : '');
        if (!staff.length) tb.innerHTML = '<tr><td colspan="6" class="muted">Нет отметок за период</td></tr>';
      }).catch(function () {});
    };

    window.skudSetRate = function (id, val) {
      api('/skud/personnel/' + id, { method: 'PUT', body: { hourly_rate: Number(val) || 0 } })
        .then(function () { if (typeof toast === 'function') toast('Ставка сохранена'); window.loadTimesheet(); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };

    // ---- График работы (недельная сетка) ----
    var weekStart = null;
    function mondayOf(d) { var x = new Date(d); var wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); x.setHours(0, 0, 0, 0); return x; }
    function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function ddmm(d) { return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'); }
    var WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    function weekDates() { if (!weekStart) weekStart = mondayOf(new Date()); var a = []; for (var i = 0; i < 7; i++) a.push(new Date(weekStart.getTime() + i * 86400000)); return a; }

    window.skudWeek = function (delta) {
      if (!weekStart) weekStart = mondayOf(new Date());
      weekStart = new Date(weekStart.getTime() + delta * 7 * 86400000);
      renderSchedule();
    };

    function renderSchedule() {
      if (!SERVER) return;
      var dates = weekDates();
      var from = ymd(dates[0]), to = ymd(dates[6]);
      var lbl = document.getElementById('skudWeekLabel'); if (lbl) lbl.textContent = ddmm(dates[0]) + ' — ' + ddmm(dates[6]);
      Promise.all([api('/skud/personnel'), api('/skud/schedule?from=' + from + '&to=' + to).catch(function () { return []; })]).then(function (r) {
        var people = (r[0] || []).filter(function (p) { return p.active; });
        var map = {}; (r[1] || []).forEach(function (s) { map[s.personnel_id + '|' + s.work_date] = Number(s.planned_hours); });
        var head = document.getElementById('skudSchedHead'), body = document.getElementById('skudSchedBody');
        if (head) head.innerHTML = '<tr><th>Сотрудник</th>' + dates.map(function (d, i) { return '<th style="text-align:center">' + WD[i] + '<br><small class="muted">' + ddmm(d) + '</small></th>'; }).join('') + '<th>Σ план</th></tr>';
        if (body) body.innerHTML = people.map(function (p) {
          var sum = 0;
          var cells = dates.map(function (d) {
            var v = map[p.id + '|' + ymd(d)] || '';
            if (v) sum += Number(v);
            return '<td style="text-align:center"><input type="number" min="0" max="24" value="' + v + '" data-pid="' + p.id + '" data-date="' + ymd(d) + '" class="sched-in" style="width:52px;text-align:center" onchange="skudSetPlan(this)"></td>';
          }).join('');
          return '<tr><td>' + esc(p.full_name) + '</td>' + cells + '<td id="schsum-' + p.id + '"><b>' + (sum || 0) + '</b></td></tr>';
        }).join('') || '<tr><td colspan="9" class="muted">Нет активных сотрудников</td></tr>';
      }).catch(function () {});
    }

    window.skudSetPlan = function (el) {
      var pid = el.getAttribute('data-pid'), date = el.getAttribute('data-date'), val = Number(el.value) || 0;
      api('/skud/schedule', { method: 'POST', body: { personnel_id: +pid, work_date: date, planned_hours: val } })
        .then(function () {
          var sum = 0; document.querySelectorAll('.sched-in[data-pid="' + pid + '"]').forEach(function (i) { sum += Number(i.value) || 0; });
          var c = document.getElementById('schsum-' + pid); if (c) c.innerHTML = '<b>' + sum + '</b>';
          window.loadTimesheet();
        }).catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };

    window.skudAddToggle = function () { var f = document.getElementById('skudAddForm'); if (f) f.style.display = f.style.display === 'none' ? '' : 'none'; };
    window.skudAdd = function () {
      var n = document.getElementById('spName'), pos = document.getElementById('spPos'), ph = document.getElementById('spPhone'), fp = document.getElementById('spFp');
      if (!n || !n.value.trim()) { if (n) n.focus(); return; }
      api('/skud/personnel', { method: 'POST', body: { full_name: n.value.trim(), position: (pos.value || '').trim() || null, phone: (ph.value || '').trim() || null, fingerprint_id: (fp.value || '').trim() || null } })
        .then(function () { n.value = pos.value = ph.value = fp.value = ''; window.skudAddToggle(); window.renderSkud(); if (typeof toast === 'function') toast('Сотрудник добавлен'); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    window.skudPunch = function (id, dir) {
      api('/skud/punch', { method: 'POST', body: { personnel_id: id, direction: dir } })
        .then(function () { window.renderSkud(); if (typeof toast === 'function') toast(dir === 'in' ? 'Приход отмечен' : 'Уход отмечен'); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    window.skudSetFp = function (id, val) {
      api('/skud/personnel/' + id, { method: 'PUT', body: { fingerprint_id: (val || '').trim() } })
        .then(function () { if (typeof toast === 'function') toast('ID отпечатка сохранён'); })
        .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };
    window.skudToggle = function (id, active) {
      api('/skud/personnel/' + id, { method: 'PUT', body: { active: active } }).then(function () { window.renderSkud(); }).catch(function () {});
    };
    window.skudDel = function (id) {
      api('/skud/personnel/' + id, { method: 'DELETE' }).then(function () { window.renderSkud(); }).catch(function () {});
    };

    // Открытие раздела «Табель» → загрузка данных
    var _go = window.go;
    if (typeof _go === 'function') {
      window.go = function (p) { var r = _go.apply(this, arguments); if (p === 'skud' && window.renderSkud) window.renderSkud(); return r; };
    }
  }

  // -------------------- Раздел «Новости» (владелец/админ) --------------------
  function installNews() {
    function nH(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function nDate(s) { if (!s) return ''; var d = String(s).slice(0, 10).split('-'); return d.length === 3 ? d[2] + '.' + d[1] + '.' + d[0] : s; }
    var lastNews = [];

    window.renderNews = function () {
      var tb = document.getElementById('newsTbl');
      if (!SERVER) { if (tb) tb.innerHTML = '<tr><td colspan="5" class="muted">Доступно при работе с сервером</td></tr>'; return; }
      api('/news').then(function (rows) {
        lastNews = rows || [];
        if (!tb) return;
        tb.innerHTML = lastNews.map(function (n) {
          var cov = n.image ? '<img src="' + n.image + '" style="width:38px;height:38px;object-fit:cover;border-radius:7px;vertical-align:middle">'
            : (n.cover && n.cover.length <= 4 ? n.cover : (n.cover ? '🖼️' : '—'));
          var status = (n.published ? '<span style="color:var(--green);font-weight:700">опубликовано</span>' : '<span class="muted">черновик</span>') +
            (n.pinned ? ' · <span style="color:var(--orange,#c2410c);font-weight:700">закреплено</span>' : '');
          return '<tr>' +
            '<td style="font-size:20px">' + cov + '</td>' +
            '<td><b>' + nH(n.title) + '</b></td>' +
            '<td>' + status + '</td>' +
            '<td style="white-space:nowrap">' + nDate(n.created_at) + '</td>' +
            '<td style="white-space:nowrap">' +
              '<button class="btn btn-ghost btn-sm" onclick="editNews(' + n.id + ')">Ред.</button> ' +
              '<button class="btn btn-ghost btn-sm" onclick="newsTogglePub(' + n.id + ',' + (n.published ? 'true' : 'false') + ')">' + (n.published ? 'Снять' : 'Опубл.') + '</button> ' +
              '<button class="btn btn-ghost btn-sm" onclick="newsTogglePin(' + n.id + ',' + (n.pinned ? 'true' : 'false') + ')">' + (n.pinned ? 'Открепить' : 'Закрепить') + '</button> ' +
              '<button class="btn btn-ghost btn-sm" onclick="delNews(' + n.id + ')">✕</button>' +
            '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="muted">Пока новостей нет</td></tr>';
      }).catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };

    // Сжать выбранную картинку на клиенте (макс. сторона 1200px, JPEG) → data-URI
    window.newsPickImage = function (input) {
      var f = input.files && input.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var img = new Image();
        img.onload = function () {
          var max = 1200, w = img.width, h = img.height;
          if (w > max || h > max) { if (w >= h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          var uri = c.toDataURL('image/jpeg', 0.82);
          document.getElementById('newsImage').value = uri;
          var pv = document.getElementById('newsImgPreview'); pv.src = uri; pv.style.display = '';
          document.getElementById('newsImgClear').style.display = '';
        };
        img.src = rd.result;
      };
      rd.readAsDataURL(f);
    };
    window.newsClearImage = function () {
      document.getElementById('newsImage').value = '';
      var pv = document.getElementById('newsImgPreview'); pv.src = ''; pv.style.display = 'none';
      document.getElementById('newsImgClear').style.display = 'none';
      var fi = document.getElementById('newsImgFile'); if (fi) fi.value = '';
    };

    window.newsResetForm = function () {
      document.getElementById('newsEditId').value = '';
      document.getElementById('newsCover').value = '';
      document.getElementById('newsTitle').value = '';
      document.getElementById('newsBody').value = '';
      document.getElementById('newsPub').checked = true;
      document.getElementById('newsPin').checked = false;
      window.newsClearImage();
      document.getElementById('newsFormTitle').textContent = 'Новая новость';
      document.getElementById('newsCancelBtn').style.display = 'none';
    };

    window.editNews = function (id) {
      var n = lastNews.filter(function (x) { return x.id === id; })[0];
      if (!n) return;
      document.getElementById('newsEditId').value = n.id;
      document.getElementById('newsCover').value = n.cover || '';
      document.getElementById('newsTitle').value = n.title || '';
      document.getElementById('newsBody').value = n.body || '';
      document.getElementById('newsPub').checked = !!n.published;
      document.getElementById('newsPin').checked = !!n.pinned;
      document.getElementById('newsImage').value = n.image || '';
      var pv = document.getElementById('newsImgPreview');
      if (n.image) { pv.src = n.image; pv.style.display = ''; document.getElementById('newsImgClear').style.display = ''; }
      else { pv.src = ''; pv.style.display = 'none'; document.getElementById('newsImgClear').style.display = 'none'; }
      var fi = document.getElementById('newsImgFile'); if (fi) fi.value = '';
      document.getElementById('newsFormTitle').textContent = 'Редактировать новость';
      document.getElementById('newsCancelBtn').style.display = '';
      window.scrollTo(0, 0);
    };

    window.saveNews = function () {
      var id = document.getElementById('newsEditId').value;
      var body = {
        title: document.getElementById('newsTitle').value.trim(),
        body: document.getElementById('newsBody').value,
        cover: document.getElementById('newsCover').value.trim(),
        image: document.getElementById('newsImage').value || '',
        published: document.getElementById('newsPub').checked,
        pinned: document.getElementById('newsPin').checked,
      };
      if (!body.title) { if (typeof toast === 'function') toast('Укажите заголовок', true); return; }
      var req = id
        ? api('/news/' + id, { method: 'PUT', body: body })
        : api('/news', { method: 'POST', body: body });
      req.then(function () {
        window.newsResetForm();
        window.renderNews();
        if (typeof toast === 'function') toast(id ? 'Новость обновлена' : 'Новость добавлена');
      }).catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
    };

    window.newsTogglePub = function (id, cur) {
      api('/news/' + id, { method: 'PUT', body: { published: !cur } }).then(window.renderNews).catch(function () {});
    };
    window.newsTogglePin = function (id, cur) {
      api('/news/' + id, { method: 'PUT', body: { pinned: !cur } }).then(window.renderNews).catch(function () {});
    };
    window.delNews = function (id) {
      api('/news/' + id, { method: 'DELETE' }).then(window.renderNews).catch(function () {});
    };
  }

  // ---------------- Точки продаж (ТЦ) ----------------
  // Каждая касса (устройство) привязана к своему ТЦ. Привязка хранится локально
  // и уходит с каждой сменой/продажей, поэтому касса разделена по точкам,
  // а клиенты и бонусы — общие.
  var LOCS = [];
  var LOC_KEY = 'chailand_location_id';
  function deviceLoc() { var v = localStorage.getItem(LOC_KEY); return v ? Number(v) : null; }
  window.deviceLoc = deviceLoc; // чтобы касса (index.html) фильтровала товары по своему ТЦ
  // Показывать ли товар на этой кассе: без привязки товара — везде; иначе только в своём ТЦ.
  window.prodInLoc = function (t) { var d = deviceLoc(); return !t || !t.loc || !d || Number(t.loc) === d; };
  function setDeviceLoc(id) {
    if (id) localStorage.setItem(LOC_KEY, String(id)); else localStorage.removeItem(LOC_KEY);
    renderLocBadge();
  }
  function locName(id) { var l = LOCS.filter(function (x) { return x.id === Number(id); })[0]; return l ? l.name : null; }
  function locEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function loadLocations() {
    if (!SERVER || !localStorage.getItem(TOKEN_KEY)) return Promise.resolve();
    return api('/locations').then(function (list) {
      LOCS = list || [];
      renderLocBadge();
      renderLocSettings();
      fillDashLocation();
      // Первый запуск на кассе: если ТЦ не выбран, а точки есть — просим выбрать.
      // Владельца не просим: ему нужны данные сразу по обеим точкам, а не касса одного ТЦ.
      if (LOCS.length && !deviceLoc() && (!ME || ME.role !== 'owner')) openLocPicker(true);
      return LOCS;
    }).catch(function () {});
  }

  // Значок текущего ТЦ в шапке
  function renderLocBadge() {
    var host = document.querySelector('.topbar') || document.querySelector('header') || document.body;
    var b = document.getElementById('locBadge');
    if (!LOCS.length) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('button');
      b.id = 'locBadge';
      b.style.cssText = 'margin-left:12px;padding:6px 12px;border-radius:10px;border:1px solid var(--line,#e2e8f0);background:#fff;font-weight:700;font-size:13px;cursor:pointer;color:#0f172a';
      b.onclick = function () { openLocPicker(false); };
      host.appendChild(b);
    }
    var cur = deviceLoc();
    var label = cur ? locEsc(locName(cur) || 'ТЦ?')
      : (ME && ME.role === 'owner' ? 'Все ТЦ' : '<span style="color:#dc2626">Выберите ТЦ</span>');
    b.innerHTML = '📍 ' + label;
  }

  // Модалка выбора ТЦ для этой кассы
  function openLocPicker(firstRun) {
    var old = document.getElementById('locPicker'); if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = 'locPicker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:420px;width:100%;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.4)">' +
      '<h3 style="margin:0 0 6px;font-size:18px">📍 Точка этой кассы</h3>' +
      '<p style="margin:0 0 16px;color:#64748b;font-size:13.5px">Выберите ТЦ, в котором стоит эта касса. Все продажи и смены будут идти в эту точку. Настройка запоминается на устройстве.</p>' +
      '<div id="locPickList" style="display:flex;flex-direction:column;gap:8px"></div>' +
      (firstRun ? '' : '<button id="locPickClose" style="margin-top:16px;width:100%;padding:11px;border:1px solid var(--line,#e2e8f0);background:#fff;border-radius:11px;cursor:pointer;font-weight:600">Закрыть</button>') +
      '</div>';
    document.body.appendChild(ov);
    var list = ov.querySelector('#locPickList');
    var cur = deviceLoc();
    // Владелец может смотреть сводно по обеим точкам — даём вернуться к «Все ТЦ».
    // Кассиру эта опция не показывается: касса всегда должна быть привязана к одной точке.
    var allOpt = (ME && ME.role === 'owner')
      ? '<button data-id="" style="text-align:left;padding:13px 15px;border-radius:12px;border:2px solid ' + (!cur ? '#2563eb' : 'var(--line,#e2e8f0)') + ';background:' + (!cur ? '#eff6ff' : '#fff') + ';cursor:pointer;font-size:15px;font-weight:700;color:#0f172a">' +
        '📍 Все ТЦ<span style="display:block;font-weight:500;font-size:12.5px;color:#64748b">Сводные данные по обеим точкам</span></button>'
      : '';
    list.innerHTML = allOpt + LOCS.map(function (l) {
      var on = l.id === cur;
      return '<button data-id="' + l.id + '" style="text-align:left;padding:13px 15px;border-radius:12px;border:2px solid ' + (on ? '#2563eb' : 'var(--line,#e2e8f0)') + ';background:' + (on ? '#eff6ff' : '#fff') + ';cursor:pointer;font-size:15px;font-weight:700;color:#0f172a">' +
        '📍 ' + locEsc(l.name) + (l.address ? '<span style="display:block;font-weight:500;font-size:12.5px;color:#64748b">' + locEsc(l.address) + '</span>' : '') + '</button>';
    }).join('');
    list.querySelectorAll('button[data-id]').forEach(function (btn) {
      btn.onclick = function () {
        setDeviceLoc(btn.getAttribute('data-id'));
        ov.remove();
        if (typeof toast === 'function') toast(deviceLoc() ? 'Касса привязана к: ' + locName(deviceLoc()) : 'Показаны данные по всем ТЦ');
      };
    });
    var cl = ov.querySelector('#locPickClose'); if (cl) cl.onclick = function () { ov.remove(); };
  }

  // Управление точками — в Настройках (владелец/админ)
  function renderLocSettings() {
    var page = document.getElementById('p-settings');
    if (!page) return;
    var canManage = !ME || ME.role === 'owner' || ME.role === 'admin';
    var card = document.getElementById('locSettingsCard');
    if (!canManage) { if (card) card.remove(); return; }
    if (!card) {
      card = document.createElement('div');
      card.className = 'card';
      card.id = 'locSettingsCard';
      page.insertBefore(card, page.firstChild);
    }
    card.innerHTML =
      '<h3>📍 Точки (ТЦ)</h3>' +
      '<div class="muted" style="font-size:12.5px;margin-bottom:12px">Клиенты и бонусы общие для всех точек. Касса, смены и выручка — раздельные по каждому ТЦ. Касса определяет свой ТЦ по устройству.</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Название</th><th>Адрес</th><th>Статус</th><th></th></tr></thead><tbody id="locTbl"></tbody></table></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<input id="locNewName" placeholder="Название ТЦ" style="flex:1.4">' +
      '<input id="locNewAddr" placeholder="Адрес (необязательно)" style="flex:1.6">' +
      '<button class="btn btn-green" onclick="locAdd()">＋ Добавить</button></div>';
    var tb = document.getElementById('locTbl');
    tb.innerHTML = LOCS.map(function (l) {
      return '<tr><td><input value="' + locEsc(l.name) + '" style="width:150px" onchange="locRename(' + l.id + ',this.value)"></td>' +
        '<td><input value="' + locEsc(l.address || '') + '" style="width:180px" onchange="locSetAddr(' + l.id + ',this.value)"></td>' +
        '<td>' + (l.active ? '<span style="color:var(--green);font-weight:700">активна</span>' : '<span class="muted">отключена</span>') + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" onclick="locToggle(' + l.id + ',' + (l.active ? 'false' : 'true') + ')">' + (l.active ? 'Откл.' : 'Вкл.') + '</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="locDel(' + l.id + ')">✕</button></td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">Точек пока нет</td></tr>';
  }
  window.locAdd = function () {
    var n = document.getElementById('locNewName'), a = document.getElementById('locNewAddr');
    if (!n || !n.value.trim()) { if (n) n.focus(); return; }
    api('/locations', { method: 'POST', body: { name: n.value.trim(), address: a.value.trim() || null } })
      .then(function () { n.value = ''; a.value = ''; return loadLocations(); })
      .then(function () { if (typeof toast === 'function') toast('Точка добавлена'); })
      .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
  };
  window.locRename = function (id, v) { api('/locations/' + id, { method: 'PUT', body: { name: v } }).then(loadLocations).catch(function () {}); };
  window.locSetAddr = function (id, v) { api('/locations/' + id, { method: 'PUT', body: { address: v } }).then(loadLocations).catch(function () {}); };
  window.locToggle = function (id, on) { api('/locations/' + id, { method: 'PUT', body: { active: on } }).then(loadLocations).catch(function () {}); };
  window.locDel = function (id) {
    api('/locations/' + id, { method: 'DELETE' }).then(loadLocations)
      .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Нельзя удалить', true); });
  };

  // Фильтр по ТЦ в дашборде
  function fillDashLocation() {
    var host = document.getElementById('dashCashier') || document.getElementById('dashGroup');
    if (!host || !LOCS.length) return;
    var sel = document.getElementById('dashLocation');
    if (!sel) {
      sel = document.createElement('select');
      sel.id = 'dashLocation';
      if (host.className) sel.className = host.className;
      sel.onchange = function () { if (typeof renderDash === 'function') renderDash(); };
      host.parentNode.insertBefore(sel, host);
    }
    var cur = sel.value;
    sel.innerHTML = '<option value="all">Все ТЦ</option>' + LOCS.map(function (l) { return '<option value="' + l.id + '">' + locEsc(l.name) + '</option>'; }).join('');
    if (cur) sel.value = cur;
  }

  // ---------------- Штрих-М: печать чека на локальном ККТ ----------------
  // Драйвер «Штрих-М: Драйвер ФР» на кассовом ПК даёт HTTP-JSON интерфейс на
  // localhost (адрес и порт задаются в настройках, см. window.SHTRIH_URL).
  // Браузер на кассе стучится туда напрямую — сервер это устройство не видит.
  //
  // ВАЖНО: имена команд/полей ниже — по общей документации HTTP-драйвера
  // Штрих-М и МОГУТ отличаться в вашей версии драйвера. Перед боевым запуском
  // обязательно сверьте с документацией установленного драйвера (пункт меню
  // «Настройка соединения» → «HTTP-сервер») и поправьте SHTRIH_CMD при нужде.
  var SHTRIH_CMD = {
    // операция «пробить чек целиком»: позиции + оплаты + закрытие одним вызовом
    path: '/',
    command: 'PrintFiscalCheck',
  };
  function printShtrihReceipt(kind, items, payments) {
    var url = (window.SHTRIH_URL || 'http://localhost:5893').replace(/\/+$/, '') + SHTRIH_CMD.path;
    var body = {
      Command: SHTRIH_CMD.command,
      CheckType: kind === 'return' ? 'Return' : 'Sell',
      Positions: (items || []).map(function (it) {
        return { Name: it.name, Price: Number(it.price), Quantity: Number(it.qty || 1), Tax: 'VatNo' };
      }),
      Payments: [
        Number(payments.cash) > 0 ? { Type: 'Cash', Sum: Number(payments.cash) } : null,
        Number(payments.card) + Number(payments.bonus || 0) > 0 ? { Type: 'Electronically', Sum: Number(payments.card) + Number(payments.bonus || 0) } : null,
      ].filter(Boolean),
    };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw new Error('Штрих-М: касса ответила ошибкой (HTTP ' + res.status + ')');
      return res.json();
    }).then(function (r) {
      var fn = r.FnNumber || r.FnFactoryNumber, fd = r.DocumentNumber || r.FdNumber, fp = r.FiscalSign || r.Fp;
      if (!fn || !fd || !fp) throw new Error('Штрих-М: чек напечатан, но касса не вернула номера ФН/ФД/ФП');
      return { fnNumber: String(fn), fdNumber: String(fd), fp: String(fp), receiptUrl: r.OfdReceiptUrl || r.CheckUrl || null };
    }).catch(function (e) {
      throw new Error('Не удалось напечатать чек на Штрих-М (' + (e.message || 'нет связи с кассой') + '). Проверьте, что касса включена и подключена.');
    });
  }

  function installLocations() {
    loadLocations();
  }

  function installHooks() {
    installStaff();
    installExtras();
    installTasks();
    installLeadAlerts();
    installLocations();
    installSkud();
    installNews();
    // Продажа: enqueue до того, как оригинал очистит чек
    wrap('confirmPay', function () {
      if (!PAY || !PAY.method) return;
      var toPay = PAY.total - (PAY.bonusSpend || 0);
      if (PAY.method === 'cash' && (+(document.getElementById('cashGiven').value) || 0) < toPay) return;
      var id = uuid();
      var items = check.map(function (l) {
        return { product_id: l.t.pid || l.t.id, group_id: l.t.group, name: l.t.name, qty: l.qty, price: l.t.price };
      });
      var cash = PAY.method === 'cash' ? toPay : 0;
      var card = PAY.method === 'cash' ? 0 : toPay;
      var payments = { cash: cash, card: card, bonus: PAY.bonusSpend || 0 };
      function send(fiscal) {
        enqueue({
          uuid: id, kind: 'sale', client_uuid: id,
          payload: {
            client_uuid: id, items: items,
            client_id: (checkClient && checkClient.id) || null,
            cash_amount: cash, card_amount: card, bonus_used: PAY.bonusSpend || 0,
            method: PAY.method === 'cash' ? 'cash' : 'card',
            location_id: deviceLoc(),
            fiscal: fiscal || undefined,
          },
        });
      }
      // Привязать серверный uuid к локальной продаже (для будущего возврата)
      setTimeout(function () { if (sales[0] && !sales[0].uuid) sales[0].uuid = id; }, 1700);
      if (window.FISCAL_DRIVER === 'shtrih') {
        printShtrihReceipt('sale', items, payments).then(send).catch(function (e) {
          if (typeof toast === 'function') toast(e.message, true); else alert(e.message);
        });
      } else {
        send(null);
      }
    });

    // Возврат
    wrap('confirmRefund', function () {
      if (!REFUND || !REFUND.sale) return;
      var s = REFUND.sale, id = uuid();
      function send(fiscal) {
        enqueue({
          uuid: id, kind: 'return', client_uuid: id,
          payload: {
            client_uuid: id,
            parent_sale_id: s.serverId || undefined,
            parent_client_uuid: s.uuid || undefined,
            reason: (document.getElementById('refundReason') || {}).value || 'Возврат',
            fiscal: fiscal || undefined,
          },
        });
      }
      if (window.FISCAL_DRIVER === 'shtrih') {
        if (!s.serverId) {
          if (typeof toast === 'function') toast('Продажа ещё не синхронизирована с сервером — подождите пару секунд и повторите возврат', true);
          return;
        }
        api('/pos/sales/' + s.serverId).then(function (full) {
          var items = (full.items || []).map(function (it) { return { name: it.name, price: it.price, qty: it.qty }; });
          var payments = { cash: -Number(full.cash_amount), card: -Number(full.card_amount), bonus: -Number(full.bonus_used) };
          return printShtrihReceipt('return', items, payments);
        }).then(send).catch(function (e) {
          if (typeof toast === 'function') toast(e.message, true); else alert(e.message);
        });
      } else {
        send(null);
      }
    });

    // Открытие/закрытие смены — на сервер
    wrap('openShift', function () {
      var cs = +(document.getElementById('cashStart') || {}).value || 0;
      api('/pos/shift/open', { method: 'POST', body: { cash_start: cs, location_id: deviceLoc() } }).catch(function () {});
    });
    wrap('closeShift', function () { api('/pos/shift/close', { method: 'POST', body: {} }).catch(function () {}); });

    // Новый клиент — через офлайн-очередь: работает без интернета и не теряется.
    // Локальный демо-обработчик тем временем показывает клиента сразу (оптимистично),
    // а после синхронизации hydrateAll подтянет карту/бонусы с сервера.
    wrap('addClient', function () {
      var name = (document.getElementById('ncName') || {}).value;
      var phone = (document.getElementById('ncPhone') || {}).value;
      var ref = (document.getElementById('ncRef') || {}).value || '';
      if (!name || !phone) return;
      var id = uuid();
      enqueue({
        uuid: id, kind: 'client', client_uuid: id,
        payload: {
          client_uuid: id, full_name: name.trim(), phone: phone.trim(),
          referrer_code: ref.trim() || undefined,
        },
      });
      var rf = document.getElementById('ncRef'); if (rf) rf.value = '';
    });

    // Новый лид
    wrap('addLead', function () {
      var n = (document.getElementById('lname') || {}).value;
      var p = (document.getElementById('lphone') || {}).value;
      var src = (document.getElementById('lsource') || {}).value;
      var note = (document.getElementById('lnote') || {}).value;
      if (!n || !p) return;
      api('/crm/leads', { method: 'POST', body: { name: n.trim(), phone: p.trim(), source: (src || '').trim(), note: (note || '').trim() } }).catch(function () {});
    });

    // Карточка клиента — подгрузить детей, историю, баланс и реферальную инфо
    function appendRef(c) {
      if (!c || !c.referral_code) return;
      var body = document.getElementById('clientCardBody'); if (!body) return;
      body.insertAdjacentHTML('beforeend',
        '<div class="cc-sec"><h4>🎁 Реферальная программа</h4>' +
        '<div class="muted" style="font-size:13px">Код клиента: <b style="color:var(--orange)">' + c.referral_code + '</b>' +
        ' · приглашено друзей: <b>' + (c.invited || 0) + '</b>' +
        (c.referrer_name ? ' · пришёл по приглашению: <b>' + c.referrer_name + '</b>' : '') + '</div></div>');
    }
    var _open = window.openClientCard;
    if (typeof _open === 'function') {
      window.openClientCard = function (id) {
        var c = clients.find(function (x) { return x.id === id; });
        function finish() { _open(id); appendRef(c); }
        if (SERVER && c && (c.kids === null || c.history === null)) {
          api('/clients/' + id).then(function (full) {
            c.bonus = Number(full.bonus);
            c.buys = (full.history || []).filter(function (h) { return !h.is_return; }).length;
            c.kids = (full.kids || []).map(function (k) { return { name: k.name, birth: (k.birth_date || '').slice(0, 10) }; });
            c.history = (full.history || []).filter(function (h) { return !h.is_return; }).map(function (h) {
              return { date: (h.created_at || '').slice(0, 10), items: (h.items || []).map(function (i) { return i.name + ' ×' + i.qty; }).join(', '), total: Number(h.total), method: mapMethod(h.method), earned: Number(h.bonus_earned) };
            });
            c.referral_code = full.referral_code; c.invited = full.invited_count; c.referrer_name = full.referrer_name;
            finish();
          }).catch(function () { c.kids = c.kids || []; c.history = c.history || []; finish(); });
        } else { if (c) { c.kids = c.kids || []; c.history = c.history || []; } finish(); }
      };
    }

    // Дашборд — живые серверные отчёты (KPI, топ позиций, разрез оплат)
    var _renderDash = window.renderDash;
    window.renderDash = function () {
      if (!SERVER) return _renderDash ? _renderDash.apply(this, arguments) : undefined;
      // Группы — пересобираем каждый раз (чтобы подхватывались переименования),
      // сохраняя текущий выбор.
      var gsel = document.getElementById('dashGroup');
      if (gsel) {
        var gcur = gsel.value;
        gsel.innerHTML = '<option value="all">Все группы</option>' +
          GROUPS.map(function (g) { return '<option value="' + g.id + '">' + g.name + '</option>'; }).join('');
        gsel.value = gcur || 'all';
        if (!gsel.value) gsel.value = 'all';
      }
      // Позиции — фильтр по конкретному товару/билету (по названию), тоже свежие.
      var psel = document.getElementById('dashPosition');
      if (psel) {
        var pcur = psel.value;
        var names = (TARIFFS || []).map(function (t) { return t.name; }).filter(function (n, i, a) { return n && a.indexOf(n) === i; }).sort();
        psel.innerHTML = '<option value="all">Все позиции</option>' +
          names.map(function (n) { return '<option value="' + n.replace(/"/g, '&quot;') + '">' + n + '</option>'; }).join('');
        psel.value = pcur || 'all';
        if (!psel.value) psel.value = 'all';
      }
      // Кассиры — один раз.
      var csel = document.getElementById('dashCashier');
      if (csel && !csel.dataset.filled) {
        csel.insertAdjacentHTML('beforeend', (DASH_USERS || []).map(function (u) { return '<option value="' + u.id + '">' + u.name + '</option>'; }).join(''));
        csel.dataset.filled = '1';
      }
      var qs = dashQuery();
      api('/reports/overview' + qs.query).then(function (r) {
        setText('dashKpi', '' +
          stat(fmtNum(r.revenue), 'Выручка', 'or') + stat(r.checks, 'Чеков') +
          stat(fmtNum(r.avg), 'Средний чек') + stat(r.qty, 'Продано позиций', 'gr'));
        var maxQty = r.top.length ? r.top[0].qty : 1, totalQty = r.qty || 1;
        setText('dashTop', r.top.length ? r.top.map(function (it) {
          return '<tr><td><div style="font-weight:600">' + it.name + '</div>' +
            '<div class="dbar"><span style="width:' + Math.round(it.qty / maxQty * 100) + '%"></span></div></td>' +
            '<td><b>' + it.qty + '</b></td><td>' + fmtNum(it.amt) + '</td><td>' + (it.qty / totalQty * 100).toFixed(1) + '%</td></tr>';
        }).join('') : '<tr><td colspan="4" class="muted">Нет данных за выбранный период</td></tr>');
        var totRev = r.revenue || 1, ML = { cash: 'Наличные', card: 'Безнал', online: 'Онлайн' };
        setText('dashMethods', ['cash', 'card', 'online'].map(function (k) {
          var v = r.byMethod[k] || 0, pct = Math.round(v / totRev * 100);
          return '<div class="mrow"><div class="mrow-top"><span>' + ML[k] + '</span><b>' + fmtNum(v) + ' · ' + pct + '%</b></div>' +
            '<div class="dbar ' + k + '"><span style="width:' + pct + '%"></span></div></div>';
        }).join(''));
        var lbl = document.getElementById('dashRangeLbl');
        if (lbl) lbl.textContent = qs.label + ' · записей о продажах: ' + r.checks;
      }).catch(function (e) { console.warn('[dash]', e.message); });
    };

    // Переименование группы — сохранить на сервере (иначе дашборд/касса
    // показывали бы старое имя, т.к. читают из базы).
    var _updG = window.updG;
    window.updG = function (id, v) {
      if (SERVER) {
        api('/catalog/groups/' + id, { method: 'PUT', body: { name: v } })
          .then(function () { return hydrateAll(); })
          .catch(function (e) { if (typeof toast === 'function') toast(e.message || 'Ошибка', true); });
      }
      return _updG ? _updG.apply(this, arguments) : undefined;
    };

    // Добавление ребёнка — на сервер
    var _addKid = window.addKid;
    if (typeof _addKid === 'function') {
      window.addKid = function (id) {
        if (SERVER) {
          var name = (document.getElementById('kidName') || {}).value;
          var birth = (document.getElementById('kidBirth') || {}).value;
          if (name && birth) api('/clients/' + id + '/kids', { method: 'POST', body: { name: name.trim(), birth_date: birth } }).catch(function () {});
        }
        return _addKid.apply(this, arguments);
      };
    }
  }

  /* --------------------------------- Boot --------------------------------- */
  function injectStyles() {
    var css = document.createElement('style');
    css.textContent =
      '.gab-login{position:fixed;inset:0;z-index:9999;background:linear-gradient(135deg,#0f172a,#1e293b);display:flex;align-items:center;justify-content:center;padding:20px}' +
      '.gl-card{background:#fff;border-radius:20px;padding:34px 30px;width:100%;max-width:380px;box-shadow:0 30px 80px rgba(0,0,0,.5);text-align:center}' +
      '.gl-logo{font-size:26px;font-weight:900;color:#ea580c}.gl-sub{color:#64748b;font-size:13.5px;margin:6px 0 22px}' +
      '.gl-card input{width:100%;box-sizing:border-box;padding:13px 15px;margin-bottom:12px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:15px}' +
      '.gl-card input:focus{outline:none;border-color:#ea580c}' +
      '.gl-btn{width:100%;padding:14px;background:#ea580c;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer}' +
      '.gl-btn:hover{background:#c2410c}.gl-err{color:#dc2626;font-size:13px;min-height:18px;margin-bottom:6px}' +
      '.gl-hint{color:#94a3b8;font-size:12px;margin-top:16px}' +
      '.gl-demo{margin-top:14px;background:none;border:none;color:#64748b;font-size:13px;text-decoration:underline;cursor:pointer}' +
      '.gab-pill{position:fixed;left:14px;bottom:14px;z-index:9000;font-size:12.5px;font-weight:700;padding:7px 13px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.15);background:#fff;border:1px solid #e2e8f0}' +
      '.gab-pill.on{color:#065f46;border-color:#a7f3d0}.gab-pill.off{color:#b91c1c;border-color:#fecaca}' +
      '.gab-pill.sync{color:#92400e;border-color:#fde68a}.gab-pill.demo{color:#9a3412;border-color:#fed7aa}';
    document.head.appendChild(css);
  }

  function boot() {
    injectStyles();
    var pill = document.createElement('div'); pill.id = 'gabPill'; pill.className = 'gab-pill'; document.body.appendChild(pill);

    window.addEventListener('online', function () { ONLINE = true; updatePill(); flush(); });
    window.addEventListener('offline', function () { ONLINE = false; updatePill(); });
    setInterval(flush, 15000);

    openIDB().then(function (db) { idb = db; return api('/health'); })
      .then(function () {
        SERVER = true; updatePill(); installHooks();
        if (localStorage.getItem(TOKEN_KEY)) {
          // Уже был вход — проверить токен и гидрировать
          api('/auth/me').then(function (me) { ME = me; applyRole(); return hydrateAll(); })
            .then(function () { updatePill(); flush(); markLive(); })
            .catch(function () { showLogin(); });
        } else { showLogin(); }
      })
      .catch(function () { SERVER = false; updatePill(); }); // сервера нет — демо-режим
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
