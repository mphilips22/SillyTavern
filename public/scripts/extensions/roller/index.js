// Imported from /public/script.js
import { eventSource, event_types } from '../../../script.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
// Core state utilities in /public/scripts/extensions/core-state
import * as CoreState from '../../core-state/index.js';

const TxStore = {};

function ensureSettings() {
    const ctx = /** @type {any} */ (globalThis.SillyTavern?.getContext?.()) ?? {};
    ctx.extensionSettings ??= {};
    ctx.extensionSettings.features ??= {};
    const feat = ctx.extensionSettings.features;
    if (!feat.roller) {
        feat.roller = { enabled: true };
        ctx.saveSettingsDebounced?.();
    } else if (feat.roller.enabled === undefined) {
        feat.roller.enabled = true;
        ctx.saveSettingsDebounced?.();
    }
    return feat.roller;
}

export function parse(expr) {
    if (typeof expr !== 'string') return 'Invalid expression';
    const clean = expr.replace(/\s+/g, '');
    const m = /^(\d*)d(\d+)(k[hl]\d+)?([+-]\d+)?$/i.exec(clean);
    if (!m) return 'Invalid expression';
    const n = parseInt(m[1] || '1', 10);
    const sides = parseInt(m[2], 10);
    if (n < 1 || n > 100 || sides < 1 || sides > 1000) return 'Invalid expression';
    let keep = null;
    if (m[3]) {
        const type = m[3][1].toLowerCase();
        const count = parseInt(m[3].slice(2), 10);
        if (count < 1 || count > n) return 'Invalid expression';
        keep = { type, count };
    }
    const mod = m[4] ? parseInt(m[4], 10) : 0;
    const rolls = [];
    for (let i = 0; i < n; i++) {
        rolls.push(Math.floor(Math.random() * sides) + 1);
    }
    let kept = rolls.slice();
    if (keep) {
        kept = rolls
            .slice()
            .sort((a, b) => (keep.type === 'h' ? b - a : a - b))
            .slice(0, keep.count);
    }
    const total = kept.reduce((a, b) => a + b, 0) + mod;
    const parts = kept.map(String);
    if (mod !== 0) parts.push(mod > 0 ? String(mod) : `-${Math.abs(mod)}`);
    const text = `${parts.join(' + ')} = ${total} (${clean})`;
    return { rolls, kept, total, text };
}

function applyPatch(patch) {
    if (!patch || !patch.verb) return;
    const fn = CoreState[patch.verb];
    if (typeof fn !== 'function') {
        console.warn('[Roller] unknown verb', patch.verb);
        return;
    }
    const args = [];
    if (patch.target !== undefined) args.push(patch.target);
    if (patch.delta !== undefined) args.push(patch.delta);
    if (patch.item !== undefined) args.push(patch.item);
    fn(...args);
}

function invert(patch) {
    if (!patch) return null;
    const inv = { ...patch };
    if (patch.verb === 'modHP' || patch.verb === 'modMP') {
        inv.delta = -patch.delta;
    } else if (patch.verb === 'addItem') {
        inv.verb = 'removeItem';
    } else if (patch.verb === 'removeItem') {
        inv.verb = 'addItem';
    }
    return inv;
}

export function autoRoll(expr, patch = null) {
    const settings = ensureSettings();
    if (!settings.enabled) return null;
    const ctx = /** @type {any} */ (globalThis.SillyTavern?.getContext?.()) ?? {};
    const res = parse(expr);
    if (typeof res === 'string') return null;
    const message = {
        name: 'Roller',
        is_user: false,
        is_system: false,
        mes: res.text,
        send_date: Date.now(),
    };
    ctx.chat?.push(message);
    const mid = ctx.chat ? ctx.chat.length - 1 : 0;
    eventSource?.emit?.(event_types.MESSAGE_RECEIVED, mid, 'extension');
    ctx.addOneMessage?.(message);
    eventSource?.emit?.(event_types.CHARACTER_MESSAGE_RENDERED, mid, 'extension');
    ctx.saveChat?.();
    const msgId = ctx.chat?.lastAssistantMsgId ?? mid;
    if (patch) {
        applyPatch(patch);
        TxStore[msgId] = { patch, invertPatch: invert(patch) };
    }
    window.dispatchEvent(
        new CustomEvent('diceRoll', {
            detail: { expr, rolls: res.rolls, total: res.total, messageId: msgId },
        }),
    );
    return msgId;
}

export function undoTx(id) {
    const tx = TxStore[id];
    if (!tx) return;
    applyPatch(tx.invertPatch);
    delete TxStore[id];
}

(function init() {
    const settings = ensureSettings();
    if (!settings.enabled) return;
    eventSource?.on?.(event_types.MESSAGE_SENT, (id) => {
        const ctx = /** @type {any} */ (globalThis.SillyTavern?.getContext?.()) ?? {};
        const msg = ctx.chat?.[id];
        if (!msg?.is_user) return;
        const text = String(msg.mes || '').trim();
        if (text.toLowerCase().startsWith('/roll')) {
            const expr = text.slice(5).trim() || '1d6';
            autoRoll(expr);
        }
    });
    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: 'roll',
            helpString: 'Roll dice using NdS notation. Example: /roll 2d6+1',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'dice expression',
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
            ],
            callback: async (_, expr) => {
                const expression = String(expr || '1d6');
                autoRoll(expression);
                return '';
            },
        }),
    );
    eventSource?.on?.(event_types.MESSAGE_DELETED, (id) => undoTx(id));
})();

window['Roller'] = { parse, autoRoll, undoTx };

/* ===== Roller smoke test =====
CoreState.clearState();
CoreState.modHP(undefined, 40);
const id = Roller.autoRoll('1d4+1', { verb: 'modHP', delta: -5 });
Roller.undoTx(id);
const cur = CoreState.getState(CoreState.playerName).hp;
console.assert(cur === 40, 'HP after undo should be 40');
*/
