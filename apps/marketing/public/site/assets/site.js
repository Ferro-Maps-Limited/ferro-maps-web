(()=>{const b=document.querySelector('.menu-btn'),m=document.getElementById('site-menu');if(b){const set=o=>{b.setAttribute('aria-expanded',o);b.setAttribute('aria-label',o?'Close menu':'Open menu');document.body.classList.toggle('menu-open',o)};b.onclick=()=>set(b.getAttribute('aria-expanded')!=='true');document.addEventListener('keydown',e=>{if(e.key==='Escape')set(false)});m.querySelectorAll('a').forEach(a=>a.onclick=()=>set(false))}
const f=document.getElementById('jobs-form');if(f)f.onsubmit=e=>{e.preventDefault();if(!f.checkValidity()){f.reportValidity();return}f.querySelector('.ok').hidden=false;f.querySelector('button').disabled=true}})();
(()=>{const IOS='https://apps.apple.com/gb/app/ferromaps/id6783352319',AND='https://play.google.com/store/apps/details?id=com.ferromaps.android&hl=en_GB';
const ua=navigator.userAgent,ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1),and=/Android/i.test(ua);
const d=document.getElementById('dl-dialog');
const go=e=>{if(e)e.preventDefault();if(ios)location.href=IOS;else if(and)location.href=AND;else if(d&&d.showModal){d.showModal();d.querySelector('.dl-opts a').focus()}else location.hash='download'};
window.ferroDownload=go;
document.querySelectorAll('[data-dl]').forEach(a=>{if(ios)a.href=IOS;else if(and)a.href=AND;a.addEventListener('click',go)});
if(d)d.addEventListener('click',e=>{if(e.target===d)d.close()});
document.querySelectorAll('.phone').forEach(p=>{p.setAttribute('role','link');p.tabIndex=0;p.setAttribute('aria-label','Download Ferro Maps');p.classList.add('tap-dl');
let x=0,y=0,moved=false;p.addEventListener('pointerdown',e=>{x=e.clientX;y=e.clientY;moved=false});
p.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-x)>10||Math.abs(e.clientY-y)>10)moved=true});
p.addEventListener('click',e=>{if(moved){moved=false;return}go(e)});
p.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')go(e)})});
const tr=document.querySelector('.carousel');if(tr){let sx=0;tr.addEventListener('scroll',()=>tr.querySelectorAll('.phone').forEach(p=>p.dataset.s=1),{passive:true})}})();
(()=>{const f=document.getElementById('contact-form');if(!f)return;f.addEventListener('submit',e=>{e.preventDefault();if(!f.checkValidity()){f.reportValidity();return}const d=new FormData(f);const body=`${d.get('message')}\n\n${d.get('name')} (${d.get('email')})`;location.href='mailto:support@ferromaps.com?subject='+encodeURIComponent('Website message from '+d.get('name'))+'&body='+encodeURIComponent(body)})})();
