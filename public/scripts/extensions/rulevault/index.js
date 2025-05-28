import { chat, eventSource, event_types } from '../../../script.js';
import * as CoreState from '../core-state/index.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import {
    ARGUMENT_TYPE,
    SlashCommandNamedArgument,
} from '../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { debounce } from '../../utils.js';

const STRICT = window.RuleVault?.strict === true || window.RuleVaultStrict === true;

function canon(id){
    return String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unknownItem(id){
    console.warn('[RuleVault] unknown item', id);
    if(STRICT && window.toastr) {
        toastr.error(`Unknown item: ${id}`, 'RuleVault');
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
    return inv.find(it => canon(it) === c);
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
    if(typeof CoreState.setScene === 'function'){
        CoreState.setScene(canonItems);
    }else if(typeof CoreState.updateSceneObjects === 'function'){
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
    const items = (state.sceneObjects || []).filter(it => canon(it) !== c);
    if(items.length !== (state.sceneObjects || []).length){
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
    if(!removeInventoryItem(target, id)){
        unknownItem(item);
        return;
    }
    addSceneItem(id);
    window.dispatchEvent(new CustomEvent('itemRemove', { detail:{ item: id } }));
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

function handleCommand(cmd){
    if(!cmd) return;
    if(cmd.verb === 'setScene'){
        const items = parseItems(cmd.args.items);
        coreSetScene(items);
    }else if(cmd.verb === 'addItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            const id = canon(cmd.args.item);
            if(!removeSceneItem(id)){
                unknownItem(cmd.args.item);
                return;
            }
            CoreState.addItem(target, id);
            window.dispatchEvent(new CustomEvent('itemAdd', { detail:{ item: id } }));
        }
    }else if(cmd.verb === 'removeItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            if(target.toLowerCase() === 'scene'){
                if(removeSceneItem(cmd.args.item)){
                    window.dispatchEvent(new CustomEvent('itemRemove', { detail:{ item: canon(cmd.args.item) } }));
                } else {
                    unknownItem(cmd.args.item);
                }
            }else{
                dropItem(target, cmd.args.item);
            }
        }
    }else if(cmd.verb === 'consumeItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            const id = canon(cmd.args.item);
            let removed = false;
            if(target.toLowerCase() === 'scene'){
                removed = removeSceneItem(id);
            } else {
                removed = removeInventoryItem(target, id);
                if(!removed){
                    removed = removeSceneItem(id);
                }
            }
            if(removed){
                window.dispatchEvent(new CustomEvent('itemRemove', { detail:{ item: id } }));
            } else {
                unknownItem(cmd.args.item);
            }
        }
    }else if(cmd.verb === 'modHP'){
        const target = cmd.args.target || personaName();
        const amount = parseInt(cmd.args.amount, 10) || 0;
        const reason = cmd.args.reason;
        CoreState.modHP(target, amount, reason);
    }else if(cmd.verb === 'modMP'){
        const target = cmd.args.target || personaName();
        const amount = parseInt(cmd.args.amount, 10) || 0;
        CoreState.modMP(target, amount);
    }else if(cmd.verb === 'dropItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            dropItem(target, cmd.args.item);
        }
    }else if(cmd.verb === 'clearScene'){
        coreSetScene([]);
    }else if(cmd.verb === 'clearInv'){
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
        while ((match = re.exec(argStr)) !== null) {
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

function onMessage(id){
    const mes = chat?.[id];
    if(!mes || mes.is_user) return;
    const raw = mes.mes_html ? stripHtml(mes.mes_html) : mes.mes || '';
    const lines = String(raw).split(/\r?\n/);
    if(!lines.length) return;
    const newLines = [];
    let found = false;
    for(const line of lines){
        const idx = line.indexOf('::');
        if(idx !== -1){
            let tail = line.slice(idx);
            let remainder = '';
            const closeIdx = tail.search(/<\/\w+>/);
            if(closeIdx !== -1){
                remainder = tail.slice(closeIdx).replace(/<[^>]*>/g, '');
                tail = tail.slice(0, closeIdx).trim();
            }else{
                tail = tail.trim();
            }
            const cmds = parseCommands(tail);
            if(cmds.length){
                cmds.forEach(handleCommand);
                const head = line.slice(0, idx);
                const finalText = (head + remainder).trim();
                if(finalText) newLines.push(finalText);
                found = true;
                continue;
            }
        }
        newLines.push(line);
    }
    if(!found) return;
    const newText = newLines.join('\n');
    mes.mes = newText;
    if('mes_html' in mes) mes.mes_html = newText;
}

function init(){
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clearscene',
        callback: clearSceneSlash,
        helpString: 'Removes all items from the current scene.',
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
}

if(document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init, { once:true });

export {};

/* ===== RuleVault smoke test =====
CoreState.clearState();
onMessage(chat.push({is_user:false,mes:"::setScene items=[Sword,Shield]"})-1);
console.assert(CoreState.getState().sceneObjects.includes('Sword'), 'scene set');
let fired=false;window.addEventListener('itemAdd',()=>fired=true,{once:true});
onMessage(chat.push({is_user:false,mes:"::addItem target=Player item=Sword"})-1);
console.assert(CoreState.getState().characters[personaName()].inventory.includes('Sword'),'add');
console.assert(fired,'event fired');
*/
