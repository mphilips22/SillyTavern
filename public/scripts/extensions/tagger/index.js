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
        link.href = 'scripts/extensions/tagger/tagger.css';
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
    for(let n=walker.nextNode(); n; n=walker.nextNode()) nodes.push(n);
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

function autoBracket(el){
    if(!el) return;
    const state = CoreState.getState();
    const player = state.characters?.[CoreState.playerName] || {};
    const labels = [...new Set([...(state.sceneObjects||[]), ...(player.inventory||[])])]
        .filter(Boolean)
        .sort((a,b)=>b.length-a.length);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node){
            if(!node.nodeValue) return NodeFilter.FILTER_REJECT;
            if(node.parentElement.closest('.rpg-item, code, pre')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    for(let n=walker.nextNode(); n; n=walker.nextNode()){
        let txt = n.nodeValue;
        for(const label of labels){
            const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const spaced = label.replace(/([a-z])([A-Z])/g, '$1 $2');
            const spacedEsc = spaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const brk = new RegExp(`\\[\\s*${esc}\\s*\\]`, 'i');
            if (brk.test(txt)) continue;
            const re = new RegExp(`\\b(?:${esc}|${spacedEsc})\\b`, 'gi');
            txt = txt.replace(re, m => `[${m}]`);
        }
        if(txt !== n.nodeValue) n.nodeValue = txt;
    }
}

function recolorAll(){
    const { inv, scene } = setsFromState();
    document.querySelectorAll('#chat .rpg-item').forEach(sp => {
        sp.classList.remove('inv','scene','unknown');
        const id = sp.dataset.itemId;
        const inInv = inv.has(id);
        const inScene = scene.has(id);
        if(!inInv && !inScene){
            sp.classList.add('unknown');
            return;
        }
        sp.classList.add(inInv ? 'inv' : 'scene');
    });
}

function onMessageRendered(id){
    const mes = ctx.chat?.[id];
    if(!mes || mes.is_user) return;
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    autoBracket(el);
    tagElement(el);
    recolorAll();
}

function injectAssistant(text){
    const message = { name:'SelfTest', is_user:false, is_system:false, send_date:Date.now(), mes:String(text), extra:{ type: system_message_types.ASSISTANT_MESSAGE } };
    chat.push(message);
    const mid = chat.length - 1;
    eventSource.emit(event_types.MESSAGE_RECEIVED, mid, 'extension');
    addOneMessage(message);
    eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, mid, 'extension');
    ctx.saveChat?.();
    return mid;
}

function assistantBubble(text){
    injectAssistant(text);
}

