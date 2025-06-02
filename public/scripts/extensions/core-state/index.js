import { debounce, cancelDebounce } from '../../utils.js';
import {
    chat,
    addOneMessage,
    eventSource,
    event_types,
    system_message_types,
    setExtensionPrompt,
    extension_prompt_roles,
    extension_prompt_types,
} from '../../../script.js';
import { getContext } from '../../extensions.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';

/** @typedef {string[]} SceneArray */


const ctx = /** @type {any} */ (globalThis.SillyTavern?.getContext?.()) ?? {};
export let playerName = ctx.character?.name || ctx.persona?.name || 'Player';
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

const xpNeeded = lvl => lvl * 100;

// TODO: move this XP table to external JSON defaults
// Player level progression still relies on xpNeeded(level) = level * 100.
// The values below are only used for enemy reward amounts and do not
// influence how a character levels up.
export const ENEMY_XP = { E: 10, D: 25, C: 60, B: 120, A: 250, S: 500 };

function blankChar(name = '') {
    const c = {
        name,
        portrait: null,
        abilities: [],
        inventory: [],
        buffs: {},
        str: 0,
        dex: 0,
        vit: 0,
        mind: 0,
        level: 1,
        xp: 0,
        max_xp: xpNeeded(1),
    };
    recalcDerived(c);
    return c;
}

