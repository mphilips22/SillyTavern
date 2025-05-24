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

function canonical(item) {
    return String(item ?? '')
        .toLowerCase()
        .split(/[,(–]/)[0]
        .trim();
}

function highlightTags(element) {
    if (!element) return;
    if (element.querySelector('.sklTag')) return;
    element.innerHTML = element.innerHTML.replace(TAG, (m, k, n) => {
        const val = Number(n);
        return `<span class="sklTag" style="color:${colorFor(k.toUpperCase(), val)}">${m}</span>`;
    });
}

function hideSyncMessages() {
    document.querySelectorAll('#chat .mes_text .skl-hidden').forEach((span) => {
        const mes = span.closest('.mes');
        if (mes) mes.classList.add('skl-hidden-message');
    });
}

function highlightAll() {
    document.querySelectorAll('#chat .mes_text').forEach(highlightTags);
    hideSyncMessages();
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

function pushSync(sceneArr, invArr) {
    const mesId = chat.length;
    chat.push({
        name: 'SYSTEM',
        is_system: false,
        is_user: false,
        mes:
            '<span class="skl-hidden">SYNC|' +
            JSON.stringify({ scene: sceneArr, inv: invArr }) +
            '</span>',
        send_date: Date.now(),
    });
    addOneMessage(chat[mesId]);
    hideSyncMessages();
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

function scanSceneList(text) {
    if (!text) return;
    ensurePlayer();
    const lines = String(text).split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*Scene(?: objects)?:\s*$/i.test(lines[i].trim())) {
            store().player.sceneObjects = [];
            start = i + 1;
            break;
        }
    }
    if (start === -1) return;
    const bulletRe = /^\s*[\u2022*-]\s*(.+)$/;
    const p = store().player;
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) break;
        const m = bulletRe.exec(line);
        if (!m) break;
        let item = m[1].trim().replace(/[.,;!?]+$/g, '').trim();
        if (item) p.sceneObjects.push(item);
    }
    updateHUD();
    window.dispatchEvent(new CustomEvent('statkeeper:update', { detail: p }));
    save();
    pushSync(p.sceneObjects, p.inventory);
}

const takeRe = /\b(?:take|grab|pick\s+up|pocket|stash|add)\b[\s-]*(.+?)(?:\bto\b|\binto\b|\bin\b|\bmy\b|\bpack\b|\bbackpack\b|$)/i;
const dropRe = /\b(?:drop|discard|give|remove|put\s+down)\b[\s-]*(.+?)(?:\bfrom\b|\bto\b|\bmy\b|\binventory\b|\bpack\b|\bbackpack\b|$)/i;

function autoDropFromUser(text) {
    if (!text) return false;
    const m = dropRe.exec(text);
    if (!m) return false;
    const want = canonical(m[1]);
    ensurePlayer();
    const p = store().player;
    const cands = p.inventory.filter((o) => canonical(o) === want);
    if (cands.length === 1) {
        const item = cands[0];
        const idx = p.inventory.indexOf(item);
        if (idx >= 0) p.inventory.splice(idx, 1);
        p.sceneObjects.push(item);
        updateHUD();
        window.dispatchEvent(new CustomEvent('statkeeper:update', { detail: p }));
        save();
        pushSync(p.sceneObjects, p.inventory);
        postSystemMessage('[SYSTEM] ' + item + ' dropped.');
        return true;
    }
    return false;
}

function autoTakeFromUser(text) {
    if (!text) return;
    const m = takeRe.exec(text);
    if (!m) return;
    const want = canonical(m[1]);
    ensurePlayer();
    const p = store().player;
    const cands = p.sceneObjects.filter((o) => canonical(o) === want);
    if (cands.length === 1) {
        const item = cands[0];
        const idx = p.sceneObjects.indexOf(item);
        if (idx >= 0) p.sceneObjects.splice(idx, 1);
        p.inventory.push(item);
        updateHUD();
        window.dispatchEvent(new CustomEvent('statkeeper:update', { detail: p }));
        save();
        pushSync(p.sceneObjects, p.inventory);
        postSystemMessage('[SYSTEM] ' + item + ' taken.');
    }
}

function handleRenderedMessage(id) {
    const mes = chat[id];
    if (!mes) return;
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    highlightTags(el);
    hideSyncMessages();
    if (processedMessages.has(id)) return;
    if (!mes.is_user) {
        applyTagsFromMessage(mes.mes);
        scanSceneList(mes.mes);
        processedMessages.add(id);
    }
}

eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleRenderedMessage);
eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
    const mes = chat[id];
    if (mes?.is_user) {
        if (!autoDropFromUser(mes.mes)) autoTakeFromUser(mes.mes);
    }
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    highlightTags(el);
    hideSyncMessages();
});
eventSource.on(event_types.APP_READY, () => {
    highlightAll();
    injectHUD();
});
eventSource.on(event_types.CHAT_CHANGED, highlightAll);
eventSource.on(event_types.CHAT_CHANGED, () => processedMessages.clear());
eventSource.on(event_types.CHAT_CHANGED, () => {
    store().player.sceneObjects = [];
    updateHUD();
});

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
        name: 'invclear',
        aliases: ['bagclear'],
        callback: () => {
            const p = store().player;
            p.inventory.length = 0;
            updateHUD();
            save();
            pushSync(p.sceneObjects, p.inventory);
            postSystemMessage('[SYSTEM] Inventory cleared');
            return '';
        },
        helpString: 'Clear inventory list',
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
            const want = canonical(itemName);
            const matches = p.sceneObjects.filter((o) => canonical(o) === want);
            if (matches.length === 1) {
                const fullText = matches[0];
                const idx = p.sceneObjects.indexOf(fullText);
                if (idx >= 0) p.sceneObjects.splice(idx, 1);
                p.inventory.push(fullText);
                updateHUD();
                window.dispatchEvent(new CustomEvent('statkeeper:update', { detail: p }));
                save();
                pushSync(p.sceneObjects, p.inventory);
            } else {
                postSystemMessage(`[SYSTEM] '${itemName}' not found`);
            }
            return '';
        },
        helpString: 'Take item from scene',
        rawQuotes: true,
    }),
);

SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
        name: 'drop',
        aliases: ['give', 'discard'],
        callback: (_, arg) => {
            ensurePlayer();
            const p = store().player;
            const want = canonical(typeof arg === 'string' ? arg.trim() : '');
            const matches = p.inventory.filter((o) => canonical(o) === want);
            if (matches.length === 1) {
                const fullText = matches[0];
                const idx = p.inventory.indexOf(fullText);
                if (idx >= 0) p.inventory.splice(idx, 1);
                p.sceneObjects.push(fullText);
                updateHUD();
                save();
                pushSync(p.sceneObjects, p.inventory);
                postSystemMessage('[SYSTEM] ' + fullText + ' dropped.');
            } else {
                postSystemMessage(`[SYSTEM] '${arg}' not in inventory`);
            }
            return '';
        },
        helpString: 'Drop item from inventory',
        rawQuotes: true,
    }),
);

SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
        name: 'sceneclear',
        aliases: ['clrs', 'scenereset'],
        callback: () => {
            const p = store().player;
            p.sceneObjects.length = 0;
            updateHUD();
            window.dispatchEvent(new CustomEvent('statkeeper:update', { detail: p }));
            save();
            pushSync(p.sceneObjects, p.inventory);
            postSystemMessage('[SYSTEM] Scene list cleared');
            return '';
        },
        helpString: 'Clear scene object list',
    }),
);

ensurePlayer();
