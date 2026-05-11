window.onerror = function(message, source, lineno, colno, error) {
    alert("ОШИБКА: " + message + " в строке " + lineno);
};
window.onunhandledrejection = function(event) {
    alert("ОШИБКА ПРОМИСА: " + event.reason);
};

// Инициализация Supabase.
const SUPABASE_URL = 'https://qvkhfueivkwdqydnhlsr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_mXpXBbeHRecrahRlDxkDAQ_Xe3zyb5G';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Старый URL оставляем для гибридных запросов (СЦ, KPI)
const GAS_URL = "https://script.google.com/macros/s/AKfycbxb2UW5ctVar9QhWmjI-IIFA1EOxDCovRDoNBcbN31x4L4-mCh1lGcF-ZdH-62pUrbR/exec";

let tg = window.Telegram ? window.Telegram.WebApp : null; 
if (tg) { tg.expand(); }

if ('serviceWorker' in navigator) { 
    window.addEventListener('load', () => { 
        navigator.serviceWorker.register('sw.js').then(reg => console.log('SW registered')).catch(err => console.log('SW error', err)); 
    }); 
}

function safeIin(val) { if(val === undefined || val === null) return ""; return String(val).trim().replace(/^0+/, ''); }
function requestNotificationPermission() { if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") Notification.requestPermission(); }
function showPushNotification(title, bodyText) { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body: bodyText, icon: "icon.png" }); }

// Вспомогательная функция для форматирования плана (Добавлена!)
function formatPlanHtml(planArray) {
    if (!planArray || planArray.length === 0) return "<p style='color:gray; font-size:12px; text-align:center;'>План на сегодня не загружен</p>";
    let html = "<div class='card'>";
    planArray.forEach(row => {
        let key = row['Показатель'] || row['name'] || row[0] || '---';
        let val = row['Значение'] || row['val'] || row[1] || '0';
        html += `<div style="display:flex; justify-content:space-between; margin-bottom:8px; border-bottom:1px solid var(--border-color); padding-bottom:4px;">
            <span style="color:gray;">${key}</span>
            <b style="color:var(--btn-color);">${val}</b>
        </div>`;
    });
    html += "</div>";
    return html;
}

// ИСПРАВЛЕННАЯ ФУНКЦИЯ CALLBACKEND
async function callBackend(actionName, payloadData = {}) { 
  try { 
    const getRoleGroup = (roleText) => {
        const r = (roleText || appState.role || "").toLowerCase();
        if (r.includes("промоутер")) return "Промоутер";
        if (r.includes("продавец")) return "Продавец";
        return "Продавец"; 
    };

    // --- АВТОРИЗАЦИЯ (Supabase) ---
    if (actionName === "loginByIIN") {
      const { iin, password } = payloadData;
      const { data, error } = await supabaseClient.from('users').select('*').eq('iin', iin).single();
      
      if (error || !data) return { success: false, error: "Этот ИИН не найден в базе данных" };
      if (String(data.password) !== String(password)) return { success: false, error: "Неверный пароль" };
      if (data.login_status === false || data.login_status === 'FALSE' || data.login_status === 'false') {
          return { success: false, error: "Доступ в систему запрещен администратором" };
      }
      return { 
          success: true, 
          token: 'sb_' + data.iin, 
          iin: data.iin, 
          firstName: data.full_name, 
          role: data.role, 
          dept: data.dept, 
          gender: data.gender, 
          isPromoter: data.role.toLowerCase().includes("промоутер") 
      };
    }
    
    // --- ЗАПИСЬ ДЕЙСТВИЙ ВРЕМЕНИ (Supabase) ---
    if (actionName === "recordAction") {
      const { iin, actionType, isReturn } = payloadData;
      const roleGroup = getRoleGroup(); 
      if (!isReturn) {
         const dayOfWeek = new Date().getDay() || 7; 
         const limitField = actionType === 'Обед' ? 'lunch_limit' : (actionType === 'Полдник' ? 'snack_limit' : 'break_limit');
         const { data: limitData } = await supabaseClient.from('time_limits').select('*').eq('role_group', roleGroup).eq('day_of_week', dayOfWeek).single();
         
         const maxAllowed = limitData ? limitData[limitField] : 1;
         const totalAllowed = limitData ? limitData.total_limit : 2;
         const todayStart = new Date(); todayStart.setHours(0,0,0,0);
         const { data: todayLogs } = await supabaseClient.from('time_tracking').select('*').eq('role_group', roleGroup).gte('created_at', todayStart.toISOString());
         
         let userStates = {};
         (todayLogs || []).forEach(log => {
             if (log.direction === 'Уход') userStates[log.iin] = log.action_type;
             if (log.direction === 'Возврат') delete userStates[log.iin];
         });
         let activeCounts = { 'Перерыв': 0, 'Обед': 0, 'Полдник': 0 };
         let totalOut = 0;
         for (let key in userStates) { activeCounts[userStates[key]]++; totalOut++; }
         
         if (activeCounts[actionType] >= maxAllowed || totalOut >= totalAllowed) return { success: false, error: `Мест на ${actionType} нет (лимит: ${maxAllowed})` };
      }
      const { error } = await supabaseClient.from('time_tracking').insert([{ iin: iin, action_type: actionType, direction: isReturn ? 'Возврат' : 'Уход', role_group: roleGroup }]);
      if (error) return { success: false, error: "Ошибка записи в БД" };
      return { success: true, savedAction: isReturn ? null : actionType };
    }

    // --- ПРОВЕРКА ЛИМИТОВ ПРИ ЗАПУСКЕ (Supabase) ---
    if (actionName === "startupCheck") {
      const roleGroup = getRoleGroup();
      const dayOfWeek = new Date().getDay() || 7;
      const { data: limitData } = await supabaseClient.from('time_limits').select('*').eq('role_group', roleGroup).eq('day_of_week', dayOfWeek).single();
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const { data: todayLogs } = await supabaseClient.from('time_tracking').select('*, users(full_name)').gte('created_at', todayStart.toISOString()).order('created_at', { ascending: true });
      
      let activeOutsMap = {};
      (todayLogs || []).forEach(log => {
          if (log.direction === 'Уход') {
              activeOutsMap[log.iin] = { action: log.action_type, leftAt: new Date(log.created_at).getTime(), name: log.users ? log.users.full_name : 'Сотрудник', role: log.role_group };
          } else { delete activeOutsMap[log.iin]; }
      });
      let myActiveAction = activeOutsMap[payloadData.iin] ? activeOutsMap[payloadData.iin].action : null;
      let outByAction = { 'Перерыв': 0, 'Обед': 0, 'Полдник': 0 };
      let totalOut = 0;
      for (let key in activeOutsMap) {
          if (activeOutsMap[key].role === roleGroup) { outByAction[activeOutsMap[key].action]++; totalOut++; }
      }
      return { 
          authorized: true, 
          activeOuts: Object.values(activeOutsMap).map(o => ({...o, limit: (o.action==='Обед'?40:o.action==='Полдник'?30:10)})), 
          myActiveAction: myActiveAction,
          canBreak: (outByAction['Перерыв'] < (limitData?.break_limit || 1)) && (totalOut < (limitData?.total_limit || 2)),
          canLunch: (outByAction['Обед'] < (limitData?.lunch_limit || 1)) && (totalOut < (limitData?.total_limit || 2)),
          canSnack: (outByAction['Полдник'] < (limitData?.snack_limit || 1)) && (totalOut < (limitData?.total_limit || 2))
      };
    }

    // --- ГЛАВНАЯ ЗАГРУЗКА ДАННЫХ (ГИБРИД: Supabase + GAS) ---
    if (actionName === "getDashboardData") {
      const { data: userData, error: userErr } = await supabaseClient.from('users').select('*').eq('iin', appState.iin).single();
      if (userErr || !userData) return { authorized: false };

      // 2. Делаем запрос в Google Таблицы (GAS) за гибридными данными
      let gasData = {};
      try {
        const gasResponse = await fetch(GAS_URL, { 
            method: "POST", 
            // ЗАГОЛОВКИ ДОБАВЛЕНЫ СЮДА:
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "getHybridData", payload: { iin: appState.iin, dept: userData.dept, role: userData.role, name: userData.full_name } }) 
        });
        gasData = await gasResponse.json();
        // ВЫВОДИМ ОТВЕТ В КОНСОЛЬ
        console.log("Ответ от Google Таблиц:", gasData);
      } catch (e) { 
        console.error("Ошибка связи с Google Таблицами:", e); 
      }

      // 3. Добираем запросы и историю из Supabase
      const { data: userHistory } = await supabaseClient.from('requests').select('*').eq('author_iin', appState.iin).order('created_at', { ascending: false });
      const { data: userInbox } = await supabaseClient.from('requests').select('*').eq('target_iin', appState.iin).eq('status', 'pending');
      
      // 4. Склеиваем всё вместе для фронтенда
      return {
        authorized: true, 
        role: userData.role, 
        name: userData.full_name, 
        dept: userData.dept, 
        isPromoter: userData.role.toLowerCase().includes("промоутер"),
        
        // Данные из GAS
        scItems: gasData.scItems || [], 
        adminPlan: gasData.adminPlan || formatPlanHtml([]), 
        info: gasData.info || { kpiValue: 90, ptsLeft: 0, ptsAccrued: 0, ptsUsed: 0, ptsFine: 0, tabel: {bs:0, bl:0, pr:0, ot:0, rd:0}, kpiDetails: [], reports: [], myPtsHistory: [] },
        
        // Данные из Supabase
        userHistory: userHistory || [], 
        userInbox: userInbox || []
      };
    }

    // --- ОТПРАВКА ЗАПРОСОВ (Supabase) ---
    if (actionName === "submitRequest") {
      const { type, details, targetIin, metadata } = payloadData;
      const { error } = await supabaseClient.from('requests').insert([{ 
          author_iin: appState.iin, 
          type: type, 
          details: details, 
          target_iin: targetIin, 
          metadata: metadata ? JSON.parse(metadata) : {}, 
          status: 'pending' 
      }]);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } 

  } catch (error) {
    console.error("Критическая ошибка:", error);
    return { success: false, error: "Системная ошибка сети или базы данных" };
  }
}

function vibrate(ms = 50) { if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light'); else if (navigator.vibrate) navigator.vibrate(ms); }

let autoScrollAnimation = true; let activeOutsTimer = null; let globalActiveOuts = []; let isUserPromoter = false; let currentAdminScDept = 'Цифра'; let currentEmpDept = 'Цифра'; let currentScTabDept = 'Цифра'; let pollingTimer = null; let lastActiveTab = 'time'; let processedReqIds = new Set(); let tradeInModelsGlobal = []; let selectedTradeInModel = null;

function saveMemory(key, value) { try { localStorage.setItem(key, value); } catch(e){} document.cookie = key + "=" + encodeURIComponent(value || "") + "; max-age=31536000; path=/"; }
function getMemory(key) { let val = null; try { val = localStorage.getItem(key); } catch(e){} if (!val) { let match = document.cookie.match(new RegExp('(^| )' + key + '=([^;]+)')); if (match) val = decodeURIComponent(match[2]); } return val; }
function clearMemory() { try { localStorage.clear(); } catch(e){} let cookies = document.cookie.split("; "); for (let c of cookies) document.cookie = c.split("=")[0] + "=; max-age=0; path=/"; }

let appState = { token: getMemory("userToken"), iin: getMemory("userIIN"), firstName: getMemory("userName") || "", currentAction: getMemory("currentAction"), role: getMemory("userRole") || "Продавец", dept: getMemory("userDept") || "Цифра", lastInboxCount: 0 };
let savedScrollPos = {}; 
function formatShortName(fullName) { if (!fullName) return ""; let p = String(fullName).trim().split(/\s+/); if (p.length > 1 && p[1]) return p[0] + " " + p[1].charAt(0).toUpperCase() + "."; return p[0]; }
let globalSellers = []; let globalScItems = []; let adminScItemsGlobal = []; let selectedScItem = null; let myReports = []; let myPointsHistory = []; let myDisplayPointsHistory = []; let myScHistory = []; let myKpiDetails = []; let allEmployeesData = []; let myMoneyFinesHistory = [];

function isCurrentMonth(dateStr) {
    if (!dateStr) return true;
    let d = new Date();
    let m = ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear();
    return String(dateStr).includes(m);
}

function getMonthName(dateStr) {
    if(!dateStr) return "Неизвестно";
    let parts = dateStr.split('.');
    if(parts.length < 2) return dateStr;
    let m = parseInt(parts[0], 10);
    let months = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    return (months[m-1] || parts[0]) + " " + (parts[1].length === 4 ? parts[1] : parts[2] || "");
}

function parseCustomDate(dStr) {
    if (!dStr) return 0;
    let parts = String(dStr).split(' ');
    let dParts = parts[0].split('.');
    if (dParts.length !== 3) return 0;
    let timeParts = parts[1] ? parts[1].split(':') : [0, 0];
    return new Date(dParts[2], dParts[1] - 1, dParts[0], timeParts[0] || 0, timeParts[1] || 0).getTime();
}

function groupAndRenderByMonth(itemsArray, renderItemFn) {
    if (!itemsArray || itemsArray.length === 0) return "<p style='color:gray;text-align:center;font-size:13px;'>История пуста</p>";
    let sortedArray = [...itemsArray].sort((a, b) => parseCustomDate(b.date) - parseCustomDate(a.date));
    let grouped = {};
    let currentMonthKey = ("0" + (new Date().getMonth() + 1)).slice(-2) + "." + new Date().getFullYear();
    sortedArray.forEach(i => {
        let key = "Неизвестно";
        let dStr = i.date || "";
        let match = String(dStr).match(/\d{2}\.(\d{2}\.\d{4})/);
        if (match) key = match[1];
        else if (String(dStr).match(/^\d{2}\.\d{4}$/)) key = dStr;
        if(!grouped[key]) grouped[key] = [];
        grouped[key].push(i);
    });
    let html = "";
    for(let m in grouped) {
        if (m !== currentMonthKey && m !== "Неизвестно") {
            html += `<div style="text-align:center; color:var(--text-color); opacity: 0.6; font-size:11px; font-weight:bold; margin: 15px 0 8px 0; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">${getMonthName(m)}</div>`;
        }
        grouped[m].forEach(i => { html += renderItemFn(i); });
    }
    return html;
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
      requestNotificationPermission(); initAutoScroll(); initSmartDates(); initSwipe(); 
      const urlParams = new URLSearchParams(window.location.search); const urlIin = urlParams.get('iin');
      
      if (urlIin && urlIin.length === 12) { 
          document.getElementById("iin-input").value = urlIin; 
          await manualLogin(); 
      } 
      else if (appState.iin && appState.token) { 
          document.getElementById("auth-screen").classList.add("hidden"); 
          document.getElementById("main-screen").classList.remove("hidden"); 
          if (appState.firstName) document.getElementById("user-greeting").innerText = appState.firstName; 
          await loadDashboard(false); 
          startPolling(); // <--- Вот здесь мы запускаем слушатель, который описан ниже
      } 
      else { 
          hideLoader(); 
          document.getElementById("auth-screen").classList.remove("hidden"); 
      }
  } catch (err) {
      console.error("Критическая ошибка при старте:", err);
      alert("Сбой загрузки: очищаю кэш");
      clearMemory();
      hideLoader();
      document.getElementById("auth-screen").classList.remove("hidden"); 
  }
});

