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

function handleCommand(cmd){
    if(!cmd) return;
    if(cmd.verb === 'setScene'){
        const items = parseItems(cmd.args.items);
        coreSetScene(items);
    }else if(cmd.verb === 'addItem'){
        if(cmd.args.item){
            CoreState.addItem(personaName(), cmd.args.item);
            window.dispatchEvent(new CustomEvent('itemAdd', { detail:{ item: cmd.args.item } }));
        }
    }else if(cmd.verb === 'removeItem'){
        if(cmd.args.item){
            CoreState.removeItem(personaName(), cmd.args.item);
            window.dispatchEvent(new CustomEvent('itemRemove', { detail:{ item: cmd.args.item } }));
        }
    }
}

function parseControl(line) {
    if (!line.startsWith('::')) return null;
    const m = /^::(\w+)\s*(.*)$/.exec(line.trim());
    if (!m) return null;
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
    return { verb, args };
}

function onMessage(id){
    const mes = chat?.[id];
    if(!mes || mes.is_user) return;
    const lines = String(mes.mes || '').split(/\r?\n/);
    if(!lines.length) return;
    const last = lines[lines.length - 1].trim();
    if(!last.startsWith('::')) return;
    const cmd = parseControl(last);
    lines.pop();
    const newText = lines.join('\n');
    mes.mes = newText;
    if ('mes_html' in mes) mes.mes_html = newText;
    handleCommand(cmd);
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
