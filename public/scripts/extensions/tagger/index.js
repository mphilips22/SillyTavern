import * as CoreState from '../core-state/index.js';
import { eventSource, event_types } from '../../script.js';

console.log('[Tagger] extension loaded');

const sceneSet = new Set();
const invSet = new Set();

function labelFor(id) {
    const rules = window.RuleVault?.getRules?.();
    const staticMeta = rules?.items?.[id];
    const meta = window.RuleVault?.getItemMeta?.(id) || staticMeta;
    return meta?.label || id;
}

function typeFor(id) {
    const rules = window.RuleVault?.getRules?.();
    const staticMeta = rules?.items?.[id];
    const meta = window.RuleVault?.getItemMeta?.(id) || staticMeta;
    return meta?.type || 'misc';
}

function rebuildFromState() {
    if (!window.CoreState) return;
    const state = CoreState.getState(CoreState.playerName) || {};
    invSet.clear();
    (state.inventory || []).forEach(it => invSet.add(it));
    sceneSet.clear();
    (state.sceneObjects || []).forEach(it => sceneSet.add(it));
}

function recolor(id) {
    const locClass = invSet.has(id) ? 'inv' : 'scene';
    const typeClass = `type-${typeFor(id)}`;
    document.querySelectorAll(`.rpg-item[data-item-id="${id}"]`).forEach(sp => {
        sp.classList.toggle('inv', locClass === 'inv');
        sp.classList.toggle('scene', locClass === 'scene');
        sp.classList.forEach(c => { if (c.startsWith('type-')) sp.classList.remove(c); });
        sp.classList.add(typeClass);
    });
}

function handleSceneUpdate(e) {
    if (!e?.detail?.items) return;
    sceneSet.clear();
    e.detail.items.forEach(it => {
        sceneSet.add(it);
        recolor(it);
    });
    highlightAll();
}

function handleItemAdd(e) {
    if (e?.detail?.item) {
        invSet.add(e.detail.item);
        sceneSet.delete(e.detail.item);
        recolor(e.detail.item);
        highlightAll();
    }
}

function handleItemRemove(e) {
    if (e?.detail?.item) {
        invSet.delete(e.detail.item);
        recolor(e.detail.item);
        highlightAll();
    }
}

function handleStateReset() {
    rebuildFromState();
    highlightAll();
}

function getItems() {
    const ids = new Set([...sceneSet, ...invSet]);
    const arr = [...ids].map(id => ({
        id,
        label: labelFor(id),
        type: typeFor(id),
        location: invSet.has(id) ? 'inv' : 'scene',
    }));
    return arr.sort((a,b) => b.label.length - a.label.length);
}

const escapeRE = str => str.replace(/[.*+?^${}()|[\]\]/g, '\\$&');

function highlight(element) {
    if (!element) return;
    const items = getItems();
    if (!items.length) return;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const p = node.parentElement;
            if (p && p.closest('code, pre, .rpg-item')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach(node => {
        let html = node.nodeValue;
        items.forEach(it => {
            const re = new RegExp(`\\b${escapeRE(it.label)}\\b`, 'gi');
            html = html.replace(re, `<span class="rpg-item ${it.location} type-${it.type}" data-item-id="${it.id}">$&</span>`);
        });
        if (html !== node.nodeValue) {
            const tmp = document.createElement('span');
            tmp.innerHTML = html;
            node.replaceWith(...tmp.childNodes);
        }
    });
}

function highlightAll() {
    document.querySelectorAll('#chat .mes_text').forEach(el => highlight(el));
}

function onMessageRendered(id) {
    const el = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
    if (el) highlight(el);
}

function injectCss() {
    if (!document.getElementById('tagger-style')) {
        const link = document.createElement('link');
        link.id = 'tagger-style';
        link.rel = 'stylesheet';
        link.href = 'scripts/extensions/tagger/tagger.css';
        document.head.appendChild(link);
    }
}

function init() {
    injectCss();
    rebuildFromState();
    highlightAll();
    window.addEventListener('sceneUpdate', handleSceneUpdate);
    window.addEventListener('itemAdd', handleItemAdd);
    window.addEventListener('itemRemove', handleItemRemove);
    window.addEventListener('stateReset', handleStateReset);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    window.Tagger = {
        getCurrentSceneLabels: () => [...sceneSet].map(labelFor),
        highlight,
    };
}

if (document.readyState !== 'loading') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
}

/* Dev test (paste in console):
CoreState.clearState();
CoreState.setSceneObjects(["RustyShortsword","BreadLoaf"]);
addGM("You see a Rusty Shortsword and a bread loaf.");
CoreState.addItem(undefined,"RustyShortsword"); // sword span should turn green
*/
