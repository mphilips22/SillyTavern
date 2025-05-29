import { chat, eventSource, event_types, comment_avatar, system_message_types, saveSettingsDebounced } from '../../../script.js';
import * as CoreState from '../core-state/index.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import {
    ARGUMENT_TYPE,
    SlashCommandNamedArgument,
    SlashCommandArgument,
} from '../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { debounce, setValueByPath } from '../../utils.js';
import { extension_settings } from '../../extensions.js';

function loadExtensionSetting(path, def) {
    const parts = path.split('.');
    let obj = extension_settings;
    for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]] = obj[parts[i]] || {};
    }
    const key = parts[parts.length - 1];
    if (obj[key] === undefined) obj[key] = def;
    return obj[key];
}

function saveExtensionSetting(path, value){
    setValueByPath(extension_settings, path, value);
    saveSettingsDebounced();
}
let STRICT = loadExtensionSetting('ruleVault.strict', true);

function canon(id){
    return String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unknownItem(id){
    console.warn('[RuleVault] unknown item', id);
    if(STRICT) {
        commentBubble(`Unknown item: ${id}`);
    }
}

function personaName(){
    return SillyTavern?.getContext?.().character?.name
      || SillyTavern?.getContext?.().persona?.name
      || 'Player';
}

function parseItems(str){
    if(!str) return [];
    const clean = str.replace(/^\[|\]$/g,'');
    return clean.split(',').map(s=>s.trim()).filter(Boolean);
}

function stripHtml(html){
    if(!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || '';
}

function findInventoryItem(target, id){
    const c = canon(id);
    const name = target || personaName();
    const state = CoreState.getState();
    const inv = state.characters?.[name]?.inventory || [];
    return inv.find(it => canon(it)  ===  c);
}

function removeInventoryItem(target, id){
    const actual = findInventoryItem(target, id);
    if(actual){
        CoreState.removeItem(target, actual);
        return true;
    }
    return false;
}

const ctx = SillyTavern?.getContext?.() ?? {};

function commentBubble(text){
    const message = {
        name: 'Note',
        is_user: false,
        is_system: true,
        send_date: Date.now(),
        mes: String(text),
        force_avatar: comment_avatar,
        extra: {
            type: system_message_types.COMMENT,
            gen_id: Date.now(),
        },
    };
    chat.push(message);
    const mid = chat.length - 1;
    eventSource.emit(event_types.MESSAGE_SENT, mid);
    ctx.addOneMessage?.(message);
    eventSource.emit(event_types.USER_MESSAGE_RENDERED, mid);
    ctx.saveChat?.();
}

function assistantBubble(text){
    const message = {
        name: 'RuleVault',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: String(text),
        extra: { type: system_message_types.ASSISTANT_MESSAGE },
    };
    chat.push(message);
    const mid = chat.length - 1;
    eventSource.emit(event_types.MESSAGE_RECEIVED, mid, 'extension');
    ctx.addOneMessage?.(message);
    eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, mid, 'extension');
    ctx.saveChat?.();
}

const chatId = ctx.chat?.id || 'default';
const STORAGE_KEY = `st.rpg.coreState.v1::${chatId}`;
const saveSceneDebounced = debounce(() => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(CoreState.getState()));
    } catch (err) {
        console.error('[RuleVault] save failed', err);
    }
}, 250);

function coreSetScene(items){
    const canonItems = [...new Set(items.map(canon))];
    if(typeof CoreState.setScene  ===  'function'){
        CoreState.setScene(canonItems); // event dispatched inside
        return;
    }
    if(typeof CoreState.updateSceneObjects  ===  'function'){
        CoreState.updateSceneObjects(canonItems);
    }else{
        const state = CoreState.getState();
        state.sceneObjects = canonItems;
        saveSceneDebounced();
    }
    window.dispatchEvent(new CustomEvent('sceneUpdate', { detail:{ items: canonItems } }));
}

function removeSceneItem(item){
    const c = canon(item);
    const state = CoreState.getState();
    const items = (state.sceneObjects || []).filter(it => canon(it)  !==  c);
    if(items.length  !==  (state.sceneObjects || []).length){
        coreSetScene(items);
        return true;
    }
    return false;
}

function addSceneItem(item){
    const state = CoreState.getState();
    const items = new Set((state.sceneObjects || []).map(canon));
    items.add(canon(item));
    coreSetScene([...items]);
}