async function runSelfTest(){
    // helper – paste near the top of runSelfTest
const setStrict = flag => {
  RuleVault.strict = !!flag;          // same field the slash-command toggles
};
    if(!settings.enabled) return '';
    const tick = () => new Promise(r => requestAnimationFrame(r));
    const events = { sceneUpdate:0, itemAdd:0, itemRemove:0, stateReset:0 };
    const handlers = {
        sceneUpdate: () => events.sceneUpdate++,
        itemAdd: () => events.itemAdd++,
        itemRemove: () => events.itemRemove++,
        stateReset: () => events.stateReset++,
    };
    for(const [ev,fn] of Object.entries(handlers)) window.addEventListener(ev, fn);

    const fails = [];
    let step = 1; let pass = 0;
    const snap = () => ({ ...events });
    const delta = b => ({ sceneUpdate: events.sceneUpdate - b.sceneUpdate, itemAdd: events.itemAdd - b.itemAdd, itemRemove: events.itemRemove - b.itemRemove });
    const assert = (cond, description) => {
        if (!cond) {
            console.error(`Tagger self-test step ${step} failed: ${description}`);
            fails.push(step);
        } else {
            pass++;
        }
        console.assert(cond, description);
    };

    try{
        CoreState.clearState();
        recolorAll();
        assert(
            [...document.querySelectorAll('#chat .rpg-item')].every(sp => sp.classList.contains('unknown')),
            'Existing items should be tagged unknown after state reset'
        );
        step++;

        let before = snap();
        CoreState.setScene([canon('Apple')]);
        let d = delta(before);
        assert(
            CoreState.getState().sceneObjects.includes(canon('Apple')) && d.sceneUpdate === 1,
            'Apple should be in scene and sceneUpdate event fired'
        );
        step++;

        const id1 = injectAssistant('On the table lies [Apple].');
        await tick(); // lets Tagger wrap and recolour before assertions run
        const sp1 = document.querySelector(`#chat [mesid="${id1}"] .rpg-item`);
        assert(
            sp1 && sp1.classList.contains('scene'),
            'First apple should be tagged as scene'
        );
        step++;

        before = snap();
        CoreState.addItem(undefined, canon('Apple'));
        d = delta(before);
        recolorAll();
        assert(
            sp1.classList.contains('inv') && d.itemAdd === 1,
            'Item should move to inventory and itemAdd event fired'
        );
        step++;

        const id2 = injectAssistant('You stash [apple] safely.');
        await tick(); // lets Tagger wrap and recolour before assertions run
        const sp2 = document.querySelector(`#chat [mesid="${id2}"] .rpg-item`);
        assert(
            sp2 && sp2.classList.contains('inv'),
            'Second apple should be tagged as inv'
        );
        step++;

        before = snap();
        CoreState.removeItem(undefined, canon('Apple'));
        CoreState.setScene([canon('Apple')]);
        d = delta(before);
        recolorAll();
        const allScene = [sp1, sp2].every(sp => sp.classList.contains('scene'));
        assert(
            allScene && d.sceneUpdate === 1 && d.itemRemove === 1,
            'Apples should be scene items after removal with events fired'
        );
        step++;

        /* 8 – strict ON: unknown item should stay .unknown */
        setStrict(true);
        CoreState.setScene([]);                         // clear scene
        const fgId1 = injectAssistant('You notice [FakeGem] on a shelf.');
        await tick();
        const fgStrict = document.querySelector(`#chat [mesid="${fgId1}"] .rpg-item[data-item-id="${canon('FakeGem')}"]`);
        assert(fgStrict && fgStrict.classList.contains('unknown'), 'FakeGem should be unknown in strict mode');
        step++;

        /* 9 – strict OFF: same item auto-mints to .scene */
        setStrict(false);
        CoreState.setScene([canon('FakeGem')]);
        const fgId2 = injectAssistant('The [FakeGem] glitters faintly.');
        await tick();
        const fgLoose = document.querySelector(`#chat [mesid="${fgId2}"] .rpg-item.scene[data-item-id="${canon('FakeGem')}"]`);
        assert(fgLoose, 'FakeGem should be coloured scene once strict is off');
        step++;

        /* 10 – stateReset recolours to unknown */
        CoreState.clearState();
        await tick();
        const allUnknown = [...document.querySelectorAll('.rpg-item')].every(s=>s.classList.contains('unknown'));
        assert(allUnknown, 'All items should turn unknown after reset');
        step++;

        /* 11 – canonical match with junk spacing/case */
        CoreState.setScene([canon('Apple')]);
        injectAssistant('Night falls over the [ APPLE ] again.');
        await tick();
        const weirdApple = document.querySelector('.rpg-item.scene[data-item-id="'+canon('Apple')+'"]');
        assert(weirdApple, 'Bracketed label with spaces/case maps to Apple');
        step++;

        /* 12 – no double-wrap on re-run */
        const beforeCount = document.querySelectorAll('.rpg-item[data-item-id="'+canon('Apple')+'"]').length;
        injectAssistant('You see another [Apple].');
        await tick();
        const after = document.querySelectorAll('.rpg-item[data-item-id="'+canon('Apple')+'"]').length;
        assert(after === beforeCount + 1, 'Exactly one new span added (no nesting)');
        step++;

        assert(
            fails.length === 0,
            'No test steps should have failed'
        );
    }catch(err){
        console.error(err);
        fails.push(step);
    }finally{
        for(const [ev,fn] of Object.entries(handlers)) window.removeEventListener(ev, fn);
    }

    assistantBubble(`*Tagger self-test: ${pass} / 12 checks passed${fails.length ? ' — failed: '+fails.join(', ') : ' ✔️'}*`);
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
    new MutationObserver(muts=>{
        muts.forEach(m=>{
            m.addedNodes.forEach(node=>{
                if(node.nodeType!==1) return;
                if(!node.classList?.contains('mes')) return;
                if(node.getAttribute('is_user')==='true') return;
                const tgt=node.querySelector('.mes_text')||node;
                autoBracket(tgt);
                tagElement(tgt);
                recolorAll();
            });
        });
    }).observe(document.body,{childList:true,subtree:true});
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
