import { debounce } from '../../utils.js';
import {
    chat,
    addOneMessage,
    eventSource,
    event_types,
    system_message_types,
} from '../../../script.js';
import { getContext } from '../../extensions.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';

/** @typedef {string[]} SceneArray */

let defaultMaxHp = 100;

export function setDefaultMaxHp(value) {
    defaultMaxHp = value;
}

const ctx = /** @type {any} */ (globalThis.SillyTavern?.getContext?.()) ?? {};
export const playerName = ctx.character?.name || ctx.persona?.name || 'Player';
let chatId = ctx.chat?.id || 'default';
let STORAGE_KEY = `st.rpg.coreState.v1::${chatId}`;

const inject = globalThis.SillyTavern?.injectAssistant
    || globalThis.ST?.injectAssistant
    || ((html, opts = {}) => {
        const context = globalThis.SillyTavern?.getContext?.() ?? {};
        const chatArr = context.chat || chat;
        if (!Array.isArray(chatArr)) return;
        const message = {
            name: opts.name || 'SelfTest',
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: String(html),
            extra: { type: system_message_types.ASSISTANT_MESSAGE },
        };
        chatArr.push(message);
        const mid = chatArr.length - 1;
        eventSource.emit(event_types.MESSAGE_RECEIVED, mid, 'extension');
        addOneMessage(message);
        eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, mid, 'extension');
        context.saveChat?.();
        return mid;
    });

function blankChar() {
    return {
        hp: defaultMaxHp,
        max_hp: defaultMaxHp,
        mp: 0,
        max_mp: 100,
        inventory: [],
        buffs: {},
        str: 0,
        dex: 0,
        vit: 0,
        mind: 0,
        level: 1,
        xp: 0,
    };
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

function rollStat() {
    let sum = 2;
    for (let i = 0; i < 4; i++) sum += Math.floor(Math.random() * 4) + 1;
    return sum;
}

function maybeInitStats() {
    let changed = false;
    for (const char of Object.values(state.characters)) {
        if (!char.level) {
            char.level = 1;
            changed = true;
        }
        if (char.xp === undefined) {
            char.xp = 0;
            changed = true;
        }
        if (!char.str) {
            char.str = rollStat();
            changed = true;
        }
        if (!char.dex) {
            char.dex = rollStat();
            changed = true;
        }
        if (!char.vit) {
            char.vit = rollStat();
            changed = true;
        }
        if (!char.mind) {
            char.mind = rollStat();
            changed = true;
        }
    }
    if (changed) persist();
}

function normalizeState() {
    state.characters = state.characters || {};
    state.clock = state.clock || { minute: 0 };
    state.sceneObjects = state.sceneObjects || [];
    state.meta = state.meta || { chatId, ver: 1 };
    if (!state.characters[playerName]) state.characters[playerName] = blankChar();
    maybeInitStats();
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

export function getStats(target) {
    const name = target || playerName;
    const c = state.characters[name] || {};
    return {
        str: c.str,
        dex: c.dex,
        vit: c.vit,
        mind: c.mind,
        level: c.level,
        xp: c.xp,
    };
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

export async function runSelfTest() {
    clearState();
    await new Promise(r => requestAnimationFrame(r));
    const stats = getStats();
    const ok =
        [stats.str, stats.dex, stats.vit, stats.mind].every(v => v >= 6 && v <= 18) &&
        stats.level === 1 &&
        stats.xp === 0;
    inject(ok ? '*CoreState self-test passed ✔️*' : '*CoreState self-test failed ❌*', { name: 'SelfTest' });
    return '';
}

function onChatChanged() {
    const context = getContext();
    chatId = context.chatId || 'default';
    STORAGE_KEY = `st.rpg.coreState.v1::${chatId}`;
    state = loadState();
    normalizeState();
}

eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

window['getState'] = getState;
window['getStats'] = getStats;
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
    getStats,
    modHP,
    modMP,
    setScene,
    setSceneObjects: setScene,
    addItem,
    removeItem,
    clearState,
    snapshot,
    setDefaultMaxHp,
    runSelfTest,
};

SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
        name: 'corestate-selftest',
        callback: runSelfTest,
        helpString: 'Run the CoreState self-test.',
    }),
);

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