function dropItem(target, item){
    const id = canon(item);
    CoreState.removeItem(target, id);
    addSceneItem(id);
}


function clearSceneSlash(){
    coreSetScene([]);
    return '';
}

function clearInventorySlash(args){
    const target = args?.target || personaName();
    const state = CoreState.getState();
    const items = state.characters?.[target]?.inventory || [];
    for(const item of items){
        CoreState.removeItem(target, item);
    }
    return '';
}

function setStrictMode(enable){
    STRICT = enable;
    saveExtensionSetting('ruleVault.strict', enable);
    assistantBubble(enable ? '*Strict mode enabled*' : '*Strict mode disabled*');
}

function rulevaultStrictSlash(_, state){
    const token = String(state || '').toLowerCase();
    if(token === 'on' || token === 'off'){
        setStrictMode(token === 'on');
    }else{
        assistantBubble(STRICT ? '*Strict mode enabled*' : '*Strict mode disabled*');
    }
    return '';
}

function handleCommand(cmd){
    if(!cmd) return;
    if(cmd.verb  ===  'setScene'){
        const items = parseItems(cmd.args.items);
        coreSetScene(items);
    }else if(cmd.verb  ===  'removeItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            if(target.toLowerCase()  ===  'scene'){
                if(removeSceneItem(cmd.args.item)){
                    window.dispatchEvent(new CustomEvent('itemRemove', { detail:{ item: canon(cmd.args.item) } }));
                } else {
                    unknownItem(cmd.args.item);
                }
            }else{
                dropItem(target, cmd.args.item);
            }
        }
    }else if(cmd.verb  ===  'consumeItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            const id = canon(cmd.args.item);
            let removed = false;
            if(target.toLowerCase()  ===  'scene'){
                const scene = CoreState.getState().sceneObjects || [];
                if(!scene.find(it => canon(it)  ===  id)){
                    if(STRICT){
                        commentBubble(`Unknown item: ${cmd.args.item}`);
                        return;
                    }
                    addSceneItem(id);
                }
                removed = removeSceneItem(id);
            } else {
                const inv = CoreState.getState().characters?.[target]?.inventory || [];
                if(!inv.find(it => canon(it)  ===  id)){
                    if(STRICT){
                        commentBubble(`Unknown item: ${cmd.args.item}`);
                        return;
                    }
                    CoreState.addItem(target, id);
                }
                removed = removeInventoryItem(target, id);
                if(!removed){
                    removed = removeSceneItem(id);
                }
            }
            if(removed){
                window.dispatchEvent(new CustomEvent('itemRemove', { detail:{ item: id } }));
            }
        }
    }else if(cmd.verb  ===  'modHP'){
        const target = cmd.args.target || personaName();
        const amount = parseInt(cmd.args.amount, 10) || 0;
        const reason = cmd.args.reason;
        CoreState.modHP(target, amount, reason);
    }else if(cmd.verb  ===  'modMP'){
        const target = cmd.args.target || personaName();
        const amount = parseInt(cmd.args.amount, 10) || 0;
        CoreState.modMP(target, amount);
    }else if(cmd.verb  ===  'dropItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            dropItem(target, cmd.args.item);
        }
    }else if(cmd.verb  ===  'clearScene'){
        coreSetScene([]);
    }else if(cmd.verb  ===  'clearInv'){
        const target = cmd.args.target || personaName();
        const state = CoreState.getState();
        const items = state.characters?.[target]?.inventory || [];
        for (const item of items) {
            CoreState.removeItem(target, item);
        }
    }
}

function parseCommands(line) {
    if (!line.startsWith('::')) return [];
    const raw = line.slice(2).trim();
    const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
    const cmds = [];
    for (const part of parts) {
        const m = /^(\w+)\s*(.*)$/.exec(part);
        if (!m) continue;
        const verb = m[1];
        const argStr = m[2];
        const args = {};
        const re = /(\w+)=((?:"[^"]*"|'[^']*'|\[[^\]]*\]|\S+))/g;
        let match;
        while ((match = re.exec(argStr))  !==  null) {
            let val = match[2];
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith('\'') && val.endsWith('\''))) {
                val = val.slice(1, -1);
            }
            val = val.replace(/<[^>]*>/g, '');
            args[match[1]] = val;
        }
        cmds.push({ verb, args });
    }
    return cmds;
}

