import {
    chat,
    addOneMessage,
    eventSource,
    event_types,
    saveSettingsDebounced,
    characters,
    this_chid,
    getThumbnailUrl,
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
    st.settings ??= {};
    if (!st.player) {
        st.player = {
            STR: d6_13(),
            DEX: d6_13(),
            INT: d6_13(),
            MP: 20,
            MaxMP: 20,
            inventory: [],
            sceneObjects: [],
        };
        st.player.MaxHP = st.player.HP =
            16 + ((st.player.STR + st.player.DEX) >> 2);
    } else {
        st.player.inventory ??= [];
        st.player.sceneObjects ??= [];
    }
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

let lastHp = 0;
function updateHUD() {
    ensurePlayer();
    const p = store().player;
    const hud = document.getElementById('skl-hud');
    if (!hud) return;
    const char = characters?.[this_chid];
    if (char) {
        const avatarEl = /** @type {HTMLImageElement|null} */ (document.getElementById('skl-avatar'));
        const nameEl = document.getElementById('skl-name');
        if (avatarEl) avatarEl.src = getThumbnailUrl('avatar', char.avatar);
        if (nameEl) nameEl.textContent = char.name;
    }
    const hp = /** @type {HTMLProgressElement|null} */ (document.getElementById('skl-hp'));
    const mp = /** @type {HTMLProgressElement|null} */ (document.getElementById('skl-mp'));
    if (hp) {
        if (lastHp > p.HP) {
            hp.classList.add('dmg-flash');
            setTimeout(() => hp.classList.remove('dmg-flash'), 600);
        }
        hp.max = p.MaxHP;
        hp.value = p.HP;
    }
    lastHp = p.HP;
    if (mp) {
        mp.max = p.MaxMP;
        mp.value = p.MP;
    }
    const statsEl = document.getElementById('skl-stats');
    if (statsEl) statsEl.textContent = `STR ${p.STR}  DEX ${p.DEX}  INT ${p.INT}`;
    const equipEl = document.getElementById('skl-equipped');
    if (equipEl) equipEl.textContent = p.equipped ? `Equipped: ${p.equipped}` : '';
    const invUl = /** @type {HTMLUListElement|null} */ (document.querySelector('#skl-inv ul'));
    if (invUl) {
        invUl.innerHTML = '';
        p.inventory.forEach((it) => {
            const li = document.createElement('li');
            li.textContent = it;
            invUl.appendChild(li);
        });
        const summary = document.querySelector('#skl-inv summary');
        if (summary) summary.textContent = `Inventory (${p.inventory.length})`;
    }
    const sceneUl = /** @type {HTMLUListElement|null} */ (document.querySelector('#skl-scene ul'));
    if (sceneUl) {
        sceneUl.innerHTML = '';
        p.sceneObjects.forEach((it) => {
            const li = document.createElement('li');
            li.textContent = it;
            sceneUl.appendChild(li);
        });
        const summary = document.querySelector('#skl-scene summary');
        if (summary) summary.textContent = `Scene (${p.sceneObjects.length})`;
    }
}

function injectHUD() {
    if (document.getElementById('skl-hud')) return;
    if (!document.getElementById('skl-style')) {
        const link = document.createElement('link');
        link.id = 'skl-style';
        link.rel = 'stylesheet';
        link.href = 'styles/extensions/statkeeper.css';
        document.head.appendChild(link);
    }
    const div = document.createElement('div');
    div.id = 'skl-hud';
    div.innerHTML =
        '<img id="skl-avatar"><div id="skl-name"></div><progress id="skl-hp" max="100" value="100"></progress><progress id="skl-mp" max="100" value="100"></progress><span id="skl-stats"></span><span id="skl-equipped"></span><details id="skl-inv"><summary>Inventory (0)</summary><ul></ul></details><details id="skl-scene"><summary>Scene (0)</summary><ul></ul></details>';
    (document.querySelector('#sidebar') ?? document.body).prepend(div);
    updateHUD();
    console.log('[StatKeeper-HUD] ready');
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
    if (playerChanged) {
        if (st.settings?.showSystemLines) {
            postSystemMessage(
                `[[SYSTEM]] HP ${st.player.HP}/${st.player.MaxHP}  •  MP ${st.player.MP}/${st.player.MaxMP}`,
            );
        }
        updateHUD();
        window.dispatchEvent(new CustomEvent('statkeeper:update', { detail: st.player }));
    }
    save();
}

function handleRenderedMessage(id) {
    const mes = chat[id];
    if (!mes) return;
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    highlightTags(el);
    if (processedMessages.has(id)) return;
    if (!mes.is_user) {
        applyTagsFromMessage(mes.mes);
        processedMessages.add(id);
    }
}

eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleRenderedMessage);
eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    highlightTags(el);
});
eventSource.on(event_types.APP_READY, () => {
    highlightAll();
    injectHUD();
});
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

SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
        name: 'inv',
        callback: () => {
            ensurePlayer();
            const p = store().player;
            postSystemMessage(`[SYSTEM] Inventory: ${p.inventory.join(', ') || 'empty'}`);
            return '';
        },
        helpString: 'List inventory items',
    }),
);

SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
        name: 'scene',
        callback: () => {
            ensurePlayer();
            const p = store().player;
            postSystemMessage(`[SYSTEM] Scene: ${p.sceneObjects.join(', ') || 'none'}`);
            return '';
        },
        helpString: 'List scene objects',
    }),
);

SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
        name: 'take',
        callback: (_, item) => {
            ensurePlayer();
            const p = store().player;
            const itemName = typeof item === 'string' ? item.trim() : '';
            const idx = p.sceneObjects.indexOf(itemName);
            if (idx >= 0) {
                p.sceneObjects.splice(idx, 1);
                p.inventory.push(itemName);
                updateHUD();
                window.dispatchEvent(new CustomEvent('statkeeper:update', { detail: p }));
                save();
            } else {
                postSystemMessage(`[SYSTEM] '${itemName}' not found`);
            }
            return '';
        },
        helpString: 'Take item from scene',
        rawQuotes: true,
    }),
);

ensurePlayer();
