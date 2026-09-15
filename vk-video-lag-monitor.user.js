// ==UserScript==
// @name         VK Video Live - Lag Monitor, Soft Reload & Max Quality
// @namespace    https://tampermonkey.net/
// @version      2.0
// @description  Показывает задержку (лаг) прямого эфира, добавляет кнопку мягкого ресинка к лайву и держит плеер на максимальном качестве на live.vkvideo.ru
// @author       you
// @match        https://live.vkvideo.ru/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'vk-lag-monitor-panel';
  const STYLE_ID = 'vk-lag-monitor-style';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        z-index: 2147483647;
        display: none;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: rgba(20, 20, 20, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        font: 12px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        color: #fff;
        user-select: none;
      }
      #${PANEL_ID} .vklm-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
      }
      #${PANEL_ID} .vklm-label {
        white-space: nowrap;
      }
      #${PANEL_ID} button.vklm-reload {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
        padding: 0;
      }
      #${PANEL_ID} button.vklm-reload:hover {
        background: rgba(255, 255, 255, 0.25);
      }
      #${PANEL_ID} button.vklm-reload.vklm-spin {
        animation: vklm-spin 0.6s linear;
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

  function createPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <span class="vklm-dot"></span>
      <span class="vklm-label">лаг: —</span>
      <button class="vklm-reload" title="Мягкий перезапуск (сброс к актуальному лайву)">⟳</button>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.vklm-reload').addEventListener('click', () => {
      const reloadBtn = panel.querySelector('.vklm-reload');
      softReload();
      reloadBtn.classList.remove('vklm-spin');
      void reloadBtn.offsetWidth;
      reloadBtn.classList.add('vklm-spin');
    });

    // В fullscreen переносим панель внутрь fullscreen-элемента, иначе браузер
    // скроет её вместе с остальным document.body.
    document.addEventListener('fullscreenchange', () => {
      const fsEl = document.fullscreenElement;
      (fsEl || document.body).appendChild(panel);
    });

    return panel;
  }

  function positionPanel(panel, video) {
    const rect = video.getBoundingClientRect();
    panel.style.top = `${Math.max(8, rect.top + 10)}px`;
    panel.style.left = `${Math.max(8, rect.right - 150)}px`;
  }

  function updateLoop() {
    const panel = createPanel();
    const api = getPlayerApi();
    const lag = getLag(api);
    const label = panel.querySelector('.vklm-label');
    const dot = panel.querySelector('.vklm-dot');

    if (lag === null) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'flex';
    const video = findDeep(document, 'video');
    if (video) positionPanel(panel, video);
    label.textContent = `лаг: ${lag.toFixed(1)} с`;

    let color = '#3fd15e';
    if (lag > 15) color = '#ff4d4f';
    else if (lag > 5) color = '#ffb020';
    dot.style.background = color;

    if (api) enforceMaxQuality(api);
  }

  injectStyles();
  setInterval(updateLoop, 1000);
  updateLoop();
})();