function processPacket(cmds){
    const pending = [];
    const actions = [];
    const state = CoreState.getState();
    const scene = new Set((state.sceneObjects || []).map(canon));
    const inv = {};
    for(const [name, ch] of Object.entries(state.characters || {})){
        inv[name] = new Set((ch.inventory || []).map(canon));
    }

    let stagedScene = new Set(scene);
    let stagedInv = new Map();
    for(const [name, set] of Object.entries(inv)){
        stagedInv.set(name, new Set([...set]));
    }
    const ensureInv = (n)=>{
        if(!stagedInv.has(n)) stagedInv.set(n, new Set());
    };

    for(const cmd of cmds){
        if(!cmd) continue;
        if(cmd.verb  ===  'newItem'){
            if(cmd.args.label){
                const id = canon(cmd.args.label);
                stagedScene.add(id);
                actions.push(()=>addSceneItem(id));
            }
        }else if(cmd.verb  ===  'addItem'){
            if(cmd.args.item){
                const id = canon(cmd.args.item);
                const target = cmd.args.target || personaName();
                const found = stagedScene.has(id);
                if(!found) pending.push({ id, raw: cmd.args.item });
                stagedScene.delete(id);
                ensureInv(target); stagedInv.get(target).add(id);
                actions.push(()=>{ removeSceneItem(id); CoreState.addItem(target,id); });
            }
        }else if(cmd.verb  ===  'moveItem'){
            if(cmd.args.item){
                const id = canon(cmd.args.item);
                const src = cmd.args.from || personaName();
                const dst = cmd.args.to || personaName();
                const sset = src.toLowerCase()  ===  'scene' ? stagedScene : (ensureInv(src), stagedInv.get(src));
                const dset = dst.toLowerCase()  ===  'scene' ? stagedScene : (ensureInv(dst), stagedInv.get(dst));
                if(!sset.delete(id)) pending.push({ id, raw: cmd.args.item });
                dset.add(id);
                actions.push(()=>{
                    if(src.toLowerCase()  ===  'scene') removeSceneItem(id); else CoreState.removeItem(src, id);
                    if(dst.toLowerCase()  ===  'scene') addSceneItem(id); else CoreState.addItem(dst, id);
                });
            }
        }else{
            actions.push(()=>handleCommand(cmd));
            if(cmd.verb  ===  'setScene'){
                stagedScene.clear();
                for(const it of parseItems(cmd.args.items)) stagedScene.add(canon(it));
            }else if(cmd.verb  ===  'removeItem'){
                if(cmd.args.item){
                    const target = cmd.args.target || personaName();
                    const id = canon(cmd.args.item);
                    if (target.toLowerCase()  ===  'scene') stagedScene.delete(id); else { ensureInv(target); stagedInv.get(target).delete(id); }
                }
            }else if(cmd.verb  ===  'consumeItem'){
                if(cmd.args.item){
                    const target = cmd.args.target || personaName();
                    const id = canon(cmd.args.item);
                    if (target.toLowerCase()  ===  'scene') stagedScene.delete(id); else {
                        ensureInv(target); if (!stagedInv.get(target).delete(id)) stagedScene.delete(id);
                    }
                }
            }else if(cmd.verb  ===  'dropItem'){
                if(cmd.args.item){
                    const target = cmd.args.target || personaName();
                    const id = canon(cmd.args.item);
                    ensureInv(target); stagedInv.get(target).delete(id); stagedScene.add(id);
                }
            }else if(cmd.verb  ===  'clearScene'){
                stagedScene.clear();
            }else if(cmd.verb  ===  'clearInv'){
                const target = cmd.args.target || personaName();
                ensureInv(target); stagedInv.get(target).clear();
            }
        }
    }
    console.log('[RV] STRICT', STRICT, 'pending', pending);
    if (STRICT && pending.length){
        assistantBubble(`*Unknown item: ${pending[0].raw}*`);
        return;
    }
    actions.forEach(fn=>fn());
}

