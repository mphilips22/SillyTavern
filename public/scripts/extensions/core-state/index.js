import { debounce } from '../../utils.js';
import { eventSource, event_types } from '../../../script.js';
import { getContext } from '../../extensions.js';

/** @typedef {string[]} SceneArray */

let defaultMaxHp = 100;

export function setDefaultMaxHp(value) {
    defaultMaxHp = value;
}

const ctx = /** @type {any} */ (globalThis.SillyTavern?.getContext?.()) ?? {};
export const playerName = ctx.character?.name || ctx.persona?.name || 'Player';
let chatId = ctx.chat?.id || 'default';
let STORAGE_KEY = `st.rpg.coreState.v1::${chatId}`;

function blankChar() {
    return { hp: defaultMaxHp, max_hp: defaultMaxHp, mp: 0, max_mp: 100, inventory: [], buffs: {} };
}

function defaultState() {
    return { characters: {}, clock: { minute: 0 }, sceneObjects: [], meta: { chatId, ver: 1 } };
}

function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (err) {
            console.error('Failed to parse core state:', err);
        }
    }
    return defaultState();
}

let state = loadState();

function normalizeState() {
    state.characters = state.characters || {};
    state.clock = state.clock || { minute: 0 };
    state.sceneObjects = state.sceneObjects || [];
    state.meta = state.meta || { chatId, ver: 1 };
    if (!state.characters[playerName]) state.characters[playerName] = blankChar();
}

normalizeState();

function persist() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
        console.error('Failed to save core state:', err);
    }
}

const saveDebounced = debounce(persist, 250);

function ensureChar(target) {
    const name = target || playerName;
    if (!state.characters[name]) state.characters[name] = blankChar();
    return name;
}

export function getState(target) {
    if (target) return JSON.parse(JSON.stringify(state.characters[target] || {}));
    return JSON.parse(JSON.stringify(state));
}

export function modHP(target, delta, reason) {
    const name = ensureChar(target);
    const c = state.characters[name];
    c.hp = Math.max(0, Math.min(c.max_hp, c.hp + delta));
    saveDebounced();
    window.dispatchEvent(new CustomEvent('hpChange', {
        detail: { target: name, delta, current: c.hp, max: c.max_hp, reason: reason ?? null },
        bubbles: true,
        composed: true,
    }));
}

export function clearState() {
    state = defaultState();
    normalizeState();
    saveDebounced();
    window.dispatchEvent(new CustomEvent('stateReset', { bubbles: true, composed: true }));
}

export function snapshot() {
    return JSON.parse(JSON.stringify(state));
}

/**
 * Replace the current scene objects.
 * @param {SceneArray} items
 */
export function setScene(items = []) {
    state.sceneObjects = [...items];
    saveDebounced();
    window.dispatchEvent(new CustomEvent('sceneUpdate', { detail: { items: [...state.sceneObjects] } }));
}

export { setScene as setSceneObjects };

export function modMP(target, delta, reason) {
    const name = ensureChar(target);
    const c = state.characters[name];
    c.mp = Math.max(0, Math.min(c.max_mp, c.mp + delta));
    saveDebounced();
    window.dispatchEvent(new CustomEvent('mpChange', {
        detail: { target: name, delta, current: c.mp, max: c.max_mp, reason: reason ?? null },
        bubbles: true,
        composed: true,
    }));
}

/** @param {string=} target @param {string} itemId */
export function addItem(target, itemId) {
    const name = ensureChar(target);
    const c = state.characters[name];
    if (!c.inventory.includes(itemId)) {
        c.inventory.push(itemId);
        saveDebounced();
        window.dispatchEvent(new CustomEvent('itemAdd', {
            detail: { item: itemId },
            bubbles: true,
            composed: true,
        }));
    }
}

/** @param {string=} target @param {string} itemId */
export function removeItem(target, itemId) {
    const name = ensureChar(target);
    const c = state.characters[name];
    const idx = c.inventory.indexOf(itemId);
    if (idx !== -1) {
        c.inventory.splice(idx, 1);
        saveDebounced();
        window.dispatchEvent(new CustomEvent('itemRemove', {
            detail: { item: itemId },
            bubbles: true,
            composed: true,
        }));
    }
}

export function advanceTime() { /* TODO */ }

function onChatChanged() {
    const context = getContext();
    chatId = context.chatId || 'default';
    STORAGE_KEY = `st.rpg.coreState.v1::${chatId}`;
    state = loadState();
    normalizeState();
}

eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

window['getState'] = getState;
window['modHP'] = modHP;
window['clearState'] = clearState;
window['snapshot'] = snapshot;
window['modMP'] = modMP;
window['addItem'] = addItem;
window['removeItem'] = removeItem;
window['advanceTime'] = advanceTime;
window['playerName'] = playerName;
window['setScene'] = setScene;
window['setSceneObjects'] = setScene;
window['setDefaultMaxHp'] = setDefaultMaxHp;
window['CoreState'] = {
    getState,
    modHP,
    modMP,
    setScene,
    setSceneObjects: setScene,
    addItem,
    removeItem,
    clearState,
    snapshot,
    setDefaultMaxHp,
};

/* ===============================================================
   Dev smoke test – paste into browser console after reload
================================================================ */
/* === v1.1 smoke test ===
clearState();
setScene(['Sword','Shield']);
console.assert(getState().sceneObjects.length === 2, 'scene set');

addItem(undefined, 'Sword');
console.assert(getState().characters[playerName].inventory.includes('Sword'),
               'inventory add');

removeItem(undefined, 'Sword');
console.assert(!getState().characters[playerName].inventory.includes('Sword'),
               'inventory remove');
*/
