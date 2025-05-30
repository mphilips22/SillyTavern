import { chat, addOneMessage, eventSource, event_types, system_message_types } from '../../../script.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import * as CoreState from '../core-state/index.js';

let pendingAF = 0; // requestAnimationFrame debounce id

const inject = window.SillyTavern?.injectAssistant
            || window.ST?.injectAssistant
            || ((html, opts = {}) => {
                 const ctx = window.SillyTavern?.getContext?.() ?? {};
                 const chatArr = ctx.chat || window.chat;
                 if (!Array.isArray(chatArr)) return;
                 const message = {
                   name: opts.name || 'SelfTest',
                   is_user: false,
                   is_system: false,
                   send_date: Date.now(),
                   mes: String(html),
                   extra: { type: system_message_types.ASSISTANT_MESSAGE },
                 };
                 chatArr.push(message);
                 const mid = chatArr.length - 1;
                 eventSource.emit(event_types.MESSAGE_RECEIVED, mid, 'extension');
                 addOneMessage(message);
                 eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, mid, 'extension');
                 ctx.saveChat?.();
                 return mid;
               });

(function(){
    const ctx = globalThis.SillyTavern?.getContext?.() ?? {};
    ctx.extensionSettings ??= {};
    ctx.extensionSettings.features ??= {};
    ctx.extensionSettings.features.sceneguard ??= { enabled: true };
    const settings = ctx.extensionSettings.features.sceneguard;
    let lastHadScene = true;
    let missCount = 0;
    let errorNode = null;

    function canon(id){
        return String(id || '').toLowerCase().replace(/[^a-z0-9]/g,'');
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
                if((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))){
                    val = val.slice(1,-1);
                }
                val = val.replace(/<[^>]*>/g,'');
                args[match[1]] = val;
            }
            cmds.push({ verb, args });
        }
        return cmds;
    }

    function removeHiddenLines(msg){
        const raw = msg.mes || '';
        const lines = String(raw).split(/\r?\n/).filter(l => !l.trim().startsWith('::'));
        const clean = lines.join('\n');
        msg.mes = clean;
        if('mes_html' in msg) msg.mes_html = clean;
    }

    function removeWarn(){
        document.querySelectorAll('.sceneguard-warn').forEach(el => el.remove());
        errorNode = null;
    }

 function showWarn(id, text){
    let messageEl = document.querySelector(`#chat [mesid="${id}"] .mes_text`)
                 || document.querySelector(`#chat [mesid="${id}"]`)
                 || document.querySelector('#chat');   // ← fallback for SelfTest

    if (!messageEl) return;   // final guard
    removeWarn();
    const span = document.createElement('span');
    span.className = 'system-bubble sceneguard-warn';
    span.textContent = text;
    messageEl.insertAdjacentElement('afterend', span);
    errorNode = span;
}

    function processNode(node){
        const id = node?.getAttribute('mesid');
        if(!id) return;
        const msg = ctx.chat?.[id];
        if(!msg || msg.is_user || msg.is_system) return;
        const hiddenNodes = [...node.querySelectorAll('div[style*="display:none"]')];
        const hasCtrl = hiddenNodes.some(d => /::\s*setScene/i.test(d.textContent));
        const hidden = hiddenNodes.map(n=>n.textContent.trim()).reverse().find(t => /::\s*setScene/i.test(t));
        let foundScene = false;
        let missing = [];
        if(hidden){
            const cmds = parseCommands(hidden);
            const scene = cmds.find(c=>c.verb==='setScene');
            if(scene){
                foundScene = true;
                const items = parseItems(scene.args.items);
                const clone = node.cloneNode(true);
                hiddenNodes.forEach(n=>{
                    const target = clone.querySelector('div[style*="display:none"]');
                    if(target) target.remove();
                });
                const search = stripHtml(clone.innerHTML);
                for(const it of items){
                    const esc = it.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
                    const re = new RegExp(`\\[\\s*${esc}\\s*\\]`,`i`);
                    if(!re.test(search)) missing.push(it);
                }
            }
        }
        if(!foundScene && hasCtrl){
            foundScene = true;
        }
        msg.__sceneGuardError = null;
        const isValid = foundScene && missing.length === 0;
        if(isValid){
            missCount = 0;
            removeWarn();
        }else{
            missCount++;
            if(foundScene && missing.length){
                msg.__sceneGuardError = `⚠ Missing brackets for: ${missing.join(', ')}`;
                removeHiddenLines(msg);
            }else if(missCount >= 2){
                msg.__sceneGuardError = '⚠ Scene list stale — resend with setScene.';
                removeHiddenLines(msg);
            }
            if(msg.__sceneGuardError) showWarn(id, msg.__sceneGuardError); else removeWarn();
        }
        lastHadScene = foundScene;
    }

    function onRendered(id){
        const msg = ctx.chat?.[id];
        if(!msg || msg.is_user || msg.is_system) return;
        if(msg.__sceneGuardError){
            showWarn(id, msg.__sceneGuardError);
        }else{
            removeWarn();
        }
    }

    async function runSelfTest(){
        if(!settings.enabled) return '';
        const tick = () => new Promise(r => requestAnimationFrame(r));
        const fails = [];
        let pass = 0;
        const assert = (cond, step) => {
            console.assert(cond, 'step ' + step);
            if(!cond) fails.push(step); else pass++;
        };

        const sendTurn = (hidden, visible) => {
            inject(
                `<div style="display:none">${hidden}</div>${visible}`,
                { name: 'SelfTest', italic: true }
            );
        };
removeWarn();   // wipe any leftover ⚠ bubble
missCount = 0;  // start the streak from scratch
        CoreState.clearState();
        await tick();
        assert(!document.querySelector('.sceneguard-warn'), 1);

        sendTurn('::setScene item=Torch', 'You spot a [Torch] on the wall.');
        await tick();
        await tick();
        assert(!document.querySelector('.sceneguard-warn'), 2);

        inject('The corridor is dusty.', { name: 'SelfTest', italic: true });
        await tick();
        await tick();
        assert(!document.querySelector('.sceneguard-warn'), 3);

        inject('A rat scurries past.', { name: 'SelfTest', italic: true });
        await tick();
        await tick();
        assert(document.querySelectorAll('.sceneguard-warn').length === 1, 4);

        sendTurn('::setScene item=Rat', 'A [Rat] bares its teeth.');
        await tick();
        await tick();
        assert(document.querySelectorAll('.sceneguard-warn').length === 0, 5);

        const text = fails.length
            ? `*SceneGuard self-test failed: ${fails.join(',')} ❌*`
            : `*SceneGuard self-test: ${pass} / 5 checks passed ✔️*`;
        inject(text, { name: 'SelfTest', italic: true });
        return '';
    }

    function init(){
        eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onRendered);
        const chatBox = document.getElementById('chat');
        window.addEventListener('stateReset', () => { missCount = 0; removeWarn(); });
        if(chatBox){
            new MutationObserver(muts => {
                muts.forEach(m => {
                    m.addedNodes.forEach(node => {
                        if (node.nodeType !== 1) return;
                        if (!node.classList.contains('mes')) return;
                        cancelAnimationFrame(pendingAF);
                        pendingAF = requestAnimationFrame(() => {
                            processNode(node);
                        });
                    });
                });
            }).observe(chatBox, { childList: true });
        }
    }

    if(document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });

    if(settings.enabled){
        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sceneguard-selftest',
                callback: runSelfTest,
                helpString: 'Run the SceneGuard self-test.',
            })
        );
    }
})();