function onMessage(id){
    const mes = chat?.[id];
    if(!mes || mes.is_user || mes.is_system) return;
    const raw = mes.mes_html ? stripHtml(mes.mes_html) : mes.mes || '';
    const lines = String(raw).split(/\r?\n/);
    if(!lines.length) return;
    const newLines = [];
    let found = false;
    for(const line of lines){
        const idx = line.indexOf('::');
        if(idx  !==  -1){
            let tail = line.slice(idx);
            let remainder = '';
            const closeIdx = tail.search(/<\/\w+>/);
            if(closeIdx  !==  -1){
                remainder = tail.slice(closeIdx).replace(/<[^>]*>/g, '');
                tail = tail.slice(0, closeIdx).trim();
            }else{
                tail = tail.trim();
            }
            const cmds = parseCommands(tail);
            if(cmds.length){
                processPacket(cmds);
                const head = line.slice(0, idx);
                const finalText = (head + remainder).trim();
                if(finalText) newLines.push(finalText);
                found = true;
                continue;
            }
        }
        newLines.push(line);
    }
    if(!found){
        commentBubble('[RuleVault] Missing control line \u2013 no mechanical changes processed.');
        return;
    }
    const newText = newLines.join('\n');
    mes.mes = newText;
    if('mes_html' in mes) mes.mes_html = newText;
}

