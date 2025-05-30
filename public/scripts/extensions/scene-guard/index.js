import { chat, eventSource, event_types } from '../../../script.js';

(function(){
    const ctx = globalThis.SillyTavern?.getContext?.() ?? {};
    let lastHadScene = true;
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

    function showError(id, text){
        const messageEl = document.querySelector(`#chat [mesid="${id}"] .mes_text`);
        if(!messageEl) return;
        clearError();
        const span = document.createElement('span');
        span.className = 'system-bubble error';
        span.textContent = text;
        messageEl.insertAdjacentElement('afterend', span);
        errorNode = span;
    }

    function clearError(){
        if(errorNode){
            errorNode.remove();
            errorNode = null;
        }
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
        if(!foundScene && !lastHadScene){
            msg.__sceneGuardError = '⚠ Scene list stale — resend with setScene.';
            removeHiddenLines(msg);
        }else if(foundScene && missing.length){
            msg.__sceneGuardError = `⚠ Missing brackets for: ${missing.join(', ')}`;
            removeHiddenLines(msg);
        }
        if(msg.__sceneGuardError) showError(id, msg.__sceneGuardError); else clearError();
        lastHadScene = foundScene;
    }

    function onMessage(id){
        const msg = ctx.chat?.[id];
        if(!msg || msg.is_user || msg.is_system) return;
        const raw = msg.mes_html ? stripHtml(msg.mes_html) : msg.mes || '';
        const lines = String(raw).split(/\r?\n/);
        let hidden = null;
        for(let i=lines.length-1;i>=0;i--){
            const l = lines[i].trim();
            if(l.startsWith('::')){ hidden = l; break; }
        }
        let foundScene = false;
        let missing = [];
        if(hidden){
            const cmds = parseCommands(hidden);
            const scene = cmds.find(c=>c.verb==='setScene');
            if(scene){
                foundScene = true;
                const items = parseItems(scene.args.items);
                const textPart = lines.filter(l => l.trim()!==hidden.trim()).join('\n');
                const search = stripHtml(textPart);
                for(const it of items){
                    const esc = it.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
                    const re = new RegExp(`\\[\\s*${esc}\\s*\\]`,`i`);
                    if(!re.test(search)) missing.push(it);
                }
            }
        }
        msg.__sceneGuardError = null;
        if(!foundScene && !lastHadScene){
            msg.__sceneGuardError = '⚠ Scene list stale — resend with setScene.';
            removeHiddenLines(msg);
        }else if(foundScene && missing.length){
            msg.__sceneGuardError = `⚠ Missing brackets for: ${missing.join(', ')}`;
            removeHiddenLines(msg);
        }
        lastHadScene = foundScene;
    }

    function onRendered(id){
        const msg = ctx.chat?.[id];
        if(!msg || msg.is_user || msg.is_system) return;
        if(msg.__sceneGuardError){
            showError(id, msg.__sceneGuardError);
        }else{
            clearError();
        }
    }

    function init(){
        eventSource.makeFirst(event_types.MESSAGE_RECEIVED, onMessage);
        eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onRendered);
        const chatBox = document.getElementById('chat');
        if(chatBox){
            new MutationObserver(muts=>{
                setTimeout(()=>{
                    muts.forEach(m=>{
                        m.addedNodes.forEach(node=>{
                            if(node.nodeType!==1) return;
                            if(!node.classList.contains('mes')) return;
                            processNode(node);
                        });
                    });
                },0);
            }).observe(chatBox,{childList:true});
        }
    }

    if(document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