function initSwipe() {
    let startX = 0, startY = 0; const scrollArea = document.getElementById('scrollable-body'); if (!scrollArea) return;
    scrollArea.addEventListener('touchstart', e => { startX = e.changedTouches[0].screenX; startY = e.changedTouches[0].screenY; }, {passive: true});
    scrollArea.addEventListener('touchend', e => {
        let endX = e.changedTouches[0].screenX; let endY = e.changedTouches[0].screenY; let diffX = endX - startX; let diffY = Math.abs(endY - startY);
        if (diffY < 60 && Math.abs(diffX) > 80) { 
            let roleStr = String(appState.role).toLowerCase(); 
            let isDir = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер");
            let isZavSklad = roleStr.includes("заведующий складом");
            let tabs = isDir ? ['adm-outs', 'adm-main', 'adm-inbox'] : 
                       isZavSklad ? ['adm-outs', 'adm-main', 'inbox'] : 
                       ['time', 'create', 'inbox'];
            let currentIdx = tabs.indexOf(lastActiveTab);
            if (currentIdx !== -1) { 
                if (diffX < 0 && currentIdx < tabs.length - 1) switchTab(tabs[currentIdx + 1], 'right'); 
                else if (diffX > 0 && currentIdx > 0) switchTab(tabs[currentIdx - 1], 'left'); 
            }
        }
    }, {passive: true});
}

function hideLoader() { const loader = document.getElementById("loader-screen"); loader.style.opacity = '0'; setTimeout(() => loader.classList.add("hidden"), 600); }
function showLoader() { const loader = document.getElementById("loader-screen"); loader.classList.remove("hidden"); setTimeout(() => loader.style.opacity = '1', 10); }

function forceLogout() {
    if(pollingTimer) clearInterval(pollingTimer); clearMemory(); appState.token = null; appState.iin = null; document.getElementById("main-screen").style.opacity = '0';
    setTimeout(() => { document.getElementById("main-screen").classList.add("hidden"); document.getElementById("auth-screen").classList.remove("hidden"); document.getElementById("auth-screen").style.opacity = '1'; document.getElementById("main-screen").style.opacity = '1'; document.getElementById("iin-input").value = ''; document.getElementById("iin-input").disabled = false; }, 600);
}

window.typingLockTime = 0;
document.addEventListener('focusin', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') window.typingLockTime = Date.now(); });
document.addEventListener('input', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') window.typingLockTime = Date.now(); });

function isSensitiveState() {
    if (lastActiveTab === 'inbox') return true;
    let activeEl = document.activeElement;
    let isTyping = activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT');
    let hasUnsavedText = false;
    document.querySelectorAll("textarea[id^='remark-reply-']").forEach(ta => { if(ta.value.length > 0) hasUnsavedText = true; });
    let isRecentlyTyping = (Date.now() - window.typingLockTime) < 10000;
    let isScOpen = document.getElementById("form-sc") && !document.getElementById("form-sc").classList.contains("hidden");
    let isTradeInOpen = document.getElementById("form-tradein") && !document.getElementById("form-tradein").classList.contains("hidden");
    let isPointsOpen = document.getElementById("form-points") && !document.getElementById("form-points").classList.contains("hidden");
    let isSwapOpen = document.getElementById("form-swap") && !document.getElementById("form-swap").classList.contains("hidden");
    let isDetailsFormOpen = false;
    document.querySelectorAll('[id^="fine-form-"], [id^="remark-form-"]').forEach(el => {
        if (!el.classList.contains("hidden")) isDetailsFormOpen = true;
    });
    return isTyping || isRecentlyTyping || hasUnsavedText || isScOpen || isTradeInOpen || isPointsOpen || isSwapOpen || isDetailsFormOpen;
}

function startPolling() {
    if(pollingTimer) clearInterval(pollingTimer);
    
    supabaseClient
      .channel('public-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, payload => {
         if(appState.token && !document.hidden && !isSensitiveState() && lastActiveTab !== 'inbox') {
             loadDashboard(true);
         }
      })
      // ВОТ СЮДА НУЖНО БЫЛО ВСТАВИТЬ ОБНОВЛЕНИЕ ЛИМИТОВ
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_tracking' }, async payload => {
         let state = await callBackend('startupCheck', { token: appState.token, iin: appState.iin });
         if(state) {
             globalActiveOuts = state.activeOuts || [];
             if (appState.role.toLowerCase().includes("директор") || appState.role.toLowerCase().includes("заведующий")) {
                 renderAdminOuts();
             } else {
                 applyLimits(state); // <--- МГНОВЕННАЯ БЛОКИРОВКА КНОПОК
             }
         }
      })
      .subscribe();

    pollingTimer = setInterval(async () => {
        if (lastActiveTab === 'inbox' || isSensitiveState()) return;
        if(appState.token && !document.hidden) {
            let data = await callBackend('getDashboardData', { token: appState.token }); 
            if (data && data.authorized !== false && !isSensitiveState() && lastActiveTab !== 'inbox') {
                renderDashboardData(data, true);
            }
        }
    }, 30000);
}

document.addEventListener('touchstart', function(e) {
  if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
    if (!document.activeElement.contains(e.target)) {
      document.activeElement.blur();
    }
  }
}, {passive: true});

async function manualLogin() {
  const elIin = document.getElementById("iin-input");
  const elPass = document.getElementById("password-input");
  const iinVal = elIin.value;
  const passVal = elPass.value;

  if (!iinVal || iinVal.length !== 12) {
      document.getElementById("login-error").innerText = "ИИН должен состоять из 12 цифр";
      return;
  }
  if (!passVal) {
      document.getElementById("login-error").innerText = "Введите пароль";
      return;
  }

  elIin.disabled = true;
  elPass.disabled = true;
  showToast("Авторизация...", false, 9999); 
  
  let res = await callBackend('loginByIIN', { iin: iinVal, password: passVal });
  
  if (res.success) {
      appState.iin = res.iin; 
      appState.token = res.token; 
      appState.firstName = res.firstName; 
      appState.currentAction = null; 
      isUserPromoter = res.isPromoter;
      
      saveMemory("userIIN", appState.iin); 
      saveMemory("userToken", appState.token); 
      saveMemory("userName", appState.firstName); 
      saveMemory("currentAction", ""); 
      
      document.getElementById("toast").classList.remove("show"); 
      document.getElementById("auth-screen").style.opacity = '0';
      
      setTimeout(() => { 
          document.getElementById("auth-screen").classList.add("hidden"); 
          document.getElementById("main-screen").classList.remove("hidden"); 
          document.getElementById("main-screen").style.opacity = '1'; 
          document.getElementById("user-greeting").innerText = appState.firstName; 
          loadDashboard(false); 
          startPolling(); 
      }, 600);
  } else { 
      elIin.disabled = false; 
      elPass.disabled = false;
      document.getElementById("login-error").innerText = res.error; 
      document.getElementById("toast").classList.remove("show"); 
  }
}

