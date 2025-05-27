import * as CoreState from '../core-state/index.js';
import { name1, user_avatar, getUserAvatar } from '../../../script.js';

console.log('[HUD-panel] script loaded');
/** @type {any} */
const ctx = globalThis.SillyTavern?.getContext?.() ?? {};
const chatId = ctx.chatId || ctx.chat?.id || 'default';
const STORAGE_KEY = `hudPanelPos::${chatId}`;

function injectCss() {
    if (!document.getElementById('hud-panel-style')) {
        const link = document.createElement('link');
        link.id = 'hud-panel-style';
        link.rel = 'stylesheet';
        link.href = 'scripts/extensions/hud-panel/hud-panel.css';
        document.head.appendChild(link);
    }
}

function loadPos() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch { return {}; }
}

function savePos(pos) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
}

function makeDraggable(div) {
    const pos = loadPos();
    div.style.position = 'absolute';
    div.style.zIndex = '1000';
    if (typeof pos.left === 'number') div.style.left = pos.left + 'px';
    if (typeof pos.top === 'number') div.style.top = pos.top + 'px';

    let offX = 0, offY = 0;
    const onMove = e => {
        div.style.left = e.clientX - offX + 'px';
        div.style.top = e.clientY - offY + 'px';
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        savePos({ left: parseInt(div.style.left, 10) || 0, top: parseInt(div.style.top, 10) || 0 });
    };
    div.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const rect = div.getBoundingClientRect();
        offX = e.clientX - rect.left;
        offY = e.clientY - rect.top;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    });
}

function createPanel() {
    const div = document.createElement('div');
    div.className = 'hud-panel';
    div.innerHTML = `
        <img class="hud-avatar">
        <div class="hud-name"></div>
        <div class="hud-bar"><progress class="hud-hp" max="100" value="0"></progress><div class="hud-value hud-hp-value"></div></div>
        <div class="hud-bar"><progress class="hud-mp" max="100" value="0"></progress><div class="hud-value hud-mp-value"></div></div>
        <details class="hud-scene"><summary>Scene Objects (0)</summary><ul></ul></details>
        <details class="hud-inv"><summary>Inventory (0)</summary><ul></ul></details>`;
    document.body.prepend(div);
    makeDraggable(div);
    return div;
}

function renderSceneObjects(arr = []) {
    const sceneUl = document.querySelector('.hud-panel .hud-scene ul');
    const sceneSum = document.querySelector('.hud-panel .hud-scene summary');
    if (!sceneUl || !sceneSum) return;
    sceneUl.innerHTML = '';
    if (!Array.isArray(arr) || arr.length === 0) {
        sceneUl.style.display = 'none';
        sceneSum.textContent = 'Scene Objects (0)';
        return;
    }
    sceneUl.style.display = '';
    arr.forEach(it => {
        const li = document.createElement('li');
        li.textContent = it;
        sceneUl.appendChild(li);
    });
    sceneSum.textContent = `Scene Objects (${arr.length})`;
}

function updatePanel(div) {
    const state = CoreState.getState(CoreState.playerName) || {};
    div.querySelector('.hud-avatar').src = getUserAvatar(user_avatar);
    div.querySelector('.hud-name').textContent = name1;
    const hp = div.querySelector('.hud-hp');
    const hpVal = div.querySelector('.hud-hp-value');
    if (hp) {
        hp.max = state.max_hp || 0;
        hp.value = state.hp || 0;
        hpVal.textContent = `${state.hp ?? 0} / ${state.max_hp ?? 0}`;
    }
    const mp = div.querySelector('.hud-mp');
    const mpVal = div.querySelector('.hud-mp-value');
    if (mp) {
        mp.max = state.max_mp || 0;
        mp.value = state.mp || 0;
        mpVal.textContent = `${state.mp ?? 0} / ${state.max_mp ?? 0}`;
    }
    const invUl = div.querySelector('.hud-inv ul');
    const invSum = div.querySelector('.hud-inv summary');
    if (invUl && invSum) {
        invUl.innerHTML = '';
        (state.inventory || []).forEach(it => {
            const li = document.createElement('li');
            li.textContent = it;
            invUl.appendChild(li);
        });
        invSum.textContent = `Inventory (${(state.inventory || []).length})`;
    }
    renderSceneObjects(state.sceneObjects || []);
}

export function init() {
    const settings = ctx.extensionSettings || {};
    if (settings.features?.hudPanel?.enabled === false) return;
    injectCss();
    const panel = createPanel();
    updatePanel(panel);
    renderSceneObjects(CoreState.getState().sceneObjects);
    window.addEventListener('hpChange', () => updatePanel(panel));
    window.addEventListener('mpChange', () => updatePanel(panel));
    window.addEventListener('itemAdd', () => updatePanel(panel));
    window.addEventListener('itemRemove', () => updatePanel(panel));
    window.addEventListener('stateReset', () => updatePanel(panel));
    window.addEventListener('sceneUpdate', e => {
        renderSceneObjects(e.detail.items);
    });
    globalThis.HUDPanel = { element: panel, update: () => updatePanel(panel) };
}

if (document.readyState !== 'loading') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
}

/* ===============================================================
   Dev smoke test – paste into browser console after reload
================================================================ */
/*
clearState();
setScene(['Torch','Key']);
→ HUD shows 2 scene objects.
setScene(['Ruby']);
→ HUD updates to 1 scene object.
*/