async function runSmokeTest(){
    const events = { sceneUpdate:0, itemAdd:0, itemRemove:0 };
    const handlers = {
        sceneUpdate: () => events.sceneUpdate++,
        itemAdd: () => events.itemAdd++,
        itemRemove: () => events.itemRemove++,
    };
    for(const [ev,fn] of Object.entries(handlers)) window.addEventListener(ev, fn);

    let step = 0;
    const snap = () => ({ ...events });
    const delta = (before) => ({
        sceneUpdate: events.sceneUpdate - before.sceneUpdate,
        itemAdd: events.itemAdd - before.itemAdd,
        itemRemove: events.itemRemove - before.itemRemove,
    });
    try{
        step = 1;
        CoreState.clearState();
        let state = CoreState.getState();
        console.assert(!state.sceneObjects.length && Object.values(state.characters).every(c => !(c.inventory || []).length), 'state not empty after clear');
        if(state.sceneObjects.length || !Object.values(state.characters).every(c => !(c.inventory || []).length)) throw new Error('initial clear failed');

        step = 2;
        let before = snap();
        onMessage(chat.push({ is_user: false, mes: '::setScene items=[Apple]' }) - 1);
        state = CoreState.getState();
        console.assert(state.sceneObjects.length === 1 && state.sceneObjects[0] === 'apple', 'scene set');
        let d = delta(before);
        console.assert(d.sceneUpdate === 1 && d.itemAdd === 0 && d.itemRemove === 0, 'event count');
        if(!(state.sceneObjects.length === 1 && state.sceneObjects[0] === 'apple' && d.sceneUpdate === 1 && d.itemAdd === 0 && d.itemRemove === 0)) throw new Error('scene setup');

        step = 3;
        before = snap();
        onMessage(chat.push({ is_user: false, mes: `::addItem target=${personaName()} item=Apple` }) - 1);
        state = CoreState.getState();
        d = delta(before);
        console.assert(!state.sceneObjects.includes('apple') && state.characters[personaName()].inventory.includes('apple'), 'apple transfer');
        console.assert(d.sceneUpdate === 1 && d.itemAdd === 1 && d.itemRemove === 0, 'event count');
        if(state.sceneObjects.includes('apple') || !state.characters[personaName()].inventory.includes('apple') || d.sceneUpdate !== 1 || d.itemAdd !== 1 || d.itemRemove !== 0) throw new Error('addItem failed');

        step = 4;
        before = snap();
        onMessage(chat.push({ is_user: false, mes: `::dropItem target=${personaName()} item=Apple` }) - 1);
        state = CoreState.getState();
        d = delta(before);
        console.assert(state.sceneObjects.includes('apple') && !state.characters[personaName()].inventory.includes('apple'), 'drop');
        console.assert(d.sceneUpdate === 1 && d.itemAdd === 0 && d.itemRemove === 1, 'event count');
        if(!state.sceneObjects.includes('apple') || state.characters[personaName()].inventory.includes('apple') || d.sceneUpdate !== 1 || d.itemAdd !== 0 || d.itemRemove !== 1) throw new Error('dropItem failed');

        step = 5;
        before = snap();
        const preLen = chat.length;
        onMessage(chat.push({ is_user: false, mes: `::addItem target=${personaName()} item=FakeGem` }) - 1);
        state = CoreState.getState();
        d = delta(before);
        const last = chat[chat.length - 1];
        const bubble = chat.length === preLen + 1 && last?.extra?.type === system_message_types.ASSISTANT_MESSAGE;
        console.assert(!state.characters[personaName()].inventory.includes('fakegem') && bubble, 'strict block');
        console.assert(d.sceneUpdate === 0 && d.itemAdd === 0 && d.itemRemove === 0, 'event count');
        if(state.characters[personaName()].inventory.includes('fakegem') || !bubble || d.sceneUpdate !== 0 || d.itemAdd !== 0 || d.itemRemove !== 0) throw new Error('strict mode block');

        step = 6;
        STRICT = false;
        before = snap();
        onMessage(chat.push({ is_user: false, mes: `::addItem target=${personaName()} item=FakeGem` }) - 1);
        state = CoreState.getState();
        d = delta(before);
        console.assert(state.characters[personaName()].inventory.includes('fakegem'), 'strict off add');
        console.assert(d.sceneUpdate === 0 && d.itemAdd === 1 && d.itemRemove === 0, 'event count');
        if(!state.characters[personaName()].inventory.includes('fakegem') || d.sceneUpdate !== 0 || d.itemAdd !== 1 || d.itemRemove !== 0) throw new Error('strict off add');

        step = 7;
        before = snap();
        onMessage(chat.push({ is_user: false, mes: `::newItem label="Copper Ring" type=quest; addItem target=${personaName()} item=CopperRing` }) - 1);
        state = CoreState.getState();
        d = delta(before);
        console.assert(state.characters[personaName()].inventory.includes('copperring') && !state.sceneObjects.includes('copperring'), 'newItem add');
        console.assert(d.sceneUpdate === 1 && d.itemAdd === 1 && d.itemRemove === 0, 'event count');
        if(!state.characters[personaName()].inventory.includes('copperring') || state.sceneObjects.includes('copperring') || d.sceneUpdate !== 1 || d.itemAdd !== 1 || d.itemRemove !== 0) throw new Error('newItem add');

        step = 8;
        before = snap();
        onMessage(chat.push({ is_user: false, mes: '::setScene items=[Torch]' }) - 1);
        state = CoreState.getState();
        d = delta(before);
        console.assert(state.sceneObjects.length === 1 && state.sceneObjects[0] === 'torch' && !state.sceneObjects.includes('apple'), 'scene replace');
        console.assert(d.sceneUpdate === 1 && d.itemAdd === 0 && d.itemRemove === 0, 'event count');
        if(state.sceneObjects.length !== 1 || state.sceneObjects[0] !== 'torch' || state.sceneObjects.includes('apple') || d.sceneUpdate !== 1 || d.itemAdd !== 0 || d.itemRemove !== 0) throw new Error('setScene final');

        step = 9;
        assistantBubble('*RuleVault self-test: 9/9 checks passed ✔️*');
    }catch(err){
        const msg = step ? `FAILED at step ${step}: ${err.message}` : `aborted: ${err.message}`;
        assistantBubble(`*RuleVault self-test ${msg} ❌*`);
    }finally{
        for(const [ev,fn] of Object.entries(handlers)) window.removeEventListener(ev, fn);
        CoreState.clearState();
    }
    return '';
}

function init(){
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clearscene',
        callback: clearSceneSlash,
        helpString: 'Removes all items from the current scene.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rulevault-strict',
        callback: rulevaultStrictSlash,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'on | off',
                enumList: ['on', 'off'],
                forceEnum: true,
                isRequired: false,
            }),
        ],
        helpString: 'Toggle RuleVault strict mode or show current status.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clearinv',
        callback: clearInventorySlash,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'target',
                description: 'character name whose inventory will be cleared',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
                isRequired: false,
            }),
        ],
        helpString: 'Clears the inventory of the specified or current character.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rulevault-selftest',
        callback: runSmokeTest,
        helpString: 'Run the RuleVault self-test.',
    }));
}

if(document.readyState  !==  'loading') init();
else document.addEventListener('DOMContentLoaded', init, { once:true });

window.RuleVault = Object.assign(window.RuleVault || {}, {
    getStrict: () => STRICT,
});

export {};

/*  === == RuleVault smoke test  === ==
CoreState.clearState();
onMessage(chat.push({is_user:false,mes:"::newItem label=Rapier; addItem target=Player item=Rapier"})-1);
console.assert(CoreState.getState().characters[personaName()].inventory.includes('rapier'),'add');
*/
