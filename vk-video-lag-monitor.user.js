// ==UserScript==
// @name         VK Video Live - Lag Monitor & Soft Reload
// @namespace    https://tampermonkey.net/
// @version      1.0
// @description  Показывает задержку (лаг) прямого эфира на live.vkvideo.ru и добавляет кнопку мягкого перезапуска (сброс к актуальному лайву) без перезагрузки страницы
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

  // VK-video-player хранит video и все контролы внутри вложенных shadow DOM,
  // поэтому обычный querySelector их не видит - ищем рекурсивно.
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

    panel.querySelector('.vklm-reload').addEventListener('click', softReload);

    // Если плеер разворачивают в fullscreen, переносим панель внутрь fullscreen-элемента,
    // иначе она окажется скрыта браузером вместе с остальным document.body.
    document.addEventListener('fullscreenchange', () => {
      const fsEl = document.fullscreenElement;
      (fsEl || document.body).appendChild(panel);
    });

    return panel;
  }

  function softReload() {
    const reloadBtn = document.querySelector(`#${PANEL_ID} .vklm-reload`);
    // Родная кнопка плеера "Перемотать на актуальный лайв" - самый надёжный способ
    // мягко скинуть лаг: не трогает страницу, просто сдвигает воспроизведение к live-эджу.
    const liveBtn = findDeep(document, '[data-testid="btn-live-offset"]');
    if (liveBtn) {
      liveBtn.click();
    } else {
      const video = findDeep(document, 'video');
      if (video && video.seekable && video.seekable.length) {
        video.currentTime = Math.max(0, video.seekable.end(video.seekable.length - 1) - 0.5);
        if (video.paused) video.play().catch(() => {});
      }
    }

    if (reloadBtn) {
      reloadBtn.classList.remove('vklm-spin');
      void reloadBtn.offsetWidth;
      reloadBtn.classList.add('vklm-spin');
    }
  }

  function positionPanel(panel, video) {
    const rect = video.getBoundingClientRect();
    panel.style.top = `${Math.max(8, rect.top + 10)}px`;
    panel.style.left = `${Math.max(8, rect.right - 150)}px`;
  }

  function updateLoop() {
    const panel = createPanel();
    const video = findDeep(document, 'video');
    const label = panel.querySelector('.vklm-label');
    const dot = panel.querySelector('.vklm-dot');

    if (!video || !video.seekable || video.seekable.length === 0) {
      panel.style.display = 'none';
      return;
    }

    const liveEdge = video.seekable.end(video.seekable.length - 1);
    const lag = Math.max(0, liveEdge - video.currentTime);

    panel.style.display = 'flex';
    positionPanel(panel, video);
    label.textContent = `лаг: ${lag.toFixed(1)} с`;

    let color = '#3fd15e';
    if (lag > 15) color = '#ff4d4f';
    else if (lag > 5) color = '#ffb020';
    dot.style.background = color;
  }

  injectStyles();
  setInterval(updateLoop, 1000);
  updateLoop();
})();
