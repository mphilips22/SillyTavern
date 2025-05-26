import { debounce } from '../../utils.js';

let defaultMaxHp = 100;

export function setDefaultMaxHp(value) {
    defaultMaxHp = value;
}

const ctx = /** @type {any} */ (globalThis.SillyTavern?.getContext?.()) ?? {};
export const playerName = ctx.character?.name || ctx.persona?.name || 'Player';
const chatId = ctx.chat?.id || 'default';
const STORAGE_KEY = `st.rpg.coreState.v1::${chatId}`;

function blankChar() {
    return { hp: defaultMaxHp, max_hp: defaultMaxHp, mp: 0, max_mp: 100, inventory: [], buffs: {} };
}

let state = (() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (err) {
            console.error('Failed to parse core state:', err);
        }
    }
    return { characters: {}, clock: { minute: 0 }, meta: { chatId, ver: 1 } };
})();

state.characters = state.characters || {};
state.clock = state.clock || { minute: 0 };
state.meta = state.meta || { chatId, ver: 1 };
if (!state.characters[playerName]) state.characters[playerName] = blankChar();

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
    state = { characters: {}, clock: { minute: 0 }, meta: { chatId, ver: 1 } };
    saveDebounced();
    window.dispatchEvent(new CustomEvent('stateReset', { bubbles: true, composed: true }));
}

export function snapshot() {
    return JSON.parse(JSON.stringify(state));
}

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

export function addItem(target, item) {
    const name = ensureChar(target);
    const c = state.characters[name];
    c.inventory.push(item);
    saveDebounced();
    window.dispatchEvent(new CustomEvent('itemAdd', {
        detail: { target: name, item },
        bubbles: true,
        composed: true,
    }));
}

export function removeItem(target, item) {
    const name = ensureChar(target);
    const c = state.characters[name];
    const idx = c.inventory.indexOf(item);
    if (idx !== -1) {
        c.inventory.splice(idx, 1);
        saveDebounced();
        window.dispatchEvent(new CustomEvent('itemRemove', {
            detail: { target: name, item },
            bubbles: true,
            composed: true,
        }));
    }
}

export function advanceTime() { /* TODO */ }

window['getState'] = getState;
window['modHP'] = modHP;
window['clearState'] = clearState;
window['snapshot'] = snapshot;
window['modMP'] = modMP;
window['addItem'] = addItem;
window['removeItem'] = removeItem;
window['advanceTime'] = advanceTime;
window['playerName'] = playerName;
window['setDefaultMaxHp'] = setDefaultMaxHp;
window['CoreState'] = {
    getState,
    modHP,
    modMP,
    addItem,
    removeItem,
    clearState,
    snapshot,
    setDefaultMaxHp,
};

/* ===============================================================
   Dev smoke test – paste into browser console after reload
================================================================ */
/* ===== Core-State smoke test =====
clearState();                     // reset
setDefaultMaxHp(150);             // customise initial HP
modHP(undefined, 50);             // heal +50 (defaults to player)
modHP(undefined, -7, "club");     // dmg -7
const s = getState(playerName);
console.assert(s.hp === 143, "HP calc failed");

let fired = false;
window.addEventListener("hpChange", e=>{
  if(e.detail.delta === -7) fired = true;
});
modHP(playerName, -7);
console.assert(fired, "hpChange event not fired");
*/
