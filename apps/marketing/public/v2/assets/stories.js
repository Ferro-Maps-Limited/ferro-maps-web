(async()=>{const box=document.getElementById('stories'),em=document.getElementById('stories-empty');let s=[];try{const r=await fetch('assets/stories.json',{cache:'no-cache'});s=((await r.json()).stories||[])}catch(e){}
const esc=t=>String(t||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
s.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
if(!s.length){em.hidden=false;document.querySelector('.share').hidden=true;return}
box.innerHTML=s.map(x=>`<figure class="story${x.example?' example':''}">${x.example?'<span class="tag">Example placeholder</span>':''}<blockquote>“${esc(x.quote)}”</blockquote><figcaption>${x.photo?`<img src="${esc(x.photo)}" alt="" width="52" height="52" loading="lazy">`:`<span class="av">${esc((x.name||'?')[0])}</span>`}<span><b>${esc(x.name)}</b><small>${esc(x.area)}${x.date?' · '+esc(new Date(x.date).toLocaleDateString('en-GB',{month:'short',year:'numeric'})):''}</small></span></figcaption></figure>`).join('')})();