function setKpiColor(val, elCircle, elText) { let color = "#27ae60"; if (val >= 100) color = "#1e8449"; else if (val >= 80 && val < 90) color = "#f39c12"; else if (val < 80) color = "#e74c3c"; if(elCircle) { let trackColor = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'; elCircle.style.background = `conic-gradient(${color} ${val > 100 ? 100 : val}%, ${trackColor} 0)`; } if(elText) elText.style.color = color; return color; }

function switchTab(tab, direction = null) {
  let scroller = document.getElementById("scrollable-body");
  if (scroller && lastActiveTab) savedScrollPos[lastActiveTab] = scroller.scrollTop;

  if (tab !== 'details') lastActiveTab = tab; if(appState.token) loadDashboard(true);
  document.querySelectorAll('#main-tabs .icon-btn').forEach(btn => btn.classList.remove('active-tab')); 
  if(tab === 'time') document.getElementById('nav-time-icon').classList.add('active-tab'); 
  if(tab === 'create') document.getElementById('nav-create-icon').classList.add('active-tab'); 
  if(tab === 'inbox') document.getElementById('inbox-icon').classList.add('active-tab');
  if(tab === 'adm-outs') document.getElementById('nav-adm-outs').classList.add('active-tab');
  if(tab === 'adm-main') document.getElementById('nav-adm-main').classList.add('active-tab');
  if(tab === 'adm-inbox') document.getElementById('nav-adm-inbox').classList.add('active-tab');

  document.querySelectorAll('#scrollable-body > div').forEach(el => el.classList.add("hidden"));
  let sections = document.querySelectorAll('#scrollable-body > div'); let animClass = 'slide-up-fade'; if (direction === 'right') animClass = 'slide-in-right'; else if (direction === 'left') animClass = 'slide-in-left';
  sections.forEach(s => { s.classList.remove('fade-in', 'slide-up-fade', 'slide-in-right', 'slide-in-left'); s.style.animation = 'none'; s.offsetHeight; s.style.animation = null; });
  
  let roleStr = String(appState.role).toLowerCase(); 
  let isDir = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер"); 
  let isZavSklad = roleStr.includes("заведующий складом");
  let isSeller = !isUserPromoter && !isDir && !isZavSklad; 
  
  let isCreateTabActive = (tab === 'create'); let isAnyFormActive = isCreateTabActive && document.getElementById("menu-list").classList.contains("hidden");
  let dash = document.getElementById("info-dashboard"); if (isSeller && tab !== 'details' && !tab.startsWith('adm') && !isAnyFormActive) { if (dash.classList.contains("hidden")) { dash.classList.remove("hidden"); dash.classList.remove("fade-in", "slide-up-fade"); dash.classList.add("slide-down-fade"); } } else { dash.classList.add("hidden"); }
  
  let targetEl = document.getElementById("content-" + tab);
  if(targetEl) { targetEl.classList.remove("hidden"); targetEl.classList.add(animClass); }
  
  if(tab === 'adm-outs') renderAdminOuts(); 
  if(tab === 'adm-main') {
      if (isZavSklad && window.currentAdminMainView === 'plan') window.currentAdminMainView = 'emps';
      if (typeof window.currentAdminMainView === 'undefined') window.currentAdminMainView = isZavSklad ? 'emps' : 'plan';
      toggleAdminMain(window.currentAdminMainView); 
  }
  if(tab === 'adm-inbox') renderAdminHistory(currentHistFilter);
  
  if (scroller) {
      setTimeout(() => { scroller.scrollTop = savedScrollPos[tab] || 0; }, 10);
  }
}

function applyLimits(state) {
  if (!appState.currentAction) { document.getElementById("btn-break").disabled = !state.canBreak; document.getElementById("btn-lunch").disabled = !state.canLunch; document.getElementById("btn-snack").disabled = !state.canSnack; document.getElementById("action-hint").innerText = (state.canBreak || state.canLunch || state.canSnack) ? "Выберите действие:" : "Очередь заполнена или лимит исчерпан"; }
  if (state.activeOuts) { globalActiveOuts = state.activeOuts; renderActiveOuts(); }
}

function renderActiveOuts() {
   const container = document.getElementById("active-outs-container"); const list = document.getElementById("active-outs-list"); if (!globalActiveOuts || globalActiveOuts.length === 0) { container.classList.add("hidden"); if (activeOutsTimer) clearInterval(activeOutsTimer); return; } container.classList.remove("hidden");
   function updateTimers() { const now = Date.now(); list.innerHTML = globalActiveOuts.map(out => { let elapsedMin = Math.floor((now - out.leftAt) / 60000); let diffMin = out.limit - elapsedMin; let timeClass = ""; let timeText = ""; if (diffMin > 0) timeText = `Осталось ${diffMin} мин`; else { timeClass = "late"; timeText = `Опаздывает на ${Math.abs(diffMin)} мин!`; } let actionTitle = out.action; if(actionTitle.includes("Перерыв")) actionTitle = "Перерыв"; let rRole = out.role ? String(out.role) : ""; let roleLabel = rRole.toLowerCase().includes('промоутер') ? `<div style="font-size:11px; color:gray; font-weight:normal; margin-top:2px;">${rRole}</div>` : ''; return `<div class="active-out-item" style="align-items: center;"><div><span class="active-out-name">${out.name}</span> <span style="color:gray; font-weight:normal; font-size:11px; margin-left: 5px;">(${actionTitle})</span>${roleLabel}</div><span class="active-out-time ${timeClass}">${timeText}</span></div>`; }).join(""); }
   updateTimers(); if (activeOutsTimer) clearInterval(activeOutsTimer); activeOutsTimer = setInterval(updateTimers, 10000); 
}

async function triggerAction(actionType) { vibrate(50); let prevAction = appState.currentAction; appState.currentAction = actionType; saveMemory("currentAction", actionType); renderTimeUI(); let res = await callBackend('recordAction', { token: appState.token, iin: appState.iin, actionType: actionType, isReturn: false, isSilentAutoReturn: false }); if (res.success && res.savedAction) { appState.currentAction = res.savedAction; saveMemory("currentAction", res.savedAction); renderTimeUI(); let state = await callBackend('startupCheck', { token: appState.token, iin: appState.iin, tgUserId: null }); applyLimits(state); } else { appState.currentAction = prevAction; saveMemory("currentAction", prevAction || ""); renderTimeUI(); let state = await callBackend('startupCheck', { token: appState.token, iin: appState.iin, tgUserId: null }); applyLimits(state); showToast("Ошибка: " + res.error, true); } }
async function triggerReturn() { vibrate(50); const actionToReturnFrom = appState.currentAction; appState.currentAction = null; saveMemory("currentAction", ""); renderTimeUI(); document.querySelectorAll("#standard-buttons button").forEach(b => b.disabled = true); document.getElementById("btn-break").disabled = false; document.getElementById("action-hint").innerText = "Фиксируем возвращение..."; let res = await callBackend('recordAction', { token: appState.token, iin: appState.iin, actionType: actionToReturnFrom, isReturn: true, isSilentAutoReturn: false }); if (res.success) { document.getElementById("action-hint").innerText = "Обновление лимитов..."; let state = await callBackend('startupCheck', { token: appState.token, iin: appState.iin, tgUserId: null }); document.getElementById("action-hint").innerText = "Выберите действие:"; applyLimits(state); } else { appState.currentAction = actionToReturnFrom; saveMemory("currentAction", actionToReturnFrom); renderTimeUI(); showToast("Ошибка возврата: " + res.error, true); let state = await callBackend('startupCheck', { token: appState.token, iin: appState.iin, tgUserId: null }); applyLimits(state); } }

function getDeclension(action) { if (!action) return ""; if (action.startsWith("Перерыв")) return "Перерыва"; if (action === "Обед") return "Обеда"; if (action === "Полдник") return "Полдника"; return action.toLowerCase(); }

function renderTimeUI() { const standardBtns = document.getElementById("standard-buttons"); const returnContainer = document.getElementById("return-button-container"); let actStr = String(appState.currentAction); if (appState.currentAction && actStr !== "null" && actStr !== "undefined" && actStr !== "") { document.getElementById("btn-return").disabled = false; standardBtns.classList.add("hidden"); returnContainer.classList.remove("hidden"); const declension = getDeclension(appState.currentAction); document.getElementById("return-text").innerText = "Вернуться с " + declension; document.getElementById("action-hint").innerText = "Ожидаем возвращения:"; } else { standardBtns.classList.remove("hidden"); returnContainer.classList.add("hidden"); } }
function formatPointsNoun(num) { let n = Math.abs(parseFloat(String(num).replace(',','.'))); if (isNaN(n)) return "баллов"; if (n % 1 !== 0) return "балла"; n = Math.floor(n) % 100; let n10 = n % 10; if (n >= 11 && n <= 19) return "баллов"; if (n10 === 1) return "балл"; if (n10 >= 2 && n10 <= 4) return "балла"; return "баллов"; }
function formatNumberWithSpaces(x) { if (!x) return "0"; return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function getSourceColor(src) { let s = String(src).toLowerCase(); if(s.includes('фокус')) return '#e74c3c'; if(s.includes('сц')) return '#e67e22'; if(s.includes('trade-in')) return '#8e44ad'; if(s.includes('горячий')) return '#e84393'; if(s.includes('обмен')) return '#f39c12'; if(s.includes('исправл')) return '#3498db'; if(s.includes('мотивац')) return '#3390ec'; return '#7f8c8d'; }

function initSmartDates() { const today = new Date().toISOString().split('T')[0]; document.querySelectorAll('.smart-date').forEach(el => { el.dataset.realdate = today; el.value = "Сегодня"; el.addEventListener('focus', function() { this.type = 'date'; this.value = this.dataset.realdate; if(this.showPicker) this.showPicker(); }); el.addEventListener('blur', function() { if(!this.value) this.value = today; this.dataset.realdate = this.value; if (this.value === today) { this.type = 'text'; this.value = "Сегодня"; } else { this.type = 'text'; const d = new Date(this.value); this.value = ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear(); } }); el.addEventListener('change', function() { this.blur(); }); }); }
function initAutoScroll() { const scroller = document.getElementById("scroll-container"); let scrollDir = 1; let scrollTimer = setInterval(() => { if (!autoScrollAnimation || !scroller || scroller.closest('.hidden')) return; scroller.scrollLeft += 1 * scrollDir; if (scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1) scrollDir = -1; else if (scroller.scrollLeft <= 0) scrollDir = 1; }, 40); if(scroller) { scroller.addEventListener('touchstart', () => autoScrollAnimation = false, {passive: true}); scroller.addEventListener('touchend', () => { setTimeout(()=>autoScrollAnimation=true, 2000); }, {passive: true}); } }

async function openAdminPanel() { switchTab('adm-main'); toggleAdminMain('plan'); await loadDashboard(true); }

async function loadDashboard(isSilent = false) { 
  let cachedData = localStorage.getItem("dashData_" + appState.iin); 
  if (!isSilent) { 
    if (cachedData) { 
      try { 
        renderDashboardData(JSON.parse(cachedData), true); 
        let roleStr = String(appState.role).toLowerCase(); 
        let isDir = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер"); 
        let isZavSklad = roleStr.includes("заведующий складом");
        
        if (isDir) { switchTab('adm-main'); toggleAdminMain('plan'); } 
        else if (isZavSklad) { switchTab('adm-main'); toggleAdminMain('emps'); }
        else { switchTab('time'); } 
        hideLoader(); isSilent = true; 
      } catch(e) { localStorage.removeItem("dashData_" + appState.iin); showLoader(); } 
    } else showLoader(); 
  } 
  
  let data = await callBackend('getDashboardData', { token: appState.token }); 
  if (!data || data.error === "Оффлайн режим") { if (!isSilent) hideLoader(); return; } 
  if (data.authorized === false) { forceLogout(); return; } 
  
  let activeEl = document.activeElement;
  let isTyping = activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT');
  
  let hasUnsavedText = false;
  document.querySelectorAll("textarea[id^='remark-reply-']").forEach(ta => {
      if (ta.value.length > 0) hasUnsavedText = true;
  });

  localStorage.setItem("dashData_" + appState.iin, JSON.stringify(data)); 
  
  if (!isTyping && !hasUnsavedText) {
      renderDashboardData(data, isSilent); 
  }
  
  if (!isSilent) hideLoader(); 
  
  let roleStr = String(appState.role).toLowerCase(); 
  let isDir = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер"); 
  let isZavSklad = roleStr.includes("заведующий складом");
  let state = await callBackend('startupCheck', { token: appState.token, iin: appState.iin, tgUserId: null }); 
  
  if(state && state.authorized !== false) { 
      globalActiveOuts = state.activeOuts || [];
      if (!isDir && !isZavSklad) { appState.currentAction = state.myActiveAction || ""; saveMemory("currentAction", appState.currentAction); renderTimeUI(); applyLimits(state); } 
      else { if (!document.getElementById("content-adm-outs").classList.contains("hidden")) renderAdminOuts(); }
  }
}

function renderTradeInList() { let container = document.getElementById("tradein-list"); if (!container) return; container.innerHTML = tradeInModelsGlobal.map(m => { let isSel = (selectedTradeInModel === m); return `<div class="sc-item ${isSel ? 'selected' : ''}" onclick="selectTradeIn('${m}')"><div style="font-size:13px;">${m}</div></div>`; }).join(""); }
function selectTradeIn(m) { selectedTradeInModel = m; renderTradeInList(); }

function formatRemarkAuthor(name, role) {
    let r = String(role || "руководителя").toLowerCase();
    let decl = "руководителя";
    if (r.includes("директор")) decl = "директора";
    else if (r.includes("супервайзер")) decl = "супервайзера";
    else if (r.includes("управляющ")) decl = "управляющего";
    else if (r.includes("админ")) decl = "администратора";
    else if (r.includes("заведующий складом") || r.includes("зав. складом")) decl = "заведующего";

    let parts = String(name).trim().split(/\s+/);
    let shortName = parts[0];
    if (parts.length > 1 && parts[1]) shortName += " " + parts[1].charAt(0).toUpperCase() + ".";

    return `От ${decl} ${shortName}`;
}

function formatRemarkText(text, targetName = null) {
    if (!text) return "";
    let str = String(text);
    let splitRegex = /\n\n>\s*(.*?)\n/i;
    let parts = str.split(splitRegex);
    
    if (parts.length >= 3) {
        let main = parts[0];
        let authorLabel = parts[1];
        let quote = parts.slice(2).join("");
        return `${main}<div style="margin-top:8px; padding:8px 12px; background:var(--inner-bg); border-left:3px solid var(--btn-color); border-radius:0 8px 8px 0; font-style:italic; font-size:12px;"><b style="color:var(--btn-color); font-style:normal;">${authorLabel}</b><br>${quote}</div>`;
    }
    
    let oldRegex = /(Ответ.*?:\s*)/i;
    let oldParts = str.split(oldRegex);
    if (oldParts.length >= 3) {
        return `${oldParts[0]}<div style="margin-top:8px; padding:8px 12px; background:var(--inner-bg); border-left:3px solid var(--btn-color); border-radius:0 8px 8px 0; font-style:italic; font-size:12px;"><b style="color:var(--btn-color); font-style:normal;">${oldParts[1]}</b><br>${oldParts.slice(2).join("")}</div>`;
    }
    
    if (targetName) {
        let targetShort = targetName;
        let tParts = String(targetName).trim().split(/\s+/);
        if (tParts.length > 1 && tParts[1]) targetShort = tParts[0] + " " + tParts[1].charAt(0).toUpperCase() + ".";
        
        return `${str}<div style="margin-top:8px; padding:8px 12px; background:var(--inner-bg); border-left:3px solid gray; border-radius:0 8px 8px 0; font-style:italic; font-size:12px;"><b style="color:gray; font-style:normal;">${targetShort}</b><br><span style="color:gray;">Ожидает ответа...</span></div>`;
    }
    
    return str;
}

function renderDashboardData(data, isSilent = false) {
  if (!data) return;
  isUserPromoter = data.isPromoter || false; 
  appState.role = data.role || "Продавец"; 
  appState.dept = (data.info && data.info.dept) ? data.info.dept : "Цифра"; 
  saveMemory("userRole", appState.role); 
  saveMemory("userDept", appState.dept); 
  
  let roleStr = String(appState.role).toLowerCase(); 
  let isDir = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер"); 
  let isZavSklad = roleStr.includes("заведующий складом");
  let isSeller = !isUserPromoter && !isDir && !isZavSklad; 
  
  let elContentCreate = document.getElementById("content-create");
  let isCreateTabActive = elContentCreate && !elContentCreate.classList.contains("hidden"); 
  let elMenuList = document.getElementById("menu-list");
  let isAnyFormActive = isCreateTabActive && elMenuList && elMenuList.classList.contains("hidden"); 
  let dash = document.getElementById("info-dashboard");
  
  if (isZavSklad) {
      document.getElementById("nav-time-icon")?.classList.add("hidden"); 
      document.getElementById("nav-create-icon")?.classList.add("hidden"); 
      document.getElementById("inbox-icon")?.classList.remove("hidden");
      document.getElementById("nav-adm-outs")?.classList.remove("hidden"); 
      document.getElementById("nav-adm-main")?.classList.remove("hidden"); 
      document.getElementById("nav-adm-inbox")?.classList.add("hidden");
      
      let btnPlan = document.getElementById("btn-adm-plan");
      if (btnPlan) btnPlan.style.display = "none";
      
      let inboxTitle = document.querySelector("#content-inbox h3");
      if (inboxTitle) inboxTitle.innerText = "Входящие";

      if (window.currentAdminMainView === 'plan' || !window.currentAdminMainView) {
          window.currentAdminMainView = 'emps';
      }
      
      let match = roleStr.match(/заведующий складом\s+(цифра|мбт|кбт)/i);
      if (match && !window.zavScDeptSet) {
          let extracted = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
          appState.dept = extracted;
          currentAdminScDept = extracted;
          currentEmpDept = extracted;
          window.zavScDeptSet = true;
      }
      
      let filteredUserInbox = data.userInbox ? data.userInbox.filter(r => r && r.id && !processedReqIds.has(String(r.id))) : [];
      const uBadge = document.getElementById("user-badge"); 
      if (filteredUserInbox.length > 0) { 
          if(uBadge) { uBadge.innerText = filteredUserInbox.length; uBadge.classList.remove("hidden"); }
          if (filteredUserInbox.length > appState.lastInboxCount) showPushNotification("Уведомление!", "У вас новое уведомление"); 
          appState.lastInboxCount = filteredUserInbox.length; 
      } else { 
          if(uBadge) uBadge.classList.add("hidden"); 
          appState.lastInboxCount = 0;
      }
      
      if(document.querySelectorAll("#scrollable-body > div:not(.hidden)").length === 0) { switchTab('adm-main'); toggleAdminMain('emps'); }
  } 
  else if (isDir) {
      document.getElementById("nav-time-icon")?.classList.add("hidden"); 
      document.getElementById("nav-create-icon")?.classList.add("hidden"); 
      document.getElementById("inbox-icon")?.classList.add("hidden");
      document.getElementById("nav-adm-outs")?.classList.remove("hidden"); 
      document.getElementById("nav-adm-main")?.classList.remove("hidden"); 
      document.getElementById("nav-adm-inbox")?.classList.remove("hidden");
      
      let btnPlan = document.getElementById("btn-adm-plan");
      if (btnPlan) btnPlan.style.display = "";
      
      let filteredAdminInbox = data.adminInbox ? data.adminInbox.filter(r => r && r.id && !processedReqIds.has(String(r.id))) : [];
      const aBadge = document.getElementById("admin-badge"); 
      if (filteredAdminInbox.length > 0) { 
          if(aBadge) { aBadge.innerText = filteredAdminInbox.length; aBadge.classList.remove("hidden"); }
          if (filteredAdminInbox.length > appState.lastInboxCount) showPushNotification("Новая заявка!", "Появилась заявка в админке"); 
          appState.lastInboxCount = filteredAdminInbox.length; 
      } else { 
          if(aBadge) aBadge.classList.add("hidden"); 
          appState.lastInboxCount = 0; 
      }
      let adminPlanList = document.getElementById("admin-plan-list");
      if(adminPlanList) adminPlanList.innerHTML = data.adminPlan || "<p>План не загружен</p>"; 
      
      if(document.querySelectorAll("#scrollable-body > div:not(.hidden)").length === 0) { switchTab('adm-main'); toggleAdminMain('plan'); }
  } else {
      if (isUserPromoter) { 
          document.getElementById("nav-create-icon")?.classList.add("hidden"); 
          document.getElementById("inbox-icon")?.classList.add("hidden"); 
          let db = document.getElementById("desc-break"); if(db) db.innerText = "15 мин"; 
          let dl = document.getElementById("desc-lunch"); if(dl) dl.innerText = "1 час"; 
          let ds = document.getElementById("desc-snack"); if(ds) ds.innerText = "30 мин"; 
          if(dash) dash.classList.add("hidden"); 
      } else { 
          document.getElementById("nav-time-icon")?.classList.remove("hidden"); 
          document.getElementById("nav-create-icon")?.classList.remove("hidden"); 
          document.getElementById("inbox-icon")?.classList.remove("hidden"); 
          let db = document.getElementById("desc-break"); if(db) db.innerText = "10 мин"; 
          let dl = document.getElementById("desc-lunch"); if(dl) dl.innerText = "40 мин"; 
          let ds = document.getElementById("desc-snack"); if(ds) ds.innerText = "30 мин"; 
          if (isSeller && document.querySelectorAll("#content-adm-main:not(.hidden)").length === 0 && document.querySelectorAll("#content-details:not(.hidden)").length === 0 && !isAnyFormActive) { 
              if (dash && dash.classList.contains("hidden")) { 
                  dash.classList.remove("hidden"); dash.classList.remove("fade-in", "slide-up-fade"); dash.classList.add("slide-down-fade"); 
              } 
          } else { 
              if(dash) dash.classList.add("hidden"); 
          } 
      }
      document.getElementById("nav-adm-outs")?.classList.add("hidden"); 
      document.getElementById("nav-adm-main")?.classList.add("hidden"); 
      document.getElementById("nav-adm-inbox")?.classList.add("hidden");
      
      let filteredUserInbox = data.userInbox ? data.userInbox.filter(r => r && r.id && !processedReqIds.has(String(r.id))) : [];
      const uBadge = document.getElementById("user-badge"); 
      if (filteredUserInbox.length > 0) { 
          if(uBadge) { uBadge.innerText = filteredUserInbox.length; uBadge.classList.remove("hidden"); }
          if (filteredUserInbox.length > appState.lastInboxCount) showPushNotification("Уведомление!", "Непрочитанные сообщения"); 
          appState.lastInboxCount = filteredUserInbox.length; 
      } else { 
          if(uBadge) uBadge.classList.add("hidden"); 
          appState.lastInboxCount = 0;
      }
      if(document.querySelectorAll("#scrollable-body > div:not(.hidden)").length === 0) switchTab('time');
  }

  let pAcc = document.getElementById("pt-acc"); if(pAcc) pAcc.innerText = data.info?.ptsAccrued ?? '-'; 
  let pUse = document.getElementById("pt-use"); if(pUse) pUse.innerText = data.info?.ptsUsed ?? '-'; 
  const remVal = parseFloat(String(data.info?.ptsLeft).replace(',','.')) || 0; 
  const ptRemEl = document.getElementById("pt-rem"); 
  if(ptRemEl) {
      ptRemEl.innerText = data.info?.ptsLeft ?? '-'; 
      ptRemEl.style.color = remVal >= 0 ? "#27ae60" : "#e67e22"; 
  }
  let pFin = document.getElementById("pt-fin"); if(pFin) pFin.innerText = data.info?.ptsFine ?? '-'; 
  
  let kpiValue = data.info?.kpiValue ?? data.baseKpi ?? 0; 
  let kValEl = document.getElementById("kpi-val"); if(kValEl) kValEl.innerText = kpiValue + '%'; 
  setKpiColor(kpiValue, document.getElementById("kpi-circle"), document.getElementById("kpi-val")); 
  myKpiDetails = data.info?.kpiDetails || [];
  
  let infoTabel = document.getElementById("info-tabel");
  if(infoTabel) {
      infoTabel.innerHTML = `<div class="tabel-item" style="color:#f39c12"><span class="tabel-lbl">БС.</span>${data.info?.tabel?.bs ?? 0}</div><div class="tabel-item" style="color:#e67e22"><span class="tabel-lbl">БЛ.</span>${data.info?.tabel?.bl ?? 0}</div><div class="tabel-item" style="color:#e74c3c"><span class="tabel-lbl">ПР.</span>${data.info?.tabel?.pr ?? 0}</div><div class="tabel-item" style="color:#f1c40f"><span class="tabel-lbl">ОТ.</span>${data.info?.tabel?.ot ?? 0}</div><div class="tabel-item" style="color:#27ae60"><span class="tabel-lbl">РД.</span>${data.info?.tabel?.rd ?? 0}</div>`;
  }

  myReports = data.info?.reports || []; 
  myPointsHistory = data.info?.myPtsHistory || []; 
  myMoneyFinesHistory = myPointsHistory.filter(p => p && p.moneyFine && p.moneyFine !== "0" && p.moneyFine !== ""); 
  myScHistory = myPointsHistory.filter(p => p && p.type === "Начисление");
  myDisplayPointsHistory = myPointsHistory.filter(p => { 
      let ptsVal = parseFloat(String(p.val).replace(',', '.')) || 0; 
      if (p.type === "KPI" && p.source !== "Горячий чек") return false; 
      if (p.type === "KPI" && p.source === "Горячий чек" && ptsVal === 0) return false;
      return ptsVal !== 0; 
  });

  let currentMonth = new Date().getMonth() + 1; let currentYear = new Date().getFullYear(); let monthSuffix = ("0" + currentMonth).slice(-2) + "." + currentYear; 
  let monthSc = myScHistory.filter(p => p && typeof p.date === 'string' && p.date.includes(monthSuffix)); 
  
  let countSc = monthSc.filter(p => p && p.source && !String(p.source).toLowerCase().includes("trade-in")).length; 
  let countTrade = monthSc.filter(p => p && p.source && String(p.source).toLowerCase().includes("trade-in")).length; 
  
  let scEl = document.getElementById("info-sc-val"); 
  if(scEl) {
      scEl.innerText = `${countSc} | ${countTrade}`; 
      if (countSc + countTrade > 0) scEl.style.color = "#27ae60"; else scEl.style.color = "#e74c3c"; 
  }

  let hcCard = document.getElementById("hot-check-card");
  if (hcCard && data.hotChecks && data.hotChecks.length > 0) {
      let hcHtml = `<h3 style="margin-bottom: 10px; font-size: 14px;">Горячий чек</h3>`;
      let groups = {};
      data.hotChecks.forEach(hc => { if(!groups[hc.sub]) groups[hc.sub] = []; groups[hc.sub].push(hc); });
      
      for(let sub in groups) {
          if (sub) hcHtml += `<div style="margin-bottom: 8px; font-size:12px; font-weight:bold; color:gray; border-top: 1px solid var(--border-color); padding-top: 10px; margin-top: 10px;">${sub}</div>`;
          let colsCount = Math.min(groups[sub].length, 4);
          hcHtml += `<div style="display: grid; grid-template-columns: repeat(${colsCount}, 1fr); gap: 6px; margin-bottom: 6px;">`;
          groups[sub].forEach(btn => {
              let combinedName = sub ? `${sub} ${btn.name}` : btn.name;
              let badgeHtml = "";
              let ptsVal = parseFloat(String(btn.pts || "0").replace(',', '.'));
              if (ptsVal > 0) {
                  badgeHtml = `<span style="position:absolute; top:-8px; right:-6px; background:#e74c3c; color:white; font-size:10px; font-weight:bold; padding:2px 5px; border-radius:10px; border: 2px solid var(--card-bg); box-shadow: 0 2px 4px rgba(0,0,0,0.2); z-index: 5;">+${btn.pts}</span>`;
              }
              hcHtml += `<div style="position:relative; display:flex; flex:1;"><button class="btn-green" style="padding:10px 4px; font-size:12px; margin:0; width:100%;" onclick="submitHotCheck('${combinedName}', '${btn.val}', '${btn.pts || 0}')">${btn.name}</button>${badgeHtml}</div>`;
          });
          hcHtml += `</div>`;
      }
      hcCard.innerHTML = hcHtml;
      hcCard.classList.remove("hidden");
  } else if (hcCard) {
      hcCard.classList.add("hidden");
  }
    
  let savedReplies = {};
  document.querySelectorAll("textarea[id^='remark-reply-']").forEach(ta => { savedReplies[ta.id] = ta.value; });

  let uInbox = data.userInbox ? data.userInbox.filter(r => r && r.id && !processedReqIds.has(String(r.id))) : []; 
  let inboxList = document.getElementById("inbox-list");
  if(inboxList) {
      inboxList.innerHTML = uInbox.map(r => { 
        let desc = formatRemarkText(r.details || "");
        let authorStr = r.type === "Замечание" ? formatRemarkAuthor(r.authorName, r.authorRole) : `<b>От:</b> ${r.authorName}`;
        let d = r.date ? String(r.date) : "";
        
        if (r.status === "rejected_notify_zav") return `<div class="req-item" id="req-${r.id}" style="border-left-color: #e74c3c;"><div class="req-title">❌ Штраф отклонен</div><div class="req-desc">Ваш запрос на штраф сотрудника <b>${r.targetName}</b> отклонен: <b>${formatShortName(r.approver) || 'Руководителем'}</b>.<br>Причина штрафа: ${desc}</div><div class="grid-btns" style="grid-template-columns: 1fr;"><button class="btn-gray" onclick="processReq('${r.id}', 'dismiss_notification')">Ознакомлен</button></div></div>`;
        if (r.status === "approved_notify_zav") return `<div class="req-item" id="req-${r.id}" style="border-left-color: #27ae60;"><div class="req-title">✅ Штраф одобрен</div><div class="req-desc">Ваш запрос на штраф сотрудника <b>${r.targetName}</b> одобрен: <b>${formatShortName(r.approver) || 'Руководителем'}</b>.<br>Причина штрафа: ${desc}</div><div class="grid-btns" style="grid-template-columns: 1fr;"><button class="btn-gray" onclick="processReq('${r.id}', 'dismiss_notification')">Ознакомлен</button></div></div>`;

        if (r.type === "Замечание" && (r.status === "pending_user_reply" || r.status === "pending_admin_view_remark")) { 
            if (r.targetIin === appState.iin && r.status === "pending_user_reply") {
                return `<div class="req-item" id="req-${r.id}" style="border-left-color: #f39c12;"><div class="req-title" style="color:#f39c12;">⚠️ Замечание <span style="float:right; color:gray; font-size:10px; font-weight:normal;">${d}</span></div><div class="req-desc" style="color:var(--text-color); font-size:13px;"><b style="color:#f39c12;">${authorStr}</b><br>${desc}</div><textarea id="remark-reply-${r.id}" placeholder="Ваша обратная связь..." style="box-sizing: border-box; width:100%; height:60px; margin-bottom:8px; border-radius:8px; padding:8px; border:1px solid var(--border-color); background:var(--bg-color); color:var(--text-color); font-family:inherit; resize:none;"></textarea><button class="btn-orange" onclick="processReq('${r.id}', 'reply_remark', document.getElementById('remark-reply-${r.id}').value)">Ответить</button></div>`; 
            } else {
                return `<div class="req-item" id="req-${r.id}" style="border-left-color: #f39c12;"><div class="req-title" style="color:#f39c12;">⚠️ Замечание <span style="float:right; color:gray; font-size:10px; font-weight:normal;">${d}</span></div><div class="req-desc" style="color:var(--text-color); font-size:13px;"><b style="color:#f39c12;">${authorStr}</b><br><b>${r.targetName}</b> — ${desc}</div><div class="grid-btns" style="grid-template-columns: 1fr;"><button class="btn-gray" onclick="processReq('${r.id}', 'dismiss_notification')">Просмотрено</button></div></div>`;
            }
        }
        
        if (r.status === "rejected_notify_user") return `<div class="req-item" id="req-${r.id}" style="border-left-color: #e74c3c;"><div class="req-title">❌ Запрос отклонен</div><div class="req-desc">Ваш запрос на <b>${r.type || 'запрос'}</b> был отклонен.<br>Детали: ${desc}</div><div class="grid-btns" style="grid-template-columns: 1fr;"><button class="btn-gray" onclick="processReq('${r.id}', 'dismiss_rejection')">Ознакомлен</button></div></div>`; 
        
        if (r.status === "notify_user_fine") {
            let metaObj = {}; try { metaObj = JSON.parse(r.meta || "{}"); } catch(e){}
            let authorDetails = formatRemarkAuthor(r.authorName, r.authorRole); 
            return `<div class="req-item" id="req-${r.id}" style="border-left-color: #e74c3c;"><div class="req-title" style="color: #e74c3c;">⚠️ Вам выписан штраф <span style="float:right; color:gray; font-size:10px; font-weight:normal;">${d}</span></div><div class="req-desc"><b style="color:#e74c3c;">${authorDetails}</b><br><b>Причина:</b> ${desc}<br>Баллы: <b style="color:#e74c3c;">${metaObj.amount || 0}</b> | Сумма: <b style="color:#e74c3c;">${metaObj.moneyAmount || 0} ₸</b></div><div class="grid-btns" style="grid-template-columns: 1fr;"><button class="btn-gray" onclick="processReq('${r.id}', 'dismiss_notification')">Ознакомлен</button></div></div>`;
        }

        return `<div class="req-item" id="req-${r.id}"><div class="req-title">Обмен сменами</div><div class="req-desc">${r.authorName || 'Коллега'} просит поменяться.<br><b>${desc}</b></div><div class="grid-btns"><button class="btn-red" onclick="processReq('${r.id}', 'reject_user')">Отклонить</button><button class="btn-green" onclick="processReq('${r.id}', 'approve_user')">Одобрить</button></div></div>`; 
      }).join("") || "<p style='color:gray;text-align:center;font-size:13px;'>Уведомлений нет</p>";

      Object.keys(savedReplies).forEach(id => { let ta = document.getElementById(id); if (ta) ta.value = savedReplies[id]; });

      let uHistory = data.userHistory || [];
      
      uHistory = uHistory.filter(r => !(r.type === "Запрос на штраф" && r.targetIin === appState.iin));

      let uHistList = document.getElementById("user-history-list");
      if (uHistList) {
          uHistList.innerHTML = groupAndRenderByMonth(uHistory, r => {
              let stText = "Просмотрен"; let stColor = "#95a5a6";
              if (r.status.includes("approved")) { stText = "Одобрен"; stColor = "#27ae60"; } else if (r.status.includes("rejected")) { stText = "Отклонен"; stColor = "#e74c3c"; }
              
              if (r.type === "Исправление смены") {
                  if (r.status.includes("approved")) stText = "Исправлен";
                  else if (r.status.includes("rejected")) stText = "Отклонен";
              }

              let desc = r.type === "Обмен сменами" ? `Сменщик: ${r.targetName || ''}<br>${r.details || ''}` : (r.details || ''); 
              desc = formatRemarkText(desc, r.type === 'Замечание' ? r.targetName : null);
              let finalDescHtml = r.type === "Замечание" ? `<b>${r.targetName}</b> — ${desc}` : `<b>Суть:</b> ${desc}`;
              let authorStr = r.type === "Замечание" || r.type === "Запрос на штраф" ? `<b style="color:#f39c12;">${formatRemarkAuthor(r.authorName, r.authorRole)}</b>` : `<b>От:</b> ${r.authorName || ''}`;

              if (r.type === "Уведомление о штрафе") {
                  stColor = "#e74c3c"; 
                  stText = "Ознакомлен";
                  let metaObj = {}; try { metaObj = JSON.parse(r.meta || r.metadata); } catch(e){}
                  desc = `<b>Причина:</b> ${metaObj.reason || desc}<br>Баллы: <b style="color:#e74c3c;">${metaObj.amount}</b> | Сумма: <b style="color:#e74c3c;">${metaObj.moneyAmount} ₸</b>`;
                  authorStr = `<b style="color:#e74c3c;">${formatRemarkAuthor(r.authorName, r.authorRole)}</b>`; 
                  finalDescHtml = desc; 
                  r.type = "Штраф"; 
              } 
              else if (r.type === "Запрос на штраф") { 
                  let metaObj = {}; try { metaObj = JSON.parse(r.meta || r.metadata); } catch(e){} 
                  desc = `Нарушитель: <b>${r.targetName}</b><br>Причина: ${metaObj.reason || desc}<br>Баллы: <b style="color:#e74c3c;">${metaObj.amount}</b> | Сумма: <b style="color:#e74c3c;">${metaObj.moneyAmount} ₸</b>`; 
                  finalDescHtml = `<b>Суть:</b> ${desc}`;
              }

              return `<div class="req-item" style="border-left-color: ${stColor}; opacity: 0.9;"><div class="req-title" style="color:var(--btn-color);">${r.type || 'Запрос'} <span style="font-size:12px; font-weight:normal; color:gray; float:right;">${r.date || ''}</span></div><div class="req-desc" style="color:var(--text-color);">${authorStr}<br>${finalDescHtml}<br><div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;"><b style="color:${stColor}">Статус: ${stText}</b></div></div></div>`; 
          });
      }
  }
  
  let aInbox = data.adminInbox ? data.adminInbox.filter(r => r && r.id && !processedReqIds.has(String(r.id))) : []; 
  let adminList = document.getElementById("admin-list");
  if(adminList) {
      adminList.innerHTML = aInbox.map(r => { 
          let btns = `<div class="grid-btns"><button class="btn-red" onclick="processReq('${r.id}', 'reject_admin')">Отклонить</button><button class="btn-green" onclick="processReq('${r.id}', 'approve_admin')">Подтвердить</button></div>`; 
          let desc = r.type === "Обмен сменами" ? `Сменщик: ${r.targetName || ''}<br>${r.details || ''}` : (r.details || ''); 
          desc = formatRemarkText(desc);
          
          if (r.type === "Запрос на штраф") {
              let metaObj = {}; try { metaObj = JSON.parse(r.meta || r.metadata); } catch(e){}
              desc = `Нарушитель: <b>${r.targetName}</b><br>Причина: ${metaObj.reason || desc}<br>Баллы: <b style="color:#e74c3c;">${metaObj.amount}</b> | Сумма: <b style="color:#e74c3c;">${metaObj.moneyAmount} ₸</b>`;
          }
          
          if (r.type === "Замечание") {
              desc = `<b>${r.targetName}</b> — ${desc}`;
              btns = `<div class="grid-btns" style="grid-template-columns: 1fr;"><button class="btn-gray" onclick="processReq('${r.id}', 'dismiss_notification')">Просмотрено</button></div>`;
          }

          let authorStr = r.type === "Замечание" ? `<b style="color:#f39c12;">${formatRemarkAuthor(r.authorName, r.authorRole)}</b>` : `<b>От:</b> ${r.adminDisplayName || r.authorName || ''}`;
          let finalDescHtml = r.type === "Замечание" ? desc : `<b>Суть:</b> ${desc}`;

          return `<div class="req-item admin" id="req-${r.id}"><div class="req-title">${r.type || 'Запрос'} <span style="font-size:12px; font-weight:normal; color:gray; float:right;">${r.date || ''}</span></div><div class="req-desc" style="color:var(--text-color);">${authorStr}<br>${finalDescHtml}</div>${btns}</div>` 
      }).join("") || "<p style='color:gray;text-align:center;font-size:13px;'>Новых запросов нет</p>";
  }

  window.adminHistoryGlobal = data.adminHistory || [];
  if(isDir && typeof renderAdminHistory === "function") renderAdminHistory();
  
  adminScItemsGlobal = data.adminScItems || []; 
  globalSellers = data.sellers || []; 
  globalScItems = data.scItems || []; 
  allEmployeesData = data.adminEmployees || []; 
  tradeInModelsGlobal = data.tradeInModels || []; 
  
  if ((isDir || isZavSklad) && typeof renderAdminEmps === "function") renderAdminEmps(currentEmpDept, null);
}

function generateHorizontalGrid(dataObj) { if (!dataObj.headers || dataObj.headers.length === 0) return "<div style='padding:8px;text-align:center;color:gray;font-size:12px;'>Нет данных</div>"; let gridCols = `repeat(${dataObj.headers.length}, 1fr)`; let html = `<div class="grid-details-container inner-block"><div class="grid-details-title" style="margin-bottom: 6px;">${dataObj.title}</div><div class="grid-details-box" style="grid-template-columns: ${gridCols}; gap:3px;">`; dataObj.headers.forEach(h => { html += `<div class="grid-details-header">${h || '-'}</div>`; }); dataObj.values.forEach(v => { let displayVal = '-'; if (v === '✔') displayVal = '✅'; else if (v === '✖') displayVal = '❌'; else if (v === 'ПР') displayVal = '<span style="color:#e74c3c;font-weight:bold;">ПР</span>'; else if (v !== '' && v !== '-') displayVal = '<span style="color:#f39c12;font-weight:bold;">'+v+'</span>'; else displayVal = v || '-'; html += `<div class="grid-details-value" style="background:var(--bg-color); border:1px solid var(--border-color); border-radius:6px; padding:4px 0; display:flex; align-items:center; justify-content:center; min-height:28px; width:100%; box-sizing:border-box;">${displayVal}</div>`; }); html += `</div></div>`; return html; }

function renderHistoryItem(i, isCompact = false) { 
    let roleStr = String(appState.role).toLowerCase(); 
    let isDirOrZav = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер") || roleStr.includes("заведующий складом"); 
    
    let valStr = String(i.val).replace('.', ','); 
    let col = String(i.type).toLowerCase().includes('начисл') || valStr.includes('+') ? 'detail-plus' : 'detail-minus'; 
    if(String(i.type).toLowerCase().includes('штраф')) col = 'detail-fine'; 
    
    let typeColor = "#95a5a6"; 
    let typeDisplay = i.type; 
    let srcColor = getSourceColor(i.source); 
    
    if (String(i.type).toLowerCase() === "начисление") {
        typeColor = "#27ae60"; 
    } else if (String(i.type).toLowerCase().includes('использ')) {
        typeColor = "#f39c12"; 
    } else if (String(i.type).toLowerCase().includes('штраф')) {
        typeColor = "#e74c3c"; 
    } else if (String(i.type).toLowerCase() === "kpi" && i.source === "Горячий чек") { 
        typeColor = "#27ae60"; 
        typeDisplay = "Начисление"; 
        col = "detail-plus"; 
        i.approver = ""; 
    }
    
    let rightText = String(i.type).toLowerCase().includes('штраф') ? (isDirOrZav ? i.source : "") : i.approver; 
    rightText = formatShortName(rightText); 

    let isCurrent = isCurrentMonth(i.date);
    if (!isDirOrZav && !isCurrent) {
        rightText = ""; 
        if (String(i.type).toLowerCase().includes('штраф')) {
            i.source = ""; 
        }
    }
    
    let approverHtml = (rightText) ? `<span style="color:gray; font-size:10px; font-weight:normal;">${rightText}</span>` : ''; 
    let sourceHtml = String(i.type).toLowerCase().includes('штраф') ? `<span style="color:gray;font-size:10px;">${i.date}</span>` : `<b style="color:${srcColor}; font-size:10px;">${i.source}</b> <span style="color:gray;font-size:10px;"> • ${i.date}</span>`; 
    
    let inner = `<div style="flex:1;"><b style="font-size:12px; color:${typeColor}; display:inline-block; margin-bottom:3px;">${typeDisplay}</b><br><span style="color:var(--text-color); font-size:12px; display:inline-block; margin-bottom:3px;">${i.reason}</span><br><div style="display:flex; justify-content:space-between; align-items:center;"><div>${sourceHtml}</div>${approverHtml}</div></div><span class="${col}" style="margin-left:10px;">${valStr}</span>`; 
    
    if (isCompact) {
        return `<div class="req-item" style="border-left-color: ${typeColor}; border-left-width: 2px; padding: 8px 10px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">${inner}</div>`; 
    }
    return `<div class="detail-item">${inner}</div>`; 
}

function renderMoneyFineItem(i) { let roleStr = String(appState.role).toLowerCase(); let isDirOrZav = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер") || roleStr.includes("заведующий складом"); let moneyVal = i.moneyFine ? String(i.moneyFine).replace('.',',') : "0"; let formatted = formatNumberWithSpaces(moneyVal); let issuerHtml = (i.source && isDirOrZav) ? `<span style="color:gray; font-size:10px; font-weight:normal;">${formatShortName(i.source)}</span>` : ''; return `<div class="req-item" style="border-left-color: #e74c3c; border-left-width: 2px; padding: 10px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;"><div style="flex:1;"><b style="font-size:12px; color:#e74c3c; display:inline-block; margin-bottom:3px;">Штраф</b><br><span style="color:var(--text-color); font-size:12px; display:inline-block; margin-bottom:3px;">${i.reason}</span><br><div style="display:flex; justify-content:space-between; align-items:center;"><div><span style="color:gray;font-size:10px;">${i.date}</span></div>${issuerHtml}</div></div><span class="detail-fine" style="margin-left:10px;">${formatted} ₸</span></div>`; }

function openDetails(type) {
  let prevTab = lastActiveTab; 
  switchTab('details'); document.getElementById("btn-details-back").onclick = () => switchTab(prevTab); 
  document.getElementById("details-kpi-circle-container").innerHTML = ""; let listHtml = "";
  if (type === 'sc') { 
      document.getElementById("details-title").innerText = "Детали СЦ | BRZY"; 
      listHtml = "<div class='card' style='padding:0;'>"; 
      let currentSc = myScHistory.filter(i => isCurrentMonth(i.date));
      currentSc.sort((a, b) => parseCustomDate(b.date) - parseCustomDate(a.date));
      
      if (currentSc.length > 0) {
          listHtml += currentSc.map((i, idx) => { let srcColor = getSourceColor(i.source); return `<div class="detail-item"><div><span style="color:var(--text-color); font-size:12px;">${idx + 1}. ${i.reason}</span><br><b style="color:${srcColor}; font-size:10px; display:inline-block; margin-top:3px;">${i.source}</b> <span style="color:gray;font-size:10px;"> • ${i.date}</span></div></div>`; }).join(""); 
      } else listHtml += "<div style='padding:15px;text-align:center;color:gray;font-size:13px;'>В текущем месяце пусто</div>"; 
      listHtml += "</div>"; 
  } 
  else if (type === 'points') { 
      document.getElementById("details-title").innerText = "История Баллов"; 
      listHtml = "<div class='card' style='padding:0; border:none; background:transparent;'>"; 
      listHtml += groupAndRenderByMonth(myDisplayPointsHistory, i => renderHistoryItem(i, true));
      listHtml += "</div>"; 
  } 
  else if (type === 'kpi') { 
      document.getElementById("details-title").innerText = "Детали КФ. ЭФФ."; 
      listHtml = "<div class='card' style='padding:0;'>"; 
      let currentKpi = myKpiDetails.filter(k => isCurrentMonth(k.date));
      currentKpi.forEach(k => { 
          let col = k.val > 0 ? 'detail-plus' : (k.val < 0 ? 'detail-minus' : 'detail-val'); let valStr = k.val > 0 ? `+${k.val}%` : `${k.val}%`; let srcColor = getSourceColor(k.source); let dispName = k.name.replace(/^(Фокус|Trade-In|СЦ|Горячий чек)[\s\|:]*/i, '').trim(); if (!dispName) dispName = k.name; if (k.source === "База" || k.name === "Ошибки") dispName = k.name; if (k.name === "Больничный" || k.name === "Прогул") { dispName = k.name; srcColor = "#7f8c8d"; } let dateStr = k.date ? `<span style="color:gray;font-size:10px; margin-left:5px;"> • ${k.date}</span>` : ""; listHtml += `<div class="detail-item"><div><span style="color:var(--text-color); font-size:12px; display:inline-block; margin-bottom:3px;">${dispName}</span><br><b style="color:${srcColor}; font-size:10px;">${k.source}</b>${dateStr}</div><span class="${col}">${valStr}</span></div>`; 
      }); 
      listHtml += "</div>"; 
  }
  else if (type === 'report') { document.getElementById("details-title").innerText = "Мои отчеты"; listHtml = "<div style='padding-top:5px;'>"; listHtml += myReports.map(generateHorizontalGrid).join(''); listHtml += "</div>"; }
  else if (type === 'tabel') { 
      document.getElementById("btn-details-back").onclick = () => switchTab(lastActiveTab); 
      document.getElementById("details-title").innerText = "Нарушения (Штрафы и Замечания)"; 
      listHtml = "<div style='padding-top:5px;'>"; 
      
      let currentFines = myMoneyFinesHistory.filter(i => isCurrentMonth(i.date));
      currentFines.sort((a, b) => parseCustomDate(b.date) - parseCustomDate(a.date));
      
      if (currentFines.length > 0) listHtml += currentFines.map(i => renderMoneyFineItem(i)).join(""); 
      else listHtml += "<div style='padding:15px;text-align:center;color:gray;font-size:13px;'>Штрафов в этом месяце нет</div>"; 
      
      let myRemarks = JSON.parse(localStorage.getItem("dashData_" + appState.iin))?.info?.remarks || []; 
      if (myRemarks.length > 0) {
          listHtml += `<div class="grid-details-title" style="color:#f39c12; margin-top:10px;">Замечания</div>` + groupAndRenderByMonth(myRemarks, r => { 
              let authorStr = formatRemarkAuthor(r.authorName, r.authorRole); 
              return `<div class="req-item" style="border-left-color: #f39c12; margin-bottom:8px;"><div class="req-title" style="color:#f39c12; font-size:12px;">${authorStr} <span style="float:right; color:gray; font-size:10px;">${r.date}</span></div><div class="req-desc" style="color:var(--text-color); font-size:12px; white-space:pre-wrap;">${formatRemarkText(r.details)}</div></div>`; 
          });
      }
      listHtml += "</div>"; 
  }
  document.getElementById("details-list").innerHTML = listHtml;
}

function openEmpKpiDetails(iin, fromDetails = false) { 
  const emp = allEmployeesData.find(e => safeIin(e.iin) === safeIin(iin)); if(!emp) return; 
  
  let prevTab = lastActiveTab;
  switchTab('details'); 
  
  document.getElementById("btn-details-back").onclick = () => {
      if (fromDetails) openEmpDetails(iin); 
      else switchTab(prevTab); 
  };
  
  document.getElementById("details-title").innerText = "КФ. ЭФФ: " + emp.name; 
  document.getElementById("details-kpi-circle-container").innerHTML = ""; 
  
  let listHtml = "<div class='card' style='padding:0;'>"; 
  emp.kpiDetails.forEach(k => { 
    let col = k.val > 0 ? 'detail-plus' : (k.val < 0 ? 'detail-minus' : 'detail-val'); 
    let valStr = k.val > 0 ? `+${k.val}%` : `${k.val}%`; 
    let srcColor = getSourceColor(k.source); 
    let dispName = k.name.replace(/^(Фокус|Trade-In|СЦ|Горячий чек)[\s\|:]*/i, '').trim(); 
    if (!dispName) dispName = k.name; 
    if (k.source === "База" || k.name === "Ошибки") dispName = k.name; 
    if (k.name === "Больничный" || k.name === "Прогул") { dispName = k.name; srcColor = "#7f8c8d"; } 
    let dateStr = k.date ? `<span style="color:gray;font-size:10px; margin-left:5px;"> • ${k.date}</span>` : ""; 
    listHtml += `<div class="detail-item"><div><span style="color:var(--text-color); font-size:12px; display:inline-block; margin-bottom:3px;">${dispName}</span><br><b style="color:${srcColor}; font-size:10px;">${k.source}</b>${dateStr}</div><span class="${col}">${valStr}</span></div>`; 
  }); 
  listHtml += "</div>"; 
  document.getElementById("details-list").innerHTML = listHtml; 
}

function openEmpDetails(iin) {
  const emp = allEmployeesData.find(e => safeIin(e.iin) === safeIin(iin)); if(!emp) return; 
  let prevTab = lastActiveTab;
  switchTab('details'); document.getElementById("btn-details-back").onclick = () => switchTab(prevTab); 
  document.getElementById("details-title").innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; width:100%;"><span style="flex:1; text-align:center; padding-left:28px;">${emp.name}</span><div class="circle-box" style="width:28px; min-width:28px; height:28px; margin:0; cursor:pointer; box-shadow:none;" onclick="openEmpKpiDetails('${emp.iin}', true)"><div class="kpi-container" style="background: conic-gradient(${setKpiColor(emp.kpi, null, null)} ${emp.kpi > 100 ? 100 : emp.kpi}%, var(--inner-bg) 0);"><div class="kpi-inner" style="width:24px; height:24px;"><span style="font-size:9px; font-weight:bold; color:${setKpiColor(emp.kpi, null, null)}">${emp.kpi}%</span></div></div></div></div>`;
  document.getElementById("details-kpi-circle-container").innerHTML = "";
  
  let tabsHtml = `<div style="display:flex; gap:6px; margin-bottom:12px; padding:0 4px;"><button id="emp-tab-rep" class="admin-flt active-flt" onclick="renderEmpDetailTab('rep', '${iin}')">Отчет</button><button id="emp-tab-pts" class="admin-flt" onclick="renderEmpDetailTab('pts', '${iin}')">Баллы</button><button id="emp-tab-viol" class="admin-flt" onclick="renderEmpDetailTab('viol', '${iin}')">Нарушения</button></div><div id="emp-detail-content" class="slide-up-fade"></div>`;
  document.getElementById("details-list").innerHTML = tabsHtml; renderEmpDetailTab(window.currentEmpDetailTab || 'rep', iin); 
}

function renderEmpDetailTab(tab, iin) {
  window.currentEmpDetailTab = tab;
  const emp = allEmployeesData.find(e => safeIin(e.iin) === safeIin(iin)); if(!emp) return;
  document.getElementById('emp-tab-rep').classList.remove('active-flt'); document.getElementById('emp-tab-pts').classList.remove('active-flt'); document.getElementById('emp-tab-viol').classList.remove('active-flt'); document.getElementById('emp-tab-'+tab).classList.add('active-flt');
  let content = document.getElementById('emp-detail-content'); content.classList.remove("slide-up-fade"); void content.offsetWidth; content.classList.add("slide-up-fade"); let html = "";
  
  if (tab === 'rep') { html = emp.reports.map(generateHorizontalGrid).join('') || "<p style='text-align:center;color:gray;font-size:12px;'>Отчетов нет</p>"; }
  else if (tab === 'pts') { 
    html = `<div class="grid-details-container inner-block"><div style="display:flex; justify-content:space-around; text-align:center; margin-bottom:10px; border-bottom:1px solid var(--border-color); padding-bottom:10px;"><div><div style="color:gray; font-size:10px; margin-bottom:4px;">Нач.</div><b style="font-size:15px;">${emp.pts.acc || 0}</b></div><div><div style="color:gray; font-size:10px; margin-bottom:4px;">Исп.</div><b style="font-size:15px;">${emp.pts.use || 0}</b></div><div><div style="color:gray; font-size:10px; margin-bottom:4px;">Ост.</div><b style="font-size:15px; color:#27ae60;">${emp.pts.rem || 0}</b></div><div><div style="color:gray; font-size:10px; margin-bottom:4px;">Штрф.</div><b style="font-size:15px; color:#e74c3c;">${emp.pts.fin || 0}</b></div></div><div class="grid-details-title">История баллов</div></div>`; 
    html += groupAndRenderByMonth((emp.ptsHistory || []).filter(p => p.type !== "KPI"), p => {
         let ptsNum = parseFloat(String(p.val).replace(',', '.')) || 0; 
         if (ptsNum !== 0) return renderHistoryItem({...p, val: ptsNum}, true);
         return "";
    });
  }
  else if (tab === 'viol') {
    html = `<div style="display:flex; gap:8px; margin-bottom:12px;"><button class="btn-red" onclick="document.getElementById('fine-form-${iin}').classList.toggle('hidden')" style="padding:10px; font-size:12px; margin:0;">Выписать штраф</button><button class="btn-orange" onclick="document.getElementById('remark-form-${iin}').classList.toggle('hidden')" style="padding:10px; font-size:12px; margin:0;">Сделать замечание</button></div>`;
    html += `<div id="fine-form-${iin}" class="hidden inner-block slide-up-fade" style="border:1px solid #e74c3c; background:rgba(231, 76, 60, 0.05);"><input type="text" id="fine-reason-${iin}" placeholder="Причина штрафа..." style="box-sizing: border-box; width:100%; height:36px; margin-top:0; margin-bottom:8px; font-size:13px; background:var(--card-bg);"><div style="display:flex; gap:8px; margin-bottom:8px;"><input type="number" id="fine-amount-${iin}" placeholder="0 (Баллы)" style="box-sizing: border-box; height:36px; margin:0; flex:1; font-size:14px; background:var(--card-bg);"><input type="number" id="fine-money-${iin}" placeholder="0 (Сумма ₸)" style="box-sizing: border-box; height:36px; margin:0; flex:1; font-size:14px; background:var(--card-bg);"></div><button class="btn-red" onclick="executeFine('${iin}', '${emp.name}')" style="padding:8px; font-size:12px; margin:0;">Подтвердить штраф</button></div>`;
    html += `<div id="remark-form-${iin}" class="hidden inner-block slide-up-fade" style="border:1px solid #f39c12; background:rgba(243, 156, 18, 0.05);"><textarea id="remark-text-${iin}" placeholder="Текст замечания..." style="box-sizing: border-box; width:100%; height:60px; margin-bottom:8px; border-radius:8px; padding:8px; border:1px solid var(--border-color); background:var(--card-bg); color:var(--text-color); font-family:inherit; resize:none;"></textarea><button class="btn-orange" onclick="executeRemark('${iin}', '${emp.name}')" style="padding:8px; font-size:12px; margin:0;">Отправить замечание</button></div>`;
    
    let allFines = (emp.ptsHistory || []).filter(p => p.type === "Штраф" && (parseFloat(String(p.moneyFine).replace(',', '.')) || 0) !== 0);
    let finesHtml = groupAndRenderByMonth(allFines, p => renderMoneyFineItem({...p, moneyFine: parseFloat(String(p.moneyFine).replace(',', '.')) || 0}));
    
    let remarksHtml = groupAndRenderByMonth((emp.remarks || []), r => {
        let desc = formatRemarkText(r.details);
        let authorStr = formatRemarkAuthor(r.authorName, r.authorRole);
        let d = r.date ? String(r.date) : "";
        return `<div class="req-item" style="border-left-color: #f39c12; margin-bottom:8px;"><div class="req-title" style="font-size:12px;"><b style="color:#f39c12;">${authorStr}</b> <span style="float:right; color:gray; font-size:10px; font-weight:normal;">${d}</span></div><div class="req-desc" style="color:var(--text-color); font-size:12px; white-space:pre-wrap;">${desc}</div></div>`; 
    });

    if (allFines.length > 0) html += `<div class="grid-details-title" style="color:#e74c3c; margin-top:10px;">Штрафы (Сумма)</div>${finesHtml}`;
    if ((emp.remarks || []).length > 0) html += `<div class="grid-details-title" style="color:#f39c12; margin-top:10px;">Замечания</div>${remarksHtml}`;
    if (allFines.length === 0 && (emp.remarks || []).length === 0) html += `<p style='text-align:center;color:gray;font-size:12px; margin-top:15px;'>Нарушений нет</p>`;
  }
  content.innerHTML = html;
}

async function executeRemark(iin, name) { let text = document.getElementById(`remark-text-${iin}`).value; if (!text) return showToast("Укажите текст замечания!", true); vibrate(50); showToast("Отправка...", false, 9999); let res = await callBackend('submitRemark', { token: appState.token, targetIin: iin, targetName: name, text: text }); if (res.success) { showToast("Замечание отправлено!"); loadDashboard(true); closeDetails(); } else showToast(res.error, true); }

async function executeFine(iin, name) { let reason = document.getElementById(`fine-reason-${iin}`).value; let amount = document.getElementById(`fine-amount-${iin}`).value || "0"; let moneyAmount = document.getElementById(`fine-money-${iin}`).value || "0"; if (!reason) return showToast("Укажите причину штрафа!", true); if (parseFloat(amount) >= 0 && parseFloat(moneyAmount) >= 0) return showToast("Укажите штраф (баллы или сумма) меньше 0!", true); vibrate(50); showToast("Отправка...", false, 9999); let res = await callBackend('submitFine', { token: appState.token, iin: iin, name: name, reason: reason, amount: amount, moneyAmount: moneyAmount }); if (res.success) { showToast("Штраф выписан/запрошен!"); loadDashboard(true); closeDetails(); } else showToast(res.error, true); }
function closeDetails() { switchTab('adm-main'); }

function toggleAdminMain(view) {
  window.currentAdminMainView = view;
  document.getElementById("admin-plan-list").classList.add("hidden"); document.getElementById("admin-sc-list").classList.add("hidden"); document.getElementById("admin-emp-container").classList.add("hidden");
  document.getElementById("admin-plan-list").classList.remove("fade-in"); document.getElementById("admin-sc-list").classList.remove("fade-in"); document.getElementById("admin-emp-container").classList.remove("fade-in");
  document.getElementById("btn-adm-plan").classList.remove('active-flt'); document.getElementById("btn-adm-sc").classList.remove('active-flt'); document.getElementById("btn-adm-emp").classList.remove('active-flt');
  if(view === 'plan') { document.getElementById("admin-plan-list").classList.remove("hidden"); document.getElementById("admin-plan-list").classList.add("fade-in"); document.getElementById("btn-adm-plan").classList.add("active-flt"); } else if(view === 'sc') { document.getElementById("admin-sc-list").classList.remove("hidden"); document.getElementById("admin-sc-list").classList.add("fade-in"); document.getElementById("btn-adm-sc").classList.add("active-flt"); renderAdminScItems(currentAdminScDept, document.getElementById(`flt-${currentAdminScDept.toLowerCase()}`)); } else { document.getElementById("admin-emp-container").classList.remove("hidden"); document.getElementById("admin-emp-container").classList.add("fade-in"); document.getElementById("btn-adm-emp").classList.add("active-flt"); renderAdminEmps(currentEmpDept, document.getElementById(`flt-emp-${currentEmpDept.toLowerCase()}`)); }
}

function markAsSeen(id, el) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("seenH_" + appState.iin) || "{}"); } catch(e){}
    stored[id] = true;
    localStorage.setItem("seenH_" + appState.iin, JSON.stringify(stored));
    
    let badge = el.querySelector('.new-badge');
    if (badge) badge.style.display = 'none';
    el.style.opacity = '0.9';
    el.style.boxShadow = 'none';
}

let currentHistFilter = 'all';
function renderAdminHistory(filterType) {
  if(filterType) currentHistFilter = filterType;
  ['all', 'sales', 'pts', 'viol'].forEach(f => {
    let el = document.getElementById('flt-hist-' + f);
    if(el) el.classList.remove('active-flt');
  });
  let activeEl = document.getElementById('flt-hist-' + currentHistFilter);
  if(activeEl) activeEl.classList.add('active-flt');

  let aHist = window.adminHistoryGlobal || [];
  if (currentHistFilter === 'sales') {
      aHist = aHist.filter(r => ["Продажа СЦ/Фокус", "Продажа Trade-In", "Горячий чек"].includes(r.type));
  } else if (currentHistFilter === 'pts') {
      aHist = aHist.filter(r => r.type === "Баллы мотивации");
  } else if (currentHistFilter === 'viol') {
      aHist = aHist.filter(r => r.type === "Замечание" || r.type === "Штраф" || r.type === "Запрос на штраф");
  }

  document.getElementById("admin-history-list").innerHTML = groupAndRenderByMonth(aHist, r => {
    let stColor = r.status === "approved" || r.status === "approved_notify_zav" ? "#27ae60" : (r.status === "rejected" || r.status === "rejected_by_user" || r.status === "rejected_notify_user" || r.status === "rejected_notify_zav" ? "#e74c3c" : "#95a5a6"); 
    let stText = r.status === "approved" || r.status === "approved_notify_zav" ? "Одобрен" : (String(r.status).includes("rejected") ? "Отклонен" : "Просмотрен"); 
    if(r.status === "rejected_by_user") stText = "Отклонен сменщиком"; 
    
    if (r.type === "Исправление смены") {
        if (r.status.includes("approved")) stText = "Исправлен";
        else if (r.status.includes("rejected")) stText = "Отклонен";
    }
    
    let desc = r.type === "Обмен сменами" ? `Сменщик: ${r.targetName || ''}<br>${r.details || ''}` : (r.details || ''); 
    desc = formatRemarkText(desc, r.type === 'Замечание' ? r.targetName : null);

    if (r.type === "Запрос на штраф") {
        let metaObj = {}; try { metaObj = JSON.parse(r.meta || r.metadata); } catch(e){}
        desc = `Нарушитель: <b>${r.targetName}</b><br>Причина: ${metaObj.reason || desc}<br>Баллы: <b style="color:#e74c3c;">${metaObj.amount}</b> | Сумма: <b style="color:#e74c3c;">${metaObj.moneyAmount} ₸</b>`;
    }

    let approverLabel = r.approver ? `<span style="color:gray; font-size:10px; font-weight:normal;">${formatShortName(r.approver)}</span>` : ''; 
    let titleColor = getSourceColor(r.type); 
    if (r.type === "Продажа СЦ/Фокус" && String(r.details).toLowerCase().includes("фокус")) titleColor = '#e74c3c'; 
    
    let authorStr = r.type === "Замечание" || r.type === "Запрос на штраф" ? `<b style="color:#f39c12;">${formatRemarkAuthor(r.authorName, r.authorRole)}</b>` : `<b>От:</b> ${r.adminDisplayName || r.authorName || ''}`;

    return `<div class="req-item" style="border-left-color: ${stColor}; opacity: 0.9;">
        <div class="req-title" style="color:${titleColor};">${r.type || 'Запрос'} <span style="font-size:12px; font-weight:normal; color:gray; float:right;">${r.date || ''}</span></div>
        <div class="req-desc" style="color:var(--text-color);">${authorStr}<br><b>Суть:</b> ${desc}<br>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;"><b style="color:${stColor}">Статус: ${stText}</b>${approverLabel}</div></div>
    </div>`; 
  });
}

function renderAdminOuts() {
  let list = globalActiveOuts || []; const now = Date.now();
  document.getElementById('admin-outs-list').innerHTML = list.map(out => { let elapsedMin = Math.floor((now - out.leftAt) / 60000); let diffMin = out.limit - elapsedMin; let timeClass = ""; let timeText = ""; if (diffMin > 0) timeText = `Осталось ${diffMin} мин`; else { timeClass = "late"; timeText = `Опаздывает на ${Math.abs(diffMin)} мин!`; } let actionTitle = out.action; if(actionTitle.includes("Перерыв")) actionTitle = "Перерыв"; let rRole = out.role ? String(out.role) : ""; let roleLabel = rRole.toLowerCase().includes('промоутер') ? `<div style="font-size:11px; color:gray; font-weight:normal; margin-top:2px;">${rRole}</div>` : ''; return `<div class="active-out-item" style="align-items: center;"><div><span class="active-out-name">${out.name}</span> <span style="color:gray; font-weight:normal; font-size:11px; margin-left: 5px;">(${actionTitle})</span>${roleLabel}</div><span class="active-out-time ${timeClass}">${timeText}</span></div>`; }).join("") || "<p style='color:gray; font-size:13px; text-align:center;'>Все на местах</p>";
}

function renderAdminEmps(dept, btnElement) {
   currentEmpDept = dept; if (btnElement) { document.getElementById('flt-emp-cifra').classList.remove('active-flt'); document.getElementById('flt-emp-mbt').classList.remove('active-flt'); document.getElementById('flt-emp-kbt').classList.remove('active-flt'); btnElement.classList.add('active-flt'); }
   let container = document.getElementById("admin-emp-list"); let filtered = allEmployeesData.filter(e => e.dept.toLowerCase().includes(dept.toLowerCase())); let currentMonth = new Date().getMonth() + 1; let currentYear = new Date().getFullYear(); let monthSuffix = ("0" + currentMonth).slice(-2) + "." + currentYear;
   container.innerHTML = filtered.map(e => { 
       let monthScHist = e.ptsHistory.filter(p => p.type === "Начисление" && typeof p.date === 'string' && p.date.includes(monthSuffix)); 
       let curMonthSc = monthScHist.filter(p => !p.source.toLowerCase().includes("trade-in")).length; 
       let curMonthTrade = monthScHist.filter(p => p.source.toLowerCase().includes("trade-in")).length; 
       
       return `<div class="req-item" style="border-left-color: var(--btn-color); border-left-width: 2px; padding: 10px 8px; margin-bottom: 8px; cursor:pointer;" onclick="openEmpDetails('${e.iin}')">
          <div style="font-size:13px; font-weight:bold; margin-bottom:6px; color:var(--text-color);">${e.name}</div>
          
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:8px;">
             <div class="inner-block" style="flex:1; margin:0; padding:2px; height:34px; display:flex; align-items:center;">
                ${e.tabelStr}
             </div>
             
             <div class="circle-box" style="width:34px; min-width:34px; height:34px; margin:0; cursor:pointer; box-shadow:none; flex-shrink:0;" onclick="event.stopPropagation(); openEmpKpiDetails('${e.iin}')">
                <div class="kpi-container" style="background: conic-gradient(${setKpiColor(e.kpi, null, null)} ${e.kpi > 100 ? 100 : e.kpi}%, var(--inner-bg) 0);">
                   <div class="kpi-inner" style="width:28px; height:28px;">
                      <span style="font-size:10px; font-weight:bold; color:${setKpiColor(e.kpi, null, null)}">${e.kpi}%</span>
                   </div>
                </div>
             </div>
          </div>
          
          <div style="display:flex; justify-content:space-between; font-size:11px; align-items:center; color:var(--desc-color);">
              <span>СЦ | Brzy: <b style="color:var(--btn-color);">${curMonthSc} | ${curMonthTrade}</b> <span style="font-weight:normal; margin: 0 2px;">/</span> <b style="color:var(--text-color);">${e.sales.sc} | ${e.sales.trade}</b></span>
              <span>Ошибки по отчетам: <b style="color:var(--text-color);">${e.reportErrors}</b></span>
          </div>
       </div>`; 
   }).join("") || "<p style='color:gray; font-size:12px; text-align:center;'>Сотрудников нет</p>";
}

let currentAdminScTabType = 'active'; 
function switchScAdminTab(tabType) { 
    currentAdminScTabType = tabType; 
    document.getElementById('tab-sc-active').classList.remove('active-flt');
    document.getElementById('tab-sc-sold').classList.remove('active-flt');
    document.getElementById('tab-sc-' + tabType).classList.add('active-flt');
    renderAdminScItems(currentAdminScDept, null); 
}

function renderAdminScItems(dept, btnElement) {
   dept = dept || currentAdminScDept; currentAdminScDept = dept; 
   if (btnElement) { 
       document.getElementById('flt-cifra').classList.remove('active-flt'); 
       document.getElementById('flt-mbt').classList.remove('active-flt'); 
       document.getElementById('flt-kbt').classList.remove('active-flt'); 
       document.getElementById('flt-focus').classList.remove('active-flt'); 
       btnElement.classList.add('active-flt'); 
   }
   let container = document.getElementById("admin-sc-container"); 
   let searchInput = document.getElementById("admin-sc-search"); 
   let searchQ = searchInput ? searchInput.value.toLowerCase() : ""; 
   
   container.innerHTML = ""; 
   
   if (currentAdminScTabType === 'active') { 
       let filtered = adminScItemsGlobal.filter(i => (dept === "Фокус" ? i.type === "Фокус" : (i.dept === dept && i.type === "СЦ"))); 
       if (searchQ) filtered = filtered.filter(i => i.name.toLowerCase().includes(searchQ)); 
       if (filtered.length === 0) { container.innerHTML = "<p style='text-align:center; color:gray; padding:15px; font-size:12px;'>Пусто</p>"; return; }
       
       if (dept === "Фокус") { 
           let groups = {"Цифра": [], "МБТ": [], "КБТ": []}; 
           filtered.forEach(i => { if(groups[i.dept]) groups[i.dept].push(i); });
           for (const [dName, items] of Object.entries(groups)) { 
               if (items.length === 0) continue; 
               let headerText = items[0].focusHeader || `${dName} Фокус`; 
               let html = `<div class="inner-block card" style="margin-bottom:8px; padding:8px; background: var(--card-bg);"><div style="font-size:13px; font-weight:bold; color:var(--text-color); margin-bottom:6px;">${headerText}</div>`; 
               items.forEach((i, idx) => { 
                   let ptNoun = formatPointsNoun(i.pts); 
                   html += `<div class="sc-item" onclick="this.classList.toggle('selected')" style="padding:10px; border-bottom:1px solid rgba(130, 130, 130, 0.35); display:flex; justify-content:space-between; margin-bottom:4px;"><div><div style="font-size:12px; margin-bottom:2px;"><b>${idx+1}.</b> ${i.name}</div><div class="type-label" style="font-size:10px; color:#e74c3c; font-weight:bold;">Фокус — ${String(i.pts).replace('.',',')} ${ptNoun}</div></div></div>`; 
               }); 
               html += `</div>`; 
               container.innerHTML += html; 
           }
       } else { 
           let html = `<div class="card" style="padding: 6px;">`;
           filtered.forEach((i, idx) => { 
               let docBtn = i.docUrl ? `<a href="${i.docUrl}" target="_blank" style="text-decoration:none; background:var(--inner-bg); font-size:18px; padding:4px 8px; border-radius:8px; display:inline-block; transition:0.6s;" onclick="event.stopPropagation()">📄</a>` : ''; 
               html += `<div class="sc-item" onclick="this.classList.toggle('selected')" style="padding:10px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;"><div><div style="font-size:12px; margin-bottom:2px;"><b>${idx+1}.</b> ${i.name}</div><div class="type-label" style="font-size:10px; color:#e67e22; font-weight:bold;">СЦ${i.discount ? `<span style="color:#e74c3c; margin-left:10px;">-${i.discount.replace(/%/g, '% ')}</span>` : ''}</div></div><div>${docBtn}</div></div>`; 
           }); 
           html += `</div>`;
           container.innerHTML = html;
       }
   } else { 
       let historyArray = window.adminHistoryGlobal || []; 
       let sold = historyArray.filter(r => r.status === "approved" && r.type === "Продажа СЦ/Фокус");
       
       if (dept === "Фокус") { 
           sold = sold.filter(r => { 
               try { let m = JSON.parse(r.meta); return m.type === "Фокус"; } 
               catch(e) { return r.details.toLowerCase().includes("фокус"); } 
           }); 
       } else { 
           sold = sold.filter(r => { 
               try { let m = JSON.parse(r.meta); return m.dept === dept && m.type !== "Фокус"; } 
               catch(e) { return false; } 
           }); 
       }
       
       if (searchQ) sold = sold.filter(r => r.details.toLowerCase().includes(searchQ) || r.authorName.toLowerCase().includes(searchQ)); 
       if (sold.length === 0) { container.innerHTML = "<p style='text-align:center; color:gray; padding:15px; font-size:12px;'>Нет проданных товаров</p>"; return; }
       
       container.innerHTML = groupAndRenderByMonth(sold, r => {
           const isFocus = dept === "Фокус"; 
           const tagColor = isFocus ? "#f39c12" : "#3390ec"; 
           let metaObj = {}; try { metaObj = JSON.parse(r.meta); } catch(e){} 
           let displayAct = r.actUrl || metaObj.docUrl || ""; 
           let displayDisc = r.discount || metaObj.discount || "0%"; 
           
           return `<div class="inner-block sc-item card" onclick="this.classList.toggle('selected')" style="padding:10px; margin-bottom:8px; border-left: 3px solid ${tagColor}; cursor: pointer; background: var(--card-bg);"><div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span class="type-label" style="font-size:9px; font-weight:bold; color:${tagColor};">${isFocus ? 'ФОКУС' : 'СЦ'}</span><span style="font-size:9px; color:gray;">${r.date}</span></div><div style="font-size:12px; font-weight:bold; margin-bottom:4px;">${r.details}</div><div style="font-size:11px; line-height:1.4;">👤 <span style="color:gray;">Продавец:</span> <b>${r.authorName}</b><br>${displayDisc !== "0%" ? `🏷️ <span style="color:gray;">Скидка:</span> <b style="color:#e74c3c;">${displayDisc}</b><br>` : ''}${displayAct ? `📄 <a href="${displayAct}" target="_blank" style="color:#3390ec; text-decoration:none; font-weight:bold;" onclick="event.stopPropagation()">Акт товара</a>` : '<span style="color:gray; font-size:10px;">(Акт не прикреплен)</span>'}</div></div>`; 
       });
   }
}

function switchScDept(dept) { currentScTabDept = dept; document.getElementById('sc-tab-cifra').classList.remove('active-flt'); document.getElementById('sc-tab-mbt').classList.remove('active-flt'); document.getElementById('sc-tab-kbt').classList.remove('active-flt'); let tabId = 'sc-tab-cifra'; if (dept === 'МБТ') tabId = 'sc-tab-mbt'; if (dept === 'КБТ') tabId = 'sc-tab-kbt'; document.getElementById(tabId).classList.add('active-flt'); renderScItems(); }

function openForm(type) {
  document.getElementById("menu-list").classList.add("hidden"); let dash = document.getElementById("info-dashboard"); dash.classList.add("hidden"); 
  if(type === 'sc') { selectedScItem = null; document.getElementById("sc-search").value = ""; document.getElementById("btn-act-doc").style.opacity = "0.3"; document.getElementById("btn-act-doc").style.pointerEvents = "none"; let deptToSet = appState.dept || 'Цифра'; if (deptToSet !== 'Цифра' && deptToSet !== 'МБТ' && deptToSet !== 'КБТ') deptToSet = 'Цифра'; switchScDept(deptToSet); document.getElementById("form-sc").classList.remove("hidden"); document.getElementById("form-sc").classList.add("slide-up-fade"); }
  if(type === 'tradein') { selectedTradeInModel = null; renderTradeInList(); document.getElementById("form-tradein").classList.remove("hidden"); document.getElementById("form-tradein").classList.add("slide-up-fade"); }
  if(type === 'points') { let remVal = parseFloat(document.getElementById("pt-rem").innerText.replace(',','.')); let isZero = isNaN(remVal) || remVal <= 0; let noticeBox = document.getElementById("fp-balance-notice"); if (isZero) { noticeBox.innerHTML = "<b>У вас нет оставшихся баллов</b>"; noticeBox.style = "background: rgba(231, 76, 60, 0.1); color: #c0392b; padding: 12px; border-radius: 12px; font-size: 13px; text-align: center; margin-bottom: 12px; border: 1px dashed #e74c3c; box-shadow: 0 2px 8px rgba(0,0,0,0.03);"; document.getElementById("fp-action").classList.add("hidden"); document.getElementById("fp-time").classList.add("hidden"); document.getElementById("fp-date").classList.add("hidden"); document.getElementById("fp-date-label").classList.add("hidden"); document.getElementById("fp-submit-btn").disabled = true; document.getElementById("fp-submit-btn").style.background = "#95a5a6"; } else { noticeBox.innerHTML = `🔥 Вы можете использовать: <b style="font-size:16px;">${document.getElementById("pt-rem").innerText}</b> баллов`; noticeBox.style = "background: rgba(41, 128, 185, 0.1); color: #2980b9; padding: 12px; border-radius: 12px; font-size: 13px; text-align: center; margin-bottom: 12px; border: 1px dashed var(--btn-color); box-shadow: 0 2px 8px rgba(0,0,0,0.03);"; document.getElementById("fp-action").classList.remove("hidden"); document.getElementById("fp-time").classList.remove("hidden"); document.getElementById("fp-date").classList.remove("hidden"); document.getElementById("fp-date-label").classList.remove("hidden"); document.getElementById("fp-submit-btn").disabled = false; document.getElementById("fp-submit-btn").style.background = "var(--btn-color)"; } document.getElementById("form-points").classList.remove("hidden"); document.getElementById("form-points").classList.add("slide-up-fade"); }
  if(type === 'swap') { const select = document.getElementById("fs-target"); select.innerHTML = '<option value="" disabled selected>Выберите сменщика</option>' + globalSellers.map(s => `<option value="${s.iin}">${s.name}</option>`).join(""); document.getElementById("fs-extra").classList.add("hidden"); document.getElementById("form-swap").classList.remove("hidden"); document.getElementById("form-swap").classList.add("slide-up-fade"); }
  let scroller = document.getElementById("scrollable-body"); if (scroller) scroller.scrollTop = 0;
}

function closeForm() { let roleStr = String(appState.role).toLowerCase(); let isDir = roleStr.includes("директор") || roleStr.includes("управляющий") || roleStr.includes("админ") || roleStr.includes("супервайзер"); let isZavSklad = roleStr.includes("заведующий складом"); let dash = document.getElementById("info-dashboard"); if (!isUserPromoter && !isDir && !isZavSklad) { dash.classList.remove("hidden"); dash.classList.remove("fade-in", "slide-up-fade", "slide-down-fade"); dash.classList.add("slide-down-fade"); } ["form-sc", "form-tradein", "form-points", "form-swap"].forEach(id => { let el = document.getElementById(id); el.classList.add("hidden"); el.classList.remove("slide-up-fade"); }); let menu = document.getElementById("menu-list"); menu.classList.remove("hidden"); menu.style.animation = 'none'; menu.offsetHeight; menu.style.animation = null; menu.classList.add("fade-in"); let scroller = document.getElementById("scrollable-body"); if (scroller) scroller.scrollTop = 0; }

function checkSwapFields() { const target = document.getElementById("fs-target").value; if (target) document.getElementById("fs-extra").classList.remove("hidden"); }

function renderScItems() {
  const q = document.getElementById("sc-search").value.toLowerCase(); const list = document.getElementById("sc-list"); list.innerHTML = "";
  let scList = globalScItems.filter(i => i.dept === currentScTabDept && i.type === 'СЦ'); if (q) scList = scList.filter(i => i.name.toLowerCase().includes(q));
  let focusList = globalScItems.filter(i => i.dept === currentScTabDept && i.type === 'Фокус'); if (q) focusList = focusList.filter(i => i.name.toLowerCase().includes(q)); let sortedFiltered = [...scList, ...focusList];
  if (sortedFiltered.length === 0) { list.innerHTML = "<p style='padding:12px; color:gray; font-size:12px; text-align:center;'>Ничего не найдено</p>"; return; }
  sortedFiltered.forEach(i => { let div = document.createElement("div"); let isSelected = (selectedScItem && selectedScItem.row === i.row && selectedScItem.type === i.type && selectedScItem.dept === i.dept); div.className = "sc-item" + (isSelected ? " selected" : ""); let typeCol = i.type === 'СЦ' ? '#e67e22' : '#e74c3c'; let ptNoun = formatPointsNoun(i.pts); let ptsText = i.type === 'СЦ' ? '2 балла' : `${String(i.pts).replace('.', ',')} ${ptNoun}`; let deptLabel = i.type === 'Фокус' ? `<span style="color:gray; font-weight:normal;"> (${i.dept})</span>` : ''; div.innerHTML = `<div><div style="margin-bottom:4px; font-size:13px;">${i.name}${deptLabel}</div><div style="display:flex; justify-content:space-between; align-items:center;"><div class="type-label" style="font-size:10px; color:${typeCol}; font-weight:bold;">${i.type} — ${ptsText}</div>${i.discount ? `<div style="font-weight:bold; color:#e74c3c; font-size:11px;">-${i.discount.replace(/%/g, '% ')}</div>` : ''}</div></div>`; div.onclick = () => { selectedScItem = i; let docBtn = document.getElementById("btn-act-doc"); if (i.docUrl) { docBtn.style.opacity = "1"; docBtn.style.pointerEvents = "auto"; } else { docBtn.style.opacity = "0.3"; docBtn.style.pointerEvents = "none"; } renderScItems(); }; list.appendChild(div); });
}

function openScDoc() { if (selectedScItem && selectedScItem.docUrl) { if (tg && tg.openLink) tg.openLink(selectedScItem.docUrl); else window.open(selectedScItem.docUrl, '_blank'); } }
function showToast(msg, isError = false, duration = 3000) { const t = document.getElementById("toast"); t.innerText = msg; t.style.background = isError ? "#e74c3c" : "#34495e"; t.classList.add("show"); if (duration !== 9999) setTimeout(() => t.classList.remove("show"), duration); }

async function executeSubmit(type, details, targetIin = null, meta = "", customMsg = null) { vibrate(50); showToast("Отправка...", false, 9999); let res = await callBackend('submitRequest', { token: appState.token, type: type, details: details, targetIin: targetIin, metadata: meta }); if(res.success) { showToast(customMsg || "Запрос успешно отправлен!"); closeForm(); loadDashboard(true); } else showToast("Ошибка: " + res.error, true); }
function getFormattedDate(dateStr) { const today = new Date().toISOString().split('T')[0]; if (!dateStr || dateStr === "Сегодня") { dateStr = today; } const d = new Date(dateStr); return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear(); }

function submitScForm() { if(!selectedScItem) return showToast("Выберите товар из списка", true); let scDateVal = document.getElementById("sc-date").dataset.realdate; selectedScItem.date = getFormattedDate(scDateVal); executeSubmit("Продажа СЦ/Фокус", selectedScItem.name, null, JSON.stringify(selectedScItem)); }
function submitTradeIn() { if(!selectedTradeInModel) return showToast("Выберите модель!", true); const dateVal = document.getElementById("ft-date").dataset.realdate; let meta = JSON.stringify({ date: getFormattedDate(dateVal), text: selectedTradeInModel }); executeSubmit("Продажа Trade-In", selectedTradeInModel, null, meta); }
function submitPoints() { const act = document.getElementById("fp-action").value; const time = document.getElementById("fp-time").value; const dateVal = document.getElementById("fp-date").dataset.realdate; let meta = JSON.stringify({ date: getFormattedDate(dateVal) }); executeSubmit("Баллы мотивации", `${act} на ${time}`, null, meta); }
function submitFixShift() { const shiftStr = document.getElementById("fs-fix-shift").value; if (!shiftStr) return showToast("Выберите новую смену", true); const dateVal = new Date().toISOString().split('T')[0]; executeSubmit("Исправление смены", shiftStr, null, getFormattedDate(dateVal), "Запрос на исправление отправлен"); }
function submitSwap() { const select = document.getElementById("fs-target"); const targetIin = select.value; if(!targetIin) return showToast("Выберите сменщика", true); const dateVal = document.getElementById("fs-date").dataset.realdate; const shiftStr = document.getElementById("fs-shift").value; const targetName = select.options[select.selectedIndex].text; const details = `Дата: ${getFormattedDate(dateVal)}, Смена: ${shiftStr}`; executeSubmit("Обмен сменами", details, targetIin, "", "Запрос отправлен: " + targetName); }

function submitHotCheck(typeText, valText, ptsText) { 
    let promptMsg = `Вы подтверждаете продажу: ${typeText}?`; 
    let dateVal = new Date().toISOString().split('T')[0]; 
    let metaStr = JSON.stringify({ date: getFormattedDate(dateVal), bonus: valText, pts: ptsText }); 
    if (typeof tg !== 'undefined' && tg && tg.showPopup) { 
        try { 
            tg.showPopup({ title: 'Горячий чек', message: promptMsg, buttons: [{id: 'yes', type: 'ok', text: 'Да'}, {type: 'cancel', text: 'Отмена'}] }, function(btnId) { 
                if (btnId === 'yes') executeSubmit("Горячий чек", typeText, null, metaStr); 
            }); 
        } catch(e) { 
            if (confirm(promptMsg)) executeSubmit("Горячий чек", typeText, null, metaStr); 
        } 
    } else { 
        if (confirm(promptMsg)) executeSubmit("Горячий чек", typeText, null, metaStr); 
    } 
}

async function processReq(id, action, replyText = "") { vibrate(50); showToast("Обработка...", false, 9999); processedReqIds.add(String(id)); let el = document.getElementById("req-" + id); if (el) { el.style.display = 'none'; } let res = await callBackend('processRequest', { token: appState.token, reqId: id, reqAction: action, replyText: replyText }); if(res.success) { showToast(res.msg); loadDashboard(true); } else { showToast(res.error, true); loadDashboard(true); } }

document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName === 'INPUT') {
    document.activeElement.blur();
  }
});
