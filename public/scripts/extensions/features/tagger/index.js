import { chat, addOneMessage, eventSource, event_types, system_message_types } from '../../../script.js';
import * as CoreState from '../core-state/index.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';

const ctx = globalThis.SillyTavern?.getContext?.() ?? {};
ctx.extensionSettings ??= {};
ctx.extensionSettings.features ??= {};
ctx.extensionSettings.features.tagger ??= { enabled: true };
const settings = ctx.extensionSettings.features.tagger;

function canon(label){
    return window.RuleVault?.canon?.(label) ?? String(label || '').toLowerCase().replace(/[^a-z0-9]/g,'');
}

function injectCss(){
    if(!document.getElementById('tagger-style')){
        const link = document.createElement('link');
        link.id = 'tagger-style';
        link.rel = 'stylesheet';
        link.href = 'scripts/extensions/features/tagger/tagger.css';
        document.head.appendChild(link);
    }
}

function tagTextNode(node){
    const text = node.nodeValue;
    const re = /\[([^\]]+)\]/g;
    let last = 0;
    const frag = document.createDocumentFragment();
    let m;
    while((m = re.exec(text))){
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = document.createElement('span');
        span.className = 'rpg-item scene';
        span.dataset.itemId = canon(m[1]);
        span.textContent = m[1];
        frag.appendChild(span);
        last = re.lastIndex;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
}

function tagElement(el){
    if(!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node){
            if(!node.nodeValue || !node.nodeValue.includes('[')) return NodeFilter.FILTER_REJECT;
            if(node.parentElement.closest('.rpg-item, code, pre')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach(tagTextNode);
}

function highlightAll(){
    document.querySelectorAll('#chat .mes_text').forEach(tagElement);
}

function setsFromState(){
    const state = CoreState.getState();
    const player = state.characters?.[CoreState.playerName] || {};
    const inv = new Set((player.inventory || []).map(canon));
    const scene = new Set((state.sceneObjects || []).map(canon));
    return { inv, scene };
}

function recolorAll(){
    const { inv, scene } = setsFromState();
    document.querySelectorAll('#chat .rpg-item').forEach(sp => {
        const id = sp.dataset.itemId;
        const inInv = inv.has(id);
        const inScene = scene.has(id);
        sp.classList.toggle('inv', inInv);
        sp.classList.toggle('scene', !inInv && inScene);
        sp.classList.toggle('unknown', !inInv && !inScene);
    });
}

function onMessageRendered(id){
    const mes = ctx.chat?.[id];
    if(!mes || mes.is_user) return;
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    tagElement(el);
    recolorAll();
}

async function injectAssistant(text){
    const message = { name:'SelfTest', is_user:false, is_system:false, send_date:Date.now(), mes:String(text), extra:{ type: system_message_types.ASSISTANT_MESSAGE } };
    chat.push(message);
    const mid = chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, mid, 'extension');
    addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, mid, 'extension');
    if (ctx.saveChat) await ctx.saveChat();
    return mid;
}

function assistantBubble(text){
    injectAssistant(text);
}

async function runSelfTest(){
    if(!settings.enabled) return '';
    const events = { sceneUpdate:0, itemAdd:0, itemRemove:0 };
    const handlers = {
        sceneUpdate: () => events.sceneUpdate++,
        itemAdd: () => events.itemAdd++,
        itemRemove: () => events.itemRemove++,
    };
    for(const [ev,fn] of Object.entries(handlers)) window.addEventListener(ev, fn);

    const fails = [];
    let step = 1; let pass = 0;
    const snap = () => ({ ...events });
    const delta = b => ({ sceneUpdate: events.sceneUpdate - b.sceneUpdate, itemAdd: events.itemAdd - b.itemAdd, itemRemove: events.itemRemove - b.itemRemove });
    const assert = cond => { console.assert(cond); if(cond) pass++; else fails.push(step); };

    try{
        CoreState.clearState();
        recolorAll();
        assert([...document.querySelectorAll('#chat .rpg-item')].every(sp => sp.classList.contains('unknown')));
        step++;

        let before = snap();
        CoreState.setScene([canon('Apple')]);
        let d = delta(before);
        assert(CoreState.getState().sceneObjects.includes(canon('Apple')) && d.sceneUpdate === 1);
        step++;

        const id1 = await injectAssistant('On the table lies [Apple].');
        await new Promise(r => requestAnimationFrame(r));
        const sp1 = document.querySelector(`#chat [mesid="${id1}"] .rpg-item`);
        assert(sp1 && sp1.classList.contains('scene'));
        step++;

        before = snap();
        CoreState.addItem(undefined, canon('Apple'));
        d = delta(before);
        recolorAll();
        assert(sp1.classList.contains('inv') && d.itemAdd === 1);
        step++;

        const id2 = await injectAssistant('You stash [apple] safely.');
        await new Promise(r => requestAnimationFrame(r));
        const sp2 = document.querySelector(`#chat [mesid="${id2}"] .rpg-item`);
        assert(sp2 && sp2.classList.contains('inv'));
        step++;

        before = snap();
        CoreState.removeItem(undefined, canon('Apple'));
        CoreState.setScene([canon('Apple')]);
        d = delta(before);
        recolorAll();
        const allScene = [sp1, sp2].every(sp => sp.classList.contains('scene'));
        assert(allScene && d.sceneUpdate === 1 && d.itemRemove === 1);
        step++;

        assert(fails.length === 0);
    }catch(err){
        console.error(err);
        fails.push(step);
    }finally{
        for(const [ev,fn] of Object.entries(handlers)) window.removeEventListener(ev, fn);
    }

    const msg = fails.length ? `failed at step(s) ${fails.join(', ')}` : `${pass} / 7 checks passed ✔️`;
    assistantBubble(`*Tagger self-test: ${msg}*`);
    return '';
}

(function init(){
    if(!settings.enabled) return;
    injectCss();
    highlightAll();
    recolorAll();
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    window.addEventListener('sceneUpdate', recolorAll);
    window.addEventListener('itemAdd', recolorAll);
    window.addEventListener('itemRemove', recolorAll);
    window.addEventListener('stateReset', recolorAll);
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name:'tagger-selftest',
        callback: runSelfTest,
        helpString:'Run the Tagger self-test.',
    }));
})();

export {};

/* Dev smoke test (manual)
CoreState.clearState();
CoreState.setScene(['Torch']);
SillyTavern.injectAssistant('There is a [Torch] here.');
// => span .scene then run CoreState.modHP etc...
*/
