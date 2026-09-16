// ==UserScript==
// @name         VK Video Live - Lag Monitor, Soft Reload & Max Quality
// @namespace    https://tampermonkey.net/
// @version      5.2
// @description  Встраивает индикатор лага в шапку чата (клик = мягкий ресинк к лайву), держит плеер на максимальном качестве и в fullscreen/при бездействии курсора ведёт себя как остальные элементы плеера на live.vkvideo.ru
// @author       you
// @match        https://live.vkvideo.ru/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'vk-lag-monitor-badge';
  const STYLE_ID = 'vk-lag-monitor-style';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 10px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        font: 12px/1 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        color: #fff;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        flex: none;
        opacity: 1;
        transition: opacity 0.2s ease;
      }
      #${PANEL_ID}:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      #${PANEL_ID}[data-kind="floating"] {
        position: fixed;
        z-index: 2147483647;
        background: rgba(20, 20, 20, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.15);
      }
      #${PANEL_ID}.vklm-idle-hidden {
        opacity: 0;
        pointer-events: none;
      }
      #${PANEL_ID} .vklm-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex: none;
      }
      #${PANEL_ID} .vklm-icon {
        opacity: 0.7;
        font-size: 12px;
        display: inline-block;
      }
      #${PANEL_ID}.vklm-pulse .vklm-icon {
        animation: vklm-spin 0.5s linear;
      }
      @keyframes vklm-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  // Резервный способ достать video/кнопки, если внутренний API плеера недоступен -
  // они лежат во вложенных shadow DOM, обычный querySelector их не видит.
  function findDeep(root, selector) {
    const el = root.querySelector(selector);
    if (el) return el;
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) {
        const found = findDeep(node.shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  }

  // <vk-video-player> хранит реактивный стор плеера (RxJS-подобные *$ поля и
  // готовые экшены типа setQuality/switchToActiveLive) - используем его напрямую,
  // это надёжнее и не мигает UI, в отличие от кликов по DOM-меню настроек.
  function getPlayerApi() {
    const el = document.querySelector('vk-video-player');
    if (!el || !el.store) return null;
    let player;
    try {
      player = el.store.getPlayer();
    } catch (e) {
      return null;
    }
    if (!player || !player.info) return null;
    const actions = el.store.actions && el.store.actions.internal;
    return { el, info: player.info, actions };
  }

  function enforceMaxQuality(api) {
    try {
      const tracks = api.info.availableVideoTracks$.getValue();
      if (!tracks || !tracks.length) return;
      const maxTrack = tracks.reduce((a, b) => (b.size.height > a.size.height ? b : a));
      const current = api.info.currentQuality$.getValue();
      const isAuto = api.info.isAutoQualityEnabled$.getValue();
      if ((isAuto || current !== maxTrack.quality) && api.actions && api.actions.setQuality) {
        api.actions.setQuality(maxTrack.quality, false);
      }
    } catch (e) {
      // API плеера изменилось / недоступно - просто пропускаем эту итерацию
    }
  }

  function softReload() {
    const api = getPlayerApi();
    try {
      if (api && api.actions && api.actions.switchToActiveLive) {
        api.actions.switchToActiveLive();
        return;
      }
    } catch (e) {}

    const liveBtn = findDeep(document, '[data-testid="btn-live-offset"]');
    if (liveBtn) {
      liveBtn.click();
      return;
    }

    const video = findDeep(document, 'video');
    if (video && video.seekable && video.seekable.length) {
      video.currentTime = Math.max(0, video.seekable.end(video.seekable.length - 1) - 0.5);
      if (video.paused) video.play().catch(() => {});
    }
  }

  function getLag(api) {
    try {
      if (api && api.info.liveLatency$) return api.info.liveLatency$.getValue();
    } catch (e) {}
    const video = findDeep(document, 'video');
    if (video && video.seekable && video.seekable.length) {
      return Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime);
    }
    return null;
  }

  // Плеер прячет свою нижнюю панель управления, добавляя ей класс controls-hidden
  // после нескольких секунд бездействия курсора - синхронизируем с этим floating-бейдж.
  // Ссылку кэшируем, т.к. эта проверка дёргается на каждое движение мыши, а полный
  // обход (в т.ч. вложенных shadow DOM) на каждый mousemove был бы расточительным.
  let cachedControlsWrapper = null;
  function getControlsWrapper() {
    if (cachedControlsWrapper && cachedControlsWrapper.isConnected) return cachedControlsWrapper;
    cachedControlsWrapper = findDeep(document, '[class*="wrapper-bottom"]');
    return cachedControlsWrapper;
  }
  function areControlsHidden() {
    const wrapper = getControlsWrapper();
    if (!wrapper) return false;
    return wrapper.className.toString().includes('controls-hidden');
  }

  function buildBadge() {
    const el = document.createElement('div');
    el.id = PANEL_ID;
    el.title = 'Клик - мягкий перезапуск стрима (сброс к актуальному лайву)';
    el.innerHTML = `
      <span class="vklm-dot"></span>
      <span class="vklm-label">—</span>
      <span class="vklm-icon">⟳</span>
    `;
    el.addEventListener('click', () => {
      softReload();
      el.classList.remove('vklm-pulse');
      void el.offsetWidth;
      el.classList.add('vklm-pulse');
    });
    return el;
  }

  function getChatTopBar() {
    const bar = document.querySelector('[class*="StreamChatTopPanel_root_"]');
    if (!bar || !bar.offsetParent) return null;
    // При сворачивании чата панель не исчезает из DOM, а уезжает за пределы
    // экрана (translate/left за viewport) - offsetParent на это не реагирует.
    const rect = bar.getBoundingClientRect();
    if (rect.width < 60 || rect.left >= window.innerWidth || rect.right <= 0) return null;
    return bar;
  }

  // У некоторых стримеров сверху видео на всю ширину висит баннер с алертами
  // (донаты/подписки) - без него достаточно небольшого отступа, а поверх него
  // бейдж перекрывал бы текст, поэтому ставим его чуть ниже баннера.
  function topOffsetForVideo(videoRect) {
    const banner = document.querySelector('[class*="TopMenu_root_"]');
    if (banner) {
      const bannerRect = banner.getBoundingClientRect();
      if (bannerRect.width > videoRect.width * 0.5 && bannerRect.bottom > videoRect.top) {
        return bannerRect.bottom + 8;
      }
    }
    return videoRect.top + 10;
  }

  // Встраивает бейдж настоящим ребёнком в шапку чата (перед иконкой участников),
  // чтобы флекс-контейнер сам расставил отступы вместе с остальными иконками -
  // никакой ручной математики позиционирования и никакого оверлея поверх плеера.
  // Если чат закрыт - всплывает над плеером; в fullscreen обычный document.body
  // не рендерится (браузер рисует только поддерево fullscreen-элемента), поэтому
  // в этом случае бейдж переезжает внутрь document.fullscreenElement.
  function placeBadge(bar, video) {
    const kind = bar ? 'inline' : 'floating';
    let badge = document.getElementById(PANEL_ID);
    if (badge && badge.dataset.kind !== kind) {
      badge.remove();
      badge = null;
    }
    if (!badge) {
      badge = buildBadge();
      badge.dataset.kind = kind;
    }

    if (kind === 'inline') {
      const controls = bar.querySelector('[class*="StreamChatTopPanel_controls_"]');
      const nextSibling = controls || null;
      if (badge.parentElement !== bar || badge.nextElementSibling !== nextSibling) {
        if (controls) bar.insertBefore(badge, controls);
        else bar.appendChild(badge);
      }
      badge.style.top = '';
      badge.style.left = '';
      badge.classList.remove('vklm-idle-hidden');
    } else {
      const fsEl = document.fullscreenElement;
      const targetParent = fsEl || document.body;
      if (badge.parentElement !== targetParent) targetParent.appendChild(badge);
      if (video) {
        const rect = video.getBoundingClientRect();
        badge.style.top = `${Math.max(8, topOffsetForVideo(rect))}px`;
        badge.style.left = `${Math.max(8, rect.right - 140)}px`;
      }
      badge.classList.toggle('vklm-idle-hidden', areControlsHidden());
    }

    return badge;
  }

  function updateLoop() {
    injectStyles();
    const api = getPlayerApi();
    const lag = getLag(api);
    const video = findDeep(document, 'video');
    // Шапка чата - обычный DOM-узел вне поддерева fullscreen-элемента. Браузер в
    // fullscreen рисует поверх всей страницы именно это поддерево (даже там, где
    // оно само ничего не рисует), поэтому всё, что вставлено в чат, становится
    // невидимым - принудительно уходим в floating, пока активен fullscreen.
    const bar = document.fullscreenElement ? null : getChatTopBar();

    if (lag === null) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }

    const badge = placeBadge(bar, video);
    badge.querySelector('.vklm-label').textContent = `${lag.toFixed(1)} с`;
    badge.title = `Лаг стрима: ${lag.toFixed(1)} с. Клик - мягкий перезапуск (сброс к актуальному лайву)`;

    let color = '#3fd15e';
    if (lag > 15) color = '#ff4d4f';
    else if (lag > 5) color = '#ffb020';
    badge.querySelector('.vklm-dot').style.background = color;

    if (api) enforceMaxQuality(api);
  }

  // Лёгкая синхронизация видимости floating-бейджа с курсором - полный updateLoop
  // (лаг, качество, поиск video/чата) гоняем раз в секунду по таймеру, а тут только
  // дешёвая проверка класса controls-hidden, троттлинг нужен т.к. mousemove стреляет часто.
  let idleSyncScheduled = false;
  function syncIdleVisibility() {
    const badge = document.getElementById(PANEL_ID);
    if (!badge || badge.dataset.kind !== 'floating') return;
    badge.classList.toggle('vklm-idle-hidden', areControlsHidden());
  }
  function scheduleIdleSync() {
    if (idleSyncScheduled) return;
    idleSyncScheduled = true;
    setTimeout(() => {
      idleSyncScheduled = false;
      syncIdleVisibility();
    }, 150);
  }

  document.addEventListener('mousemove', scheduleIdleSync, { passive: true });
  // При входе/выходе из fullscreen document.body перестаёт (или начинает) рендериться -
  // сразу переносим бейдж, не дожидаясь следующего тика интервала.
  document.addEventListener('fullscreenchange', updateLoop);

  setInterval(updateLoop, 1000);
  updateLoop();
})();
