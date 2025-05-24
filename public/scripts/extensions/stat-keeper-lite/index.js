import {
    chat,
    addOneMessage,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';

const SLOT = 'StatKeeperLite';
const TAG = /\[(HP|MP|MANA)\s*([+-]\d+)(?:\s+([\w\s'-]+))?\]/gi;
const colorFor = (k, n) =>
    k === 'HP'
        ? n < 0
            ? '#e74c3c'
            : '#27ae60'
        : n < 0
            ? '#1f4e79'
            : '#3498db';

const processedMessages = new Set();

function store() {
    return (extension_settings[SLOT] ??= {});
}

function save() {
    saveSettingsDebounced();
}

function d6_13() {
    return 6 + Math.floor(Math.random() * 8);
}

function ensurePlayer() {
    const st = store();
    if (st.player) return;
    st.player = {
        STR: d6_13(),
        DEX: d6_13(),
        INT: d6_13(),
        MP: 20,
        MaxMP: 20,
        sceneObjects: [],
    };
    st.player.MaxHP = st.player.HP =
        16 + ((st.player.STR + st.player.DEX) >> 2);
    save();
}

function clamp(v, m) {
    return Math.max(0, Math.min(m, v));
}

function highlightTags(element) {
    if (!element) return;
    if (element.querySelector('.sklTag')) return;
    element.innerHTML = element.innerHTML.replace(TAG, (m, k, n) => {
        const val = Number(n);
        return `<span class="sklTag" style="color:${colorFor(k.toUpperCase(), val)}">${m}</span>`;
    });
}

function highlightAll() {
    document.querySelectorAll('#chat .mes_text').forEach(highlightTags);
}

function formatStats() {
    ensurePlayer();
    const p = store().player;
    return `[[SYSTEM]] HP ${p.HP}/${p.MaxHP}  •  MP ${p.MP}/${p.MaxMP}  •  STR ${p.STR}  DEX ${p.DEX}  INT ${p.INT}`;
}

function postSystemMessage(html) {
    const mesId = chat.length;
    chat.push({
        name: 'SYSTEM',
        is_system: true,
        is_user: false,
        mes: html,
        send_date: Date.now(),
    });
    addOneMessage(chat[mesId]);
}

function applyTagsFromMessage(text) {
    if (!text) return;
    let m;
    TAG.lastIndex = 0;
    ensurePlayer();
    const st = store();
    let playerChanged = false;
    while ((m = TAG.exec(text))) {
        const [, rawK, numStr, rawName] = m;
        const kind = rawK.toUpperCase().replace('MANA', 'MP');
        const delta = Number(numStr);
        const tgt = (rawName ?? '_PLAYER_').trim();
        const pool =
            tgt === '_PLAYER_' || /^you$/i.test(tgt)
                ? st.player
                : ((st.npc ??= {})[tgt.toLowerCase()] ??= {
                    name: tgt,
                    HP: 20,
                    MaxHP: 20,
                    MP: 20,
                    MaxMP: 20,
                });
        if (pool === st.player) playerChanged = true;
        if (kind === 'HP') pool.HP = clamp((pool.HP ?? 0) + delta, pool.MaxHP);
        else pool.MP = clamp((pool.MP ?? 0) + delta, pool.MaxMP);
    }
    if (playerChanged)
        postSystemMessage(
            `[[SYSTEM]] HP ${st.player.HP}/${st.player.MaxHP}  •  MP ${st.player.MP}/${st.player.MaxMP}`,
        );
    save();
}

function scanSceneList(text) {
    if (!text) return;
    const lines = String(text).split(/\r?\n/);
    const start = lines.findIndex((l) => /^Scene( objects)?:/i.test(l.trim()));
    if (start === -1) return;
    ensurePlayer();
    const objects = (store().player.sceneObjects ??= []);
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') break;
        const match = /^[•*-]\s*(.+)/.exec(line);
        if (!match) continue;
        let obj = match[1].trim().replace(/[.,;!?]+$/, '').trim();
        if (obj && !objects.includes(obj)) objects.push(obj);
    }
    if (typeof globalThis.updateHUD === 'function') {
        globalThis.updateHUD();
    }
    eventSource.emit('statkeeper:update');
}

function handleRenderedMessage(id) {
    const mes = chat[id];
    if (!mes) return;
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    highlightTags(el);
    if (processedMessages.has(id)) return;
    if (!mes.is_user) {
        applyTagsFromMessage(mes.mes);
        scanSceneList(mes.mes);
        processedMessages.add(id);
    }
}

eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleRenderedMessage);
eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    highlightTags(el);
});
eventSource.on(event_types.APP_READY, highlightAll);
eventSource.on(event_types.CHAT_CHANGED, highlightAll);
eventSource.on(event_types.CHAT_CHANGED, () => processedMessages.clear());

SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
        name: 'stats',
        aliases: ['getstats'],
        callback: () => {
            postSystemMessage(formatStats());
            return '';
        },
        helpString: 'Show current player stats',
    }),
);

ensurePlayer();
console.log('[StatKeeper-Lite] ready');