function defaultState() {
    return {
        characters: {},
        enemies: {},
        clock: { minute: 0 },
        sceneObjects: [],
        meta: { chatId, ver: 3 },
    };
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

if ((state.meta?.ver ?? 0) < 2) {
    const needs = Object.values(state.characters || {}).some((c) => c.max_hp === 100);
    if (needs) {
        for (const char of Object.values(state.characters)) {
            recalcDerived(char);
        }
    }
    state.meta = state.meta || {};
    state.meta.ver = 2;
    persist();
}

if ((state.meta?.ver ?? 0) < 3) {
    state.enemies = state.enemies || {};
    state.meta = state.meta || {};
    state.meta.ver = 3;
    persist();
}

function rollStat() {
    let sum = 2;
    for (let i = 0; i < 4; i++) sum += Math.floor(Math.random() * 4) + 1;
    return sum;
}

function recalcDerived(char) {
    char.max_hp = 10 + char.vit;
    char.max_mp = 5 + char.mind;
    if (char.hp === undefined) char.hp = char.max_hp;
    if (char.mp === undefined) char.mp = char.max_mp;
    char.hp = Math.min(char.hp, char.max_hp);
    char.mp = Math.min(char.mp, char.max_mp);
    if (char.level === 1 && char.xp === 0) {
        if (char.hp < char.max_hp) char.hp = char.max_hp;
        if (char.mp < char.max_mp) char.mp = char.max_mp;
    }
}

function maybeInitStats() {
    let changed = false;
    for (const char of Object.values(state.characters)) {
        let rolled = false;
        if (!char.level) {
            char.level = 1;
            changed = true;
        }
        if (char.xp === undefined) {
            char.xp = 0;
            changed = true;
        }
        if (char.max_xp === undefined) {
            char.max_xp = xpNeeded(char.level);
            changed = true;
        }
        if (!char.str) {
            char.str = rollStat();
            rolled = true;
            changed = true;
        }
        if (!char.dex) {
            char.dex = rollStat();
            rolled = true;
            changed = true;
        }
        if (!char.vit) {
            char.vit = rollStat();
            rolled = true;
            changed = true;
        }
        if (!char.mind) {
            char.mind = rollStat();
            rolled = true;
            changed = true;
        }
        const hp = char.hp;
        const mp = char.mp;
        const max_hp = char.max_hp;
        const max_mp = char.max_mp;
        recalcDerived(char);
        if (rolled) {
            if (char.hp < char.max_hp) char.hp = char.max_hp;
            if (char.mp < char.max_mp) char.mp = char.max_mp;
        }
        if (char.hp !== hp || char.mp !== mp || char.max_hp !== max_hp || char.max_mp !== max_mp) {
            changed = true;
        }
    }
    if (changed) persist();
}

function normalizeState() {
    state.characters = state.characters || {};
    state.enemies = state.enemies || {};
    state.clock = state.clock || { minute: 0 };
    state.sceneObjects = state.sceneObjects || [];
    state.meta = state.meta || { chatId, ver: 3 };
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
    if (!state.characters[name]) state.characters[name] = blankChar(name);
    return name;
}

export function getState(target) {
    if (target) return JSON.parse(JSON.stringify(state.characters[target] || {}));
    return JSON.parse(JSON.stringify(state));
}

export function getCompanionSnapshot(target) {
    const root = getState();
    const char = root.characters?.[target] || {};
    const scene = (root.sceneObjects || []).join(', ');
    const inv = (char.inventory || []).join(', ');
    const abil = (char.abilities || []).join(', ');
    const lines = [];
    if (scene) lines.push(`Scene Objects: ${scene}`);
    if (inv) lines.push(`Inventory: ${inv}`);
    if (abil) lines.push(`Abilities: ${abil}`);
    return lines.join('\n');
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

export function addXP(target, delta, reason) {
    const name = ensureChar(target);
    const c = state.characters[name];
    const prevLevel = c.level;
    c.xp = Math.max(0, c.xp + delta);
    let leveled = false;
    while (c.xp >= xpNeeded(c.level)) {
        c.xp -= xpNeeded(c.level);
        c.level += 1;
        recalcDerived(c);
        leveled = true;
    }
    c.max_xp = xpNeeded(c.level);
    saveDebounced();
    window.dispatchEvent(new CustomEvent('xpChange', {
        detail: { target: name, delta, current: c.xp, level: c.level, reason: reason ?? null },
        bubbles: true,
        composed: true,
    }));
    if (leveled && c.level > prevLevel) {
        window.dispatchEvent(new CustomEvent('levelUp', {
            detail: { target: name, level: c.level },
            bubbles: true,
            composed: true,
        }));
    }
    // hard-refresh HUD if it exists (covers rare event-miss cases)
    globalThis.HUDPanel?.update?.();
}

export function gainXP(delta, reason) {
    return addXP(undefined, delta, reason);
}

export function modStat(stat, delta) {
    ensureChar();
    const c = state.characters[playerName];
    if (typeof c[stat] !== 'number') c[stat] = 0;
    c[stat] += delta;
    recalcDerived(c);
    saveDebounced();
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

export function spawnEnemy({ id, name, tier = 'E', hp = 1, portrait = null }) {
    if (!id) return;
    hp = parseInt(hp, 10) || 0;
    tier = String(tier || '').toUpperCase();
    state.enemies[id] = { id, name, tier, hp, maxHP: hp, portrait, abilities: [] };
    saveDebounced();
    // TODO: portrait handling and HUD integration
    window.dispatchEvent(new CustomEvent('enemySpawn', { detail: { ...state.enemies[id] } }));
}

export function modEnemyHP(id, delta) {
    const enemy = state.enemies[id];
    if (!enemy) return;
    // spawnEnemy already normalizes hp to a number
    enemy.hp = Number(enemy.hp) + delta;
    if (enemy.hp <= 0) {
        grantXPFromTier(enemy.tier);
        delete state.enemies[id];
        saveDebounced();
        window.dispatchEvent(new CustomEvent('enemyDespawn', { detail: { id } }));
    } else {
        saveDebounced();
        window.dispatchEvent(new CustomEvent('enemyHPChange', { detail: { id, delta, hp: enemy.hp } }));
    }
}

export function despawnEnemy(id) {
    if (!state.enemies[id]) return;
    delete state.enemies[id];
    saveDebounced();
    // TODO: HUD integration
    window.dispatchEvent(new CustomEvent('enemyDespawn', { detail: { id } }));
}

export function getEnemy(id) {
    const e = state.enemies[id];
    return e ? { ...e } : undefined;
}

export function grantXPFromTier(tier) {
    const xp = ENEMY_XP[tier] || 0;
    if (xp > 0) gainXP(xp, 'enemy');
}

export function advanceTime() { /* TODO */ }

export async function runSelfTest() {
    clearState();
    await new Promise(r => requestAnimationFrame(r));

    const fails = [];
    let step = 1;
    let pass = 0;
    const assert = (cond, desc) => {
        if (!cond) {
            console.error(`CoreState self-test step ${step} failed: ${desc}`);
            fails.push(step);
        } else {
            pass++;
        }
        console.assert(cond, desc);
        step++;
    };

    const baseStats = getStats();
    const pools = getState(playerName);
    assert(
        [baseStats.str, baseStats.dex, baseStats.vit, baseStats.mind].every(v => v >= 6 && v <= 18) &&
            baseStats.level === 1 &&
            baseStats.xp === 0 &&
            pools.max_hp <= 60 &&
            pools.max_mp <= 50 &&
            pools.max_xp === xpNeeded(1) &&
            pools.hp === pools.max_hp &&
            pools.mp === pools.max_mp,
        'Initial stats valid'
    );

    // use gainXP() so the default player is targeted
    gainXP(50);
    const after50 = getStats();
    assert(after50.level === 1 && after50.xp === 50, 'gainXP(50) adds XP but no level');

    gainXP(150);
    const afterLevel = getStats();
    assert(afterLevel.level === 2 && afterLevel.xp === 100, 'gainXP(150) levels up');

    const msg = `*CoreState self-test: ${pass}/3 checks passed${fails.length ? ' — failed: ' + fails.join(', ') + ' ❌' : ' ✔️'}*`;
    inject(msg, { name: 'SelfTest' });
    return '';
}

function onChatChanged() {
    const context = getContext();
    playerName = context.character?.name || context.persona?.name || 'Player';
    chatId = context.chatId || 'default';
    STORAGE_KEY = `st.rpg.coreState.v1::${chatId}`;
    state = loadState();
    normalizeState();
    globalThis.HUDPanel?.update?.();
}

eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
eventSource.on(event_types.GROUP_MEMBER_DRAFTED, (id) => {
    if (id === playerName) return;
    const snap = getCompanionSnapshot(id);
    setExtensionPrompt(`corestate-${id}`, snap, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
});

// Ensure pending state saves are flushed before the page unloads
window.addEventListener('beforeunload', () => {
    cancelDebounce(saveDebounced);
    persist();
});

window['getState'] = getState;
window['getStats'] = getStats;
window['modHP'] = modHP;
window['clearState'] = clearState;
window['snapshot'] = snapshot;
window['modMP'] = modMP;
window['addXP'] = addXP;
window['addItem'] = addItem;
window['removeItem'] = removeItem;
window['advanceTime'] = advanceTime;
window['playerName'] = playerName;
window['setScene'] = setScene;
window['setSceneObjects'] = setScene;
window['CoreState'] = {
    getState,
    getStats,
    modHP,
    modMP,
    addXP,
    gainXP,
    setScene,
    setSceneObjects: setScene,
    addItem,
    removeItem,
    spawnEnemy,
    modEnemyHP,
    despawnEnemy,
    getEnemy,
    grantXPFromTier,
    clearState,
    snapshot,
    getCompanionSnapshot,
    runSelfTest,
};

window['$rpg'] = {
    gainXP,
    modStat,
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