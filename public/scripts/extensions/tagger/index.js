/* global RuleVault */
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

const ADJ_STOP = ['warm','old','shiny','ancient','rusty','broken','cold','small','large'];
const STOP_SINGLE = ['a','the','you','to','of','in','on','it'];

function stripAdj(text){
    const parts = text.trim().split(/\s+/);
    while(parts.length && ADJ_STOP.includes(parts[0])) parts.shift();
    return parts.join(' ');
}

// eslint-disable-next-line no-unused-vars
function tokeniseID(id){
    return String(id || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

function camelToDisplay(id){
    const txt = String(id || '')
        .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
        .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
    return txt.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseItems(str){
    if(!str) return [];
    const clean = str.replace(/^\[|\]$/g,'');
    return clean.split(',').map(s=>s.trim()).filter(Boolean);
}

function parseCommands(line){
    if(!line.startsWith('::')) return [];
    const raw = line.slice(2).trim();
    const parts = raw.split(';').map(p=>p.trim()).filter(Boolean);
    const cmds = [];
    for(const part of parts){
        const m = /^(\w+)\s*(.*)$/.exec(part);
        if(!m) continue;
        const verb = m[1];
        const argStr = m[2];
        const args = {};
        const re = /(\w+)=((?:"[^"]*"|'[^']*'|\[[^\]]*\]|\S+))/g;
        let match;
        while((match = re.exec(argStr)) !== null){
            let val = match[2];
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            val = val.replace(/<[^>]*>/g,'');
            args[match[1]] = val;
        }
        cmds.push({ verb, args });
    }
    return cmds;
}

function buildAliasMap(sceneIds = []){
    const map = {};
    for(const raw of sceneIds){
        const id = canon(raw);
        const display = camelToDisplay(raw);
        if(!display) continue;
        const phrase = display.toLowerCase();
        const tokens = phrase.split(/\s+/);
        const last = tokens[tokens.length - 1];
        map[phrase] = id;
        map[phrase.replace(/\s+/g,'')] = id;
        if(last.length >= 4 && !STOP_SINGLE.includes(last) && !map[last]) {
            map[last] = id;
        }
        map[id.toLowerCase()] = id;
    }
    return map;
}

function* ngramSpans(text, max = 3){
    const words = [];
    const re = /\b\w+\b/g;
    let m;
    while((m = re.exec(text))){
        words.push({ word:m[0], index:m.index });
    }
    for(let i = 0;i < words.length;i++){
        for(let n = 1;n <= max && i + n - 1 < words.length;n++){
            const start = words[i].index;
            const endWord = words[i + n - 1];
            const end = endWord.index + endWord.word.length;
            yield { start,end,text:text.slice(start,end) };
        }
    }
}

function distance(a,b){
    if(a === b) return { dist:0,ratio:1 };
    const la = a.length, lb = b.length;
    const dp = new Array(la + 1);
    for(let i = 0;i <= la;i++){dp[i] = new Array(lb + 1);dp[i][0] = i;}
    for(let j = 1;j <= lb;j++) dp[0][j] = j;
    for(let i = 1;i <= la;i++){
        for(let j = 1;j <= lb;j++){
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    const dist = dp[la][lb];
    const ratio = 1 - dist / Math.max(la,lb);
    return { dist,ratio };
}

let aliasMap = {};
let cachedSynonyms = {};
let aliasMapReady = false;

function cacheSyn(id, phrase){
    cachedSynonyms[phrase] = id;
    aliasMap[phrase] = id;
}

function refreshAliasMap(){
    aliasMap = buildAliasMap(CoreState.getState().sceneObjects || []);
    aliasMap = Object.assign({}, aliasMap, cachedSynonyms);
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
    for(let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach(tagTextNode);
}

function fuzzyHighlightElement(el){
    if(!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node){
            if(!node.nodeValue) return NodeFilter.FILTER_REJECT;
            if(node.parentElement.closest('.rpg-item, code, pre')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const done = new Set();
    for(let node = walker.nextNode(); node;){
        const text = node.nodeValue;
        const spans = [...ngramSpans(text)];
        let replaced = false;
        for(const span of spans){
            let clean = stripAdj(span.text.toLowerCase());
            if(!clean) continue;
            const tokens = clean.split(/\s+/);
            const isSingle = tokens.length === 1;
            if(isSingle){
                const token = tokens[0];
                if(token.length < 4) continue;
                if(STOP_SINGLE.includes(token)) continue;
            }
            let id = aliasMap[clean] || aliasMap[clean.replace(/\s+/g,'')];
            if(id && done.has(id)) continue;
            if(id){
                // exact match, no fuzzy check needed
            }else if(!isSingle){
                for(const [alias,aid] of Object.entries(aliasMap)){
                    if(done.has(aid)) continue;
                    const { dist,ratio } = distance(clean, alias);
                    if(dist <= 2 || ratio >= 0.9){
                        id = aid;
                        cacheSyn(aid, clean);
                        break;
                    }
                }
            }
            if(id){
                const frag = document.createDocumentFragment();
                frag.appendChild(document.createTextNode(text.slice(0, span.start)));
                const sp = document.createElement('span');
                sp.className = 'rpg-item scene';
                sp.dataset.itemId = id;
                sp.textContent = text.slice(span.start, span.end);
                frag.appendChild(sp);
                const after = document.createTextNode(text.slice(span.end));
                frag.appendChild(after);
                node.replaceWith(frag);
                done.add(id);
                walker.currentNode = after;
                node = after;
                replaced = true;
                break;
            }
        }
        if(!replaced){
            node = walker.nextNode();
        }
    }
}

function highlightAll(){
    document.querySelectorAll('#chat .mes_text').forEach(el => {
        autoBracket(el);
        tagElement(el);
        fuzzyHighlightElement(el);
    });
}

function reScanMessage(root){
    if(!root || root.__taggerRescanned) return;
    root.__taggerRescanned = true;
    const el = root.querySelector('.mes_text') || root;
    autoBracket(el);
    tagElement(el);
    fuzzyHighlightElement(el);
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
    const labels = [...new Set([...(state.sceneObjects || []), ...(player.inventory || [])])]
        .filter(Boolean)
        .sort((a,b)=>b.length - a.length);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node){
            if(!node.nodeValue) return NodeFilter.FILTER_REJECT;
            if(node.parentElement.closest('.rpg-item, code, pre')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    for(let n = walker.nextNode(); n; n = walker.nextNode()){
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
    fuzzyHighlightElement(el);
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
            'Existing items should be tagged unknown after state reset',
        );
        step++;

        let before = snap();
        CoreState.setScene([canon('Apple')]);
        let d = delta(before);
        assert(
            CoreState.getState().sceneObjects.includes(canon('Apple')) && d.sceneUpdate === 1,
            'Apple should be in scene and sceneUpdate event fired',
        );
        step++;

        const id1 = injectAssistant('On the table lies [Apple].');
        await tick(); // lets Tagger wrap and recolour before assertions run
        const sp1 = document.querySelector(`#chat [mesid="${id1}"] .rpg-item`);
        assert(
            sp1 && sp1.classList.contains('scene'),
            'First apple should be tagged as scene',
        );
        step++;

        before = snap();
        CoreState.addItem(undefined, canon('Apple'));
        d = delta(before);
        recolorAll();
        assert(
            sp1.classList.contains('inv') && d.itemAdd === 1,
            'Item should move to inventory and itemAdd event fired',
        );
        step++;

        const id2 = injectAssistant('You stash [apple] safely.');
        await tick(); // lets Tagger wrap and recolour before assertions run
        const sp2 = document.querySelector(`#chat [mesid="${id2}"] .rpg-item`);
        assert(
            sp2 && sp2.classList.contains('inv'),
            'Second apple should be tagged as inv',
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
            'Apples should be scene items after removal with events fired',
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
        const weirdApple = document.querySelector('.rpg-item.scene[data-item-id="' + canon('Apple') + '"]');
        assert(weirdApple, 'Bracketed label with spaces/case maps to Apple');
        step++;

        /* 12 – no double-wrap on re-run */
        const beforeCount = document.querySelectorAll('.rpg-item[data-item-id="' + canon('Apple') + '"]').length;
        injectAssistant('You see another [Apple].');
        await tick();
        const after = document.querySelectorAll('.rpg-item[data-item-id="' + canon('Apple') + '"]').length;
        assert(after === beforeCount + 1, 'Exactly one new span added (no nesting)');
        step++;

        /* 13 – fuzzy phrase match */
        CoreState.setScene([canon('SkullMug')]);
        injectAssistant('You lift a warm skull mug from the shelf.');
        await tick();
        const skull = document.querySelector('.rpg-item.scene[data-item-id="' + canon('SkullMug') + '"]');
        assert(skull, 'Fuzzy phrase should map to SkullMug');
        step++;

        /* 14 – natural-name phrase match */
        CoreState.setScene([canon('CookingPot'), canon('WeatheredCrate')]);
        injectAssistant('You lift the cooking pot and set it by the weathered crate.');
        await tick();
        const pot = document.querySelector('.rpg-item.scene[data-item-id="' + canon('CookingPot') + '"]');
        const crate = document.querySelector('.rpg-item.scene[data-item-id="' + canon('WeatheredCrate') + '"]');
        assert(pot && crate, 'Natural phrases should map to CookingPot and WeatheredCrate');
        step++;

        /* 15 – stop-words filtered */
        CoreState.setScene([canon('CookingPot'), canon('WoodenTable')]);
        const base = document.querySelectorAll('.rpg-item').length;
        injectAssistant('A battered cooking pot sits on the wooden table.');
        await tick();
        const afterAll = document.querySelectorAll('.rpg-item').length;
        assert(afterAll === base + 2, 'Cooking pot & wooden table highlighted; "A" ignored');
        step++;

        assert(
            fails.length === 0,
            'No test steps should have failed',
        );
    }catch(err){
        console.error(err);
        fails.push(step);
    }finally{
        for(const [ev,fn] of Object.entries(handlers)) window.removeEventListener(ev, fn);
    }

    assistantBubble(`*Tagger self-test: ${pass} / 15 checks passed${fails.length ? ' — failed: ' + fails.join(', ') : ' ✔️'}*`);
    return '';
}

(function init(){
    if(!settings.enabled) return;
    injectCss();
    refreshAliasMap();
    highlightAll();
    recolorAll();
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    window.addEventListener('sceneUpdate', () => { refreshAliasMap(); recolorAll(); });
    window.addEventListener('itemAdd', recolorAll);
    window.addEventListener('itemRemove', recolorAll);
    window.addEventListener('stateReset', () => { cachedSynonyms = {}; refreshAliasMap(); recolorAll(); });
    new MutationObserver(muts=>{
        muts.forEach(m=>{
            m.addedNodes.forEach(node=>{
                if(node.nodeType !== 1) return;
                if(!node.classList?.contains('mes')) return;
                if(node.getAttribute('is_user') === 'true') return;
                const tgt = node.querySelector('.mes_text') || node;
                const hidden = [...tgt.querySelectorAll('div[style]')]
                    .filter(el => el.style.display === 'none')
                    .map(n => n.textContent.trim())
                    .find(t => /^::\s*setScene/i.test(t));
                if(hidden){
                    const cmds = parseCommands(hidden);
                    const scene = cmds.find(c => c.verb === 'setScene');
                    if(scene){
                        const items = parseItems(scene.args.items || scene.args.item)
                            .map(canon);
                        aliasMap = buildAliasMap(items);
                        aliasMap = Object.assign({}, aliasMap, cachedSynonyms);
                        aliasMapReady = true;
                        reScanMessage(node);
                        return;
                    }
                }
                if(!aliasMapReady) return;
                setTimeout(() => {
                    autoBracket(tgt);
                    tagElement(tgt);
                    fuzzyHighlightElement(tgt);
                    recolorAll();
                }, 0);
            });
        });
    }).observe(document.body,{ childList:true,subtree:true });
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
