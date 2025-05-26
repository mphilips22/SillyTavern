// Core-State extension
import { debounce, cancelDebounce } from '../../utils.js';
import { getContext } from '../../extensions.js';

export { getState, modHP, clearState, snapshot, modMP, addItem, removeItem, advanceTime };

const STORAGE_PREFIX = 'st.rpg.coreState.v1::';
const VERSION = 1;

let currentChatId = null;
let state = null;

const saveDebounced = debounce(saveState, 250);

function getChatId() {
    const ctx = getContext();
    return ctx?.chatId || ctx?.chat?.id || ctx?.getCurrentChatId?.() || 'default';
}

function storageKey(id) {
    return `${STORAGE_PREFIX}${id}`;
}

function createBlankState(chatId) {
    return {
        characters: {},
        clock: { minute: 0 },
        meta: { chatId, ver: VERSION },
    };
}

function ensureState() {
    const id = getChatId();
    if (state && currentChatId === id) return;
    currentChatId = id;
    try {
        const raw = localStorage.getItem(storageKey(id));
        state = raw ? JSON.parse(raw) : createBlankState(id);
    } catch (e) {
        console.error('Core-State: Failed to load state', e);
        state = createBlankState(id);
    }
    state.meta.chatId = id;
}

function saveState() {
    if (!state) return;
    try {
        localStorage.setItem(storageKey(currentChatId), JSON.stringify(state));
    } catch (e) {
        console.error('Core-State: Failed to save state', e);
    }
}

function defaultName() {
    const ctx = getContext();
    return ctx?.character?.name || ctx?.persona?.name || 'Player';
}

function ensureChar(name) {
    if (!state.characters[name]) {
        state.characters[name] = {
            hp: 100,
            max_hp: 100,
            mp: 100,
            max_mp: 100,
            inventory: [],
            buffs: {},
        };
    }
    const c = state.characters[name];
    if (c.max_hp === undefined) c.max_hp = 100;
    if (c.max_mp === undefined) c.max_mp = 100;
    if (c.hp === undefined) c.hp = c.max_hp;
    if (c.mp === undefined) c.mp = c.max_mp;
    if (!c.inventory) c.inventory = [];
    if (!c.buffs) c.buffs = {};
    return c;
}

function getState(target) {
    ensureState();
    if (!target) return structuredClone(state);
    return state.characters[target] ? structuredClone(state.characters[target]) : undefined;
}

function snapshot() {
    ensureState();
    return structuredClone(state);
}

function modHP(target, delta, reason = null) {
    ensureState();
    const name = target || defaultName();
    const char = ensureChar(name);
    const prev = char.hp;
    char.hp = Math.min(char.max_hp, Math.max(0, prev + delta));
    saveDebounced();
    const event = new CustomEvent('hpChange', {
        detail: { target: name, delta, current: char.hp, max: char.max_hp, reason },
        bubbles: true,
        composed: true,
    });
    window.dispatchEvent(event);
    return char.hp;
}

function clearState() {
    ensureState();
    cancelDebounce(saveDebounced);
    localStorage.removeItem(storageKey(currentChatId));
    state = createBlankState(currentChatId);
    const event = new CustomEvent('stateReset', { bubbles: true, composed: true });
    window.dispatchEvent(event);
}

// TODO: implement MP modification
function modMP() { /* TODO */ }
// TODO: implement inventory addition
function addItem() { /* TODO */ }
// TODO: implement inventory removal
function removeItem() { /* TODO */ }
// TODO: implement clock advancement
function advanceTime() { /* TODO */ }

/* Dev smoke test
clearState();
modHP(null, 50);
modHP(null, -7, 'club');
const charName = Object.keys(getState().characters)[0];
console.assert(getState(charName).hp === 43, 'HP should be 43');
let fired = false;
window.addEventListener('hpChange', () => { fired = true; }, { once: true });
modHP(charName, -1);
console.assert(fired, 'hpChange listener fired');
*/
