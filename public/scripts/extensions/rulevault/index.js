import { chat, eventSource, event_types } from '../../../script.js';
import * as CoreState from '../core-state/index.js';

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

function coreSetScene(items){
    if(typeof CoreState.setScene === 'function'){
        CoreState.setScene(items);
    }else if(typeof CoreState.updateSceneObjects === 'function'){
        CoreState.updateSceneObjects(items);
    }else{
        const ctx = SillyTavern?.getContext?.() ?? {};
        const chatId = ctx.chat?.id || 'default';
        const key = `st.rpg.coreState.v1::${chatId}`;
        const state = CoreState.getState();
        state.sceneObjects = items;
        try{ localStorage.setItem(key, JSON.stringify(state)); }catch(err){ console.error('[RuleVault] save failed', err); }
    }
    window.dispatchEvent(new CustomEvent('sceneUpdate', { detail:{ items } }));
}

function removeSceneItem(item){
    const state = CoreState.getState();
    const items = (state.sceneObjects || []).filter(it => it !== item);
    if(items.length !== (state.sceneObjects || []).length){
        coreSetScene(items);
    }
}

function handleCommand(cmd){
    if(!cmd) return;
    if(cmd.verb === 'setScene'){
        const items = parseItems(cmd.args.items);
        coreSetScene(items);
    }else if(cmd.verb === 'addItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            CoreState.addItem(target, cmd.args.item);
            if(target === personaName()) removeSceneItem(cmd.args.item);
            window.dispatchEvent(new CustomEvent('itemAdd', { detail:{ item: cmd.args.item } }));
        }
    }else if(cmd.verb === 'removeItem'){
        if(cmd.args.item){
            const target = cmd.args.target || personaName();
            if(target.toLowerCase() === 'scene'){
                removeSceneItem(cmd.args.item);
            }else{
                CoreState.removeItem(target, cmd.args.item);
            }
            window.dispatchEvent(new CustomEvent('itemRemove', { detail:{ item: cmd.args.item } }));
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
            args[match[1]] = val;
        }
        cmds.push({ verb, args });
    }
    return cmds;
}

function onMessage(id){
    const mes = chat?.[id];
    if(!mes || mes.is_user) return;
    const lines = String(mes.mes || '').split(/\r?\n/);
    if(!lines.length) return;
    let idx = lines.length - 1;
    let last = lines[idx].trim();
    while(idx > 0 && last === ''){
        lines.pop();
        idx = lines.length - 1;
        last = lines[idx]?.trim();
    }
    if(!last || !last.startsWith('::')) return;
    const cmds = parseCommands(last);
    lines.pop();
    const newText = lines.join('\n');
    mes.mes = newText;
    if ('mes_html' in mes) mes.mes_html = newText;
    cmds.forEach(cmd => handleCommand(cmd));
}

function init(){
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
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
