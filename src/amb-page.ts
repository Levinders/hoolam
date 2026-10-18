import { ICON } from './icons.js';

/**
 * The ambassador's private dashboard (go.hoolam.com/ambassador). One page: signing in (their WhatsApp number, then a
 * 6-digit code sent to that WhatsApp), then everything from /ambassador/api/me: any month's earnings with the maths
 * behind every naira, a 12-month chart, their people, their link (copy, QR code, a picture to share), their photo,
 * term and payout account, and the rules in plain words. Never in search results.
 * Brand: deep teal #0E5C63, muted gold #C9992E, green only for good news, off-white #FAFAF7.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function ambassadorPage(o: { markUrl: string | null; waNumber?: string | null }): string {
  const brand = `${o.markUrl ? `<img class="mark-img" src="${esc(o.markUrl)}" alt="">` : ICON.mark}<span>Hoolam</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Ambassador dashboard · Hoolam</title>
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="same-origin">
<meta name="theme-color" content="#0E5C63">
<link rel="icon" href="${esc(o.markUrl ?? '/favicon.svg')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{--teal:#0E5C63;--teal-d:#0A4146;--gold:#C9992E;--gold-50:#FBF4E3;--gold-ink:#7A5A10;--green:#2E8B57;--green-50:#E7F4EC;--red:#B4442E;--red-50:#FBECE8;--bg:#FAFAF7;--ink:#17292b;--muted:#5d6b6c;--faint:#8a9696;--line:#e6e8e3;--card:#fff;--teal-50:#EAF3F3}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font:15px/1.5 Inter,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh}
button,input,select{font:inherit;color:inherit}
a{color:var(--teal)}
.ic{display:block;flex:none}
.wrap{width:100%;max-width:560px;margin:0 auto;padding:12px 16px 40px}
header.top{display:flex;align-items:center;justify-content:space-between;height:52px;margin-bottom:8px}
.brand{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:var(--teal);font:600 18px Poppins,Inter,sans-serif;letter-spacing:-.01em}
.mark-img{width:30px;height:30px;border-radius:9px;object-fit:contain}
.brand small{font:600 12px Inter,sans-serif;color:var(--gold-ink);background:var(--gold-50);padding:3px 8px;border-radius:999px;margin-left:2px}
.icon-btn[disabled]{opacity:.4;cursor:default}
.icon-btn{width:44px;height:44px;border-radius:14px;border:1px solid var(--line);background:#fff;display:grid;place-items:center;cursor:pointer;color:var(--ink)}
.icon-btn .ic{width:20px;height:20px}
.menu{position:relative}
.menu-pop{position:absolute;right:0;top:50px;z-index:20;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 40px -20px rgba(10,65,70,.45);padding:6px;min-width:230px;display:none}
.menu-pop.open{display:block}
.menu-pop button{display:flex;width:100%;text-align:left;gap:10px;align-items:center;padding:11px 12px;border:0;background:none;border-radius:10px;cursor:pointer;font-weight:500}
.menu-pop button:hover{background:var(--teal-50)}
.menu-pop .ic{width:18px;height:18px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:0 1px 2px rgba(10,65,70,.04),0 18px 40px -30px rgba(14,92,99,.45);margin-top:14px;overflow:hidden}
.pad{padding:18px}
h2{font:600 17px Poppins,Inter,sans-serif;letter-spacing:-.01em}
.lede{color:var(--muted);font-size:13.5px;margin-top:2px}
.hero .cover{height:84px;background:radial-gradient(120% 140% at 85% -20%,rgba(201,153,46,.45),transparent 55%),linear-gradient(135deg,#12737b,var(--teal) 55%,var(--teal-d))}
.hero .who{padding:0 18px 18px;margin-top:-46px;display:flex;flex-direction:column;gap:4px}
.avatar{width:92px;height:92px;border-radius:50%;background:var(--teal-50);box-shadow:0 0 0 4px #fff,0 0 0 6px var(--gold);overflow:hidden;display:grid;place-items:center;font:700 34px Poppins,Inter;color:var(--teal)}
.avatar img{width:100%;height:100%;object-fit:cover}
.hello{font:700 24px/1.2 Poppins,Inter,sans-serif;letter-spacing:-.02em;margin-top:10px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:999px;width:max-content}
.pill.ACTIVE{background:var(--green-50);color:var(--green)}.pill.PAUSED{background:var(--gold-50);color:var(--gold-ink)}.pill.ENDED{background:#EEF0EE;color:var(--muted)}
.linkrow{display:flex;gap:8px;align-items:center;margin-top:12px;background:var(--teal-50);border-radius:14px;padding:6px 6px 6px 12px}
.linkrow b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--teal);font-weight:600}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;border-radius:13px;border:0;font-weight:600;cursor:pointer;text-decoration:none;transition:background .2s,transform .1s}
.btn:active{transform:scale(.98)}
.btn .ic{width:18px;height:18px}
.btn.main{background:var(--teal);color:#fff}.btn.main:hover{background:var(--teal-d)}
.btn.gold{background:var(--gold);color:#1f1a0e}
.btn.soft{background:#fff;border:1px solid var(--line);color:var(--ink)}.btn.soft:hover{background:#FCFCFA}
.btn.danger{background:var(--red-50);color:var(--red)}
.btn.sm{min-height:36px;padding:0 12px;border-radius:10px;font-size:13.5px}
.btn.wide{width:100%}
.btn[disabled]{opacity:.55;cursor:default}
.monthbar{display:flex;align-items:center;gap:8px;margin-top:18px}
.monthbar select{flex:1;height:44px;border:1px solid var(--line);border-radius:13px;background:#fff;padding:0 12px;font-weight:600;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 18px) 19px,calc(100% - 13px) 19px;background-size:5px 5px;background-repeat:no-repeat;text-align:center}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.tile{background:#fff;border:1px solid var(--line);border-radius:18px;padding:14px}
.tile small{display:block;color:var(--muted);font-size:12.5px;font-weight:500}
.tile b{display:block;font:700 22px/1.2 Poppins,Inter,sans-serif;letter-spacing:-.01em;margin-top:4px}
.tile span{display:block;color:var(--faint);font-size:12px;margin-top:2px}
.tile.big{grid-column:1/-1;background:linear-gradient(135deg,#12737b,var(--teal) 60%,var(--teal-d));border:0;color:#fff}
.tile.big small{color:rgba(255,255,255,.75)}.tile.big b{font-size:32px}.tile.big span{color:rgba(255,255,255,.7)}
.chart{display:flex;align-items:flex-end;gap:6px;height:130px;padding:6px 2px 0}
.bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;border:0;background:none;padding:0;height:100%;justify-content:flex-end}
.bar i{display:block;width:100%;max-width:28px;border-radius:7px 7px 4px 4px;background:#D3E6E7;min-height:4px;transition:background .2s}
.bar span{font-size:11px;color:var(--faint);font-weight:600}
.bar.on i{background:var(--gold)}.bar.on span{color:var(--ink)}
.bar:hover i{background:#B7D6D8}.bar.on:hover i{background:var(--gold)}
.split{display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid var(--line)}
.split div{padding:12px 18px;border-bottom:1px solid var(--line)}
.split div:nth-child(odd){border-right:1px solid var(--line)}
.split small{display:block;color:var(--muted);font-size:12.5px}.split b{font-weight:700}
.list{list-style:none;padding:0}
.list li{display:flex;gap:12px;align-items:flex-start;padding:13px 18px;border-top:1px solid var(--line)}
.list .dot{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;flex:none;background:var(--teal-50);color:var(--teal)}
.list .dot.gold{background:var(--gold-50);color:#9C7520}.list .dot.green{background:var(--green-50);color:var(--green)}
.list .dot .ic{width:18px;height:18px}
.list .main{flex:1;min-width:0}
.list .main b{display:block;font-weight:600;line-height:1.3}
.list .main small{display:block;color:var(--muted);font-size:12.5px;line-height:1.4;margin-top:2px}
.list .amt{font-weight:700;white-space:nowrap;text-align:right}
.list .amt small{display:block;font-weight:600;font-size:11.5px;color:var(--faint)}
.tag{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 7px;border-radius:999px;margin-top:4px}
.tag.held{background:var(--gold-50);color:var(--gold-ink)}.tag.void{background:#EEF0EE;color:var(--muted)}.tag.paid{background:var(--green-50);color:var(--green)}.tag.due{background:var(--teal-50);color:var(--teal)}
.empty{padding:18px;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
.seg{display:flex;background:var(--teal-50);border-radius:13px;padding:4px;margin:12px 18px 6px}
.seg button{flex:1;border:0;background:none;height:36px;border-radius:10px;font-weight:600;color:var(--muted);cursor:pointer}
.seg button.on{background:#fff;color:var(--teal);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.prog{height:6px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:6px;max-width:200px}
.prog i{display:block;height:100%;background:var(--gold);border-radius:99px}
.share-img{width:100%;border-radius:16px;border:1px solid var(--line);display:block;margin-top:12px;aspect-ratio:1/1;object-fit:cover;background:var(--teal-50)}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.btns .btn{flex:1 1 140px}
.row{display:flex;gap:12px;align-items:center;padding:14px 18px;border-top:1px solid var(--line)}
.row .txt{flex:1;min-width:0}
.row .txt b{display:block;font-weight:600}
.row .txt small{display:block;color:var(--muted);font-size:12.5px}
.row select{height:36px;border:1px solid var(--line);border-radius:10px;background:#fff;padding:0 8px;font-weight:600}
.rules{list-style:none;padding:0 18px 16px;display:flex;flex-direction:column;gap:10px;font-size:14px}
.rules li{display:flex;gap:10px}
.rules .ic{width:18px;height:18px;color:var(--teal);margin-top:2px}
.rules li.warn .ic{color:var(--red)}
.note{font-size:12.5px;color:var(--muted);padding:12px 18px;background:#FCFCFA;border-top:1px solid var(--line)}
/* sign in */
.signin{max-width:420px;margin:6vh auto 0}
.signin h1{font:700 26px/1.2 Poppins,Inter,sans-serif;letter-spacing:-.02em;margin-top:18px}
.signin p{color:var(--muted);margin-top:6px}
.field{margin-top:18px}
.field label{display:block;font-weight:600;font-size:13.5px;margin-bottom:6px}
.field input{width:100%;height:52px;border:1px solid #d5dad4;border-radius:14px;padding:0 14px;font-size:17px;background:#fff}
.field input:focus,.monthbar select:focus,.row select:focus{outline:3px solid rgba(201,153,46,.35);border-color:var(--gold)}
.field input.code{letter-spacing:.5em;text-align:center;font-weight:700;font-size:22px}
.err{color:var(--red);font-size:13.5px;margin-top:10px;min-height:1px}
.ok{color:var(--green);font-size:13.5px;margin-top:10px}
.small-link{background:none;border:0;color:var(--teal);font-weight:600;cursor:pointer;padding:8px 0;margin-top:8px}
.lock{display:flex;gap:8px;color:var(--muted);font-size:12.5px;margin-top:18px;align-items:flex-start}
.lock .ic{width:16px;height:16px;margin-top:2px}
.toast{position:fixed;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%) translateY(20px);background:var(--ink);color:#fff;padding:12px 16px;border-radius:14px;font-weight:600;font-size:14px;opacity:0;transition:all .25s;pointer-events:none;z-index:40;max-width:calc(100% - 32px)}
.toast.show{opacity:1;transform:translateX(-50%)}
dialog{border:0;border-radius:22px;padding:22px;max-width:380px;width:calc(100% - 32px);box-shadow:0 30px 80px -20px rgba(0,0,0,.45)}
dialog::backdrop{background:rgba(8,30,32,.55)}
dialog h3{font:600 18px Poppins,Inter,sans-serif}
dialog p{color:var(--muted);margin-top:8px;font-size:14px}
dialog .btns{margin-top:18px}
.skel{background:linear-gradient(90deg,#eef0ec,#f6f7f4,#eef0ec);background-size:200% 100%;animation:sh 1.2s infinite;border-radius:18px}
@keyframes sh{to{background-position:-200% 0}}
footer{margin-top:26px;text-align:center;color:var(--muted);font-size:12.5px}
:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:360px){.tile b{font-size:19px}.tile.big b{font-size:28px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="wrap">
<header class="top"><span class="brand">${brand}<small>Ambassador</small></span><div class="menu" id="menu" hidden>
  <button class="icon-btn" id="menu-btn" type="button" aria-label="Account menu" aria-expanded="false">${ICON.user}</button>
  <div class="menu-pop" id="menu-pop" role="menu">
    <button type="button" role="menuitem" data-act="signout">${ICON.logOut}Sign out on this device</button>
    <button type="button" role="menuitem" data-act="signout-all">${ICON.shieldCheck}Sign out everywhere</button>
  </div></div></header>
<main id="app"><div class="skel" style="height:220px;margin-top:14px"></div><div class="skel" style="height:120px;margin-top:14px"></div></main>
<footer>Hoolam · Pay safe. Ship safe.<br>Questions? Talk to a rep from the WhatsApp menu.</footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<dialog id="dlg"><h3 id="dlg-t"></h3><p id="dlg-p"></p><div class="btns"><button class="btn soft" type="button" id="dlg-no">Cancel</button><button class="btn danger" type="button" id="dlg-yes">Yes</button></div></dialog>
<script>
(function(){
var I=${JSON.stringify({ left: ICON.chevronLeft, right: ICON.chevronRight, check: ICON.check, wallet: ICON.wallet, gift: ICON.gift, users: ICON.users, shield: ICON.shieldCheck, info: ICON.info, whatsapp: ICON.whatsapp, store: ICON.store, bag: ICON.shoppingBag })};
var WA=${JSON.stringify((o.waNumber ?? '').replace(/\D/g, ''))};
var app=document.getElementById('app'),toastEl=document.getElementById('toast'),D=null,tab='sellers',month=new URLSearchParams(location.search).get('m')||'';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function naira(k){var n=Math.round(Number(k||0))/100;return '\\u20A6'+n.toLocaleString('en-NG',{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2})}
function day(s){if(!s)return '';var d=new Date(String(s).length===10?s+'T12:00:00Z':s);return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Lagos'})}
function short(s){var d=new Date(s);return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'Africa/Lagos'})}
function mlabel(k){return new Date(k+'-15T12:00:00Z').toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'})}
function toast(t){toastEl.textContent=t;toastEl.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(function(){toastEl.classList.remove('show')},2600)}
function api(path,opt){opt=opt||{};var h={'x-hoolam':'1'};if(opt.json){h['content-type']='application/json'}if(opt.type){h['content-type']=opt.type}
  return fetch('/ambassador/api/'+path,{method:opt.method||'GET',headers:h,body:opt.json?JSON.stringify(opt.json):opt.body,credentials:'same-origin'}).then(function(r){
    var ct=r.headers.get('content-type')||'';return (ct.indexOf('json')>=0?r.json():Promise.resolve({})).then(function(j){if(!r.ok){var e=new Error(j.error||'Something went wrong. Please try again.');e.status=r.status;e.j=j;throw e}return j})})}
function confirmBox(t,p,yes){var d=document.getElementById('dlg');document.getElementById('dlg-t').textContent=t;document.getElementById('dlg-p').textContent=p;var y=document.getElementById('dlg-yes');y.textContent=yes;
  return new Promise(function(res){y.onclick=function(){d.close();res(true)};document.getElementById('dlg-no').onclick=function(){d.close();res(false)};d.showModal()})}

// ---------- sign in ----------
function signin(step,phone,msg){
  document.getElementById('menu').hidden=true;
  var codeStep=step==='code';
  app.innerHTML='<section class="signin"><span class="avatar" style="width:64px;height:64px;font-size:26px">'+I.shield+'</span><h1>'+(codeStep?'Enter your code':'Your ambassador dashboard')+'</h1>'+
   '<p>'+(codeStep?'We sent a 6-digit code to your WhatsApp ('+esc(phone)+'). It works for 10 minutes.':'Sign in with the WhatsApp number you use with Hoolam. We send a code to that WhatsApp: no password needed.')+'</p>'+
   '<form id="f" novalidate>'+(codeStep
     ?'<div class="field"><label for="code">6-digit code</label><input class="code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required></div>'
     :'<div class="field"><label for="phone">WhatsApp number</label><input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="08031234567" value="'+esc(phone||'')+'" required></div>')+
   '<div class="err" id="err" role="alert">'+esc(msg||'')+'</div><button class="btn main wide" style="margin-top:14px;min-height:52px" id="go">'+(codeStep?'Sign in':'Send me a code')+'</button></form>'+
   (codeStep?'<button class="small-link" id="back" type="button">Use another number, or send a new code</button>':'')+
   '<p class="lock">'+I.shield+'<span>Only the person with this WhatsApp can sign in. We message you each time someone signs in on a new device.</span></p></section>';
  var f=document.getElementById('f'),err=document.getElementById('err'),go=document.getElementById('go');
  var inp=document.getElementById(codeStep?'code':'phone');inp.focus();
  if(codeStep){inp.addEventListener('input',function(){inp.value=inp.value.replace(/\\D/g,'').slice(0,6);if(inp.value.length===6)f.requestSubmit()});document.getElementById('back').onclick=function(){signin('phone',phone)}}
  f.onsubmit=function(e){e.preventDefault();err.textContent='';go.disabled=true;
    var p=codeStep?api('verify',{method:'POST',json:{phone:phone,code:inp.value}}):api('code',{method:'POST',json:{phone:inp.value}});
    p.then(function(){if(codeStep){load()}else{signin('code',inp.value)}}).catch(function(x){go.disabled=false;err.innerHTML=esc(x.message)+(x.j&&x.j.needsHi&&WA?' <a href="https://wa.me/'+WA+'?text=hi" target="_blank" rel="noopener">Open WhatsApp</a>':'')})}
}

// ---------- the dashboard ----------
function load(m){
  if(m)month=m;
  return api('me'+(month?'?m='+encodeURIComponent(month):'')).then(function(d){D=d;month=d.month;try{history.replaceState(null,'','/ambassador?m='+d.month)}catch(e){}render()}).catch(function(x){if(x.status===401)signin('phone');else app.innerHTML='<div class="card pad"><p>'+esc(x.message)+'</p><button class="btn main" style="margin-top:12px" onclick="location.reload()">Try again</button></div>'})
}
function render(){
  var d=D,s=d.summary,t=d.totals;
  document.getElementById('menu').hidden=false;
  var first=d.firstName||'there';
  var initial=(first[0]||'H').toUpperCase();
  var status={ACTIVE:'Active',PAUSED:'Paused',ENDED:'Ended',SETUP:'Setting up'}[d.status]||d.status;
  var idx=d.months.indexOf(d.month);
  var max=Math.max.apply(null,d.chart.map(function(c){return c.amountMinor}).concat([1]));
  var h='';
  // hero
  h+='<section class="card hero"><div class="cover" aria-hidden="true"></div><div class="who"><span class="avatar">'+(d.photo?'<img src="'+esc(d.photo)+'" alt="">':esc(initial))+'</span>'+
     '<div class="hello">Hi '+esc(first)+'</div><span class="pill '+esc(d.status)+'">'+esc(status)+(d.status==='ACTIVE'&&d.area?' · '+esc(d.area):'')+'</span>'+
     (d.status==='PAUSED'?'<p class="lede">Paused for now: new orders don\\'t earn. What you earned is still paid.</p>':'')+
     (d.status==='ENDED'?'<p class="lede">Your term ended on '+day(d.endedAt)+'. Everything you earned is paid to you.</p>':'')+
     (d.link&&d.status!=='ENDED'?'<div class="linkrow"><b>'+esc(d.linkText)+'</b><button class="btn soft sm" data-copy="'+esc(d.link)+'">Copy link</button></div>':'')+
     '</div></section>';
  // month switcher + tiles
  h+='<div class="monthbar"><button class="icon-btn" data-m="'+esc(d.months[idx+1]||'')+'" '+(d.months[idx+1]?'':'disabled')+' aria-label="Earlier month">'+I.left+'</button>'+
     '<label class="sr" for="msel">Month</label><select id="msel">'+d.months.map(function(k){return '<option value="'+k+'"'+(k===d.month?' selected':'')+'>'+mlabel(k)+'</option>'}).join('')+'</select>'+
     '<button class="icon-btn" data-m="'+esc(d.months[idx-1]||'')+'" '+(idx>0?'':'disabled')+' aria-label="Later month">'+I.right+'</button></div>';
  h+='<div class="tiles"><div class="tile big"><small>Earned in '+esc(d.monthLabel)+'</small><b>'+naira(s.earned)+'</b><span>'+s.orders+' order'+(s.orders===1?'':'s')+' · '+s.activeSellers+' active seller'+(s.activeSellers===1?'':'s')+(s.held?' · '+naira(s.held)+' on hold':'')+'</span></div>'+
     '<div class="tile"><small>Paid so far</small><b>'+naira(t.paidMinor)+'</b><span>All time: '+naira(t.allTimeMinor)+'</span></div>'+
     (d.status==='ENDED'
       ?'<div class="tile"><small>Still to pay</small><b>'+naira(t.owedMinor)+'</b><span>Paid whatever the amount</span></div>'
       :'<div class="tile"><small>Next payout · '+day(d.next.date)+'</small><b>'+naira(t.owedMinor)+'</b><span>'+(d.next.belowMin?'Paid from '+naira(d.next.minMinor)+'; the rest waits':'For earnings up to last month')+'</span></div>')+
     (t.pendingMinor?'<div class="tile" style="grid-column:1/-1"><small>On the way</small><b>'+naira(t.pendingMinor)+'</b><span>From '+t.pendingOrders+' order'+(t.pendingOrders===1?'':'s')+' in progress. They count once each order is complete.</span></div>':'')+
     '</div>';
  // chart
  h+='<section class="card pad"><h2>Last 12 months</h2><p class="lede">Tap a month to see it.</p><div class="chart" role="group" aria-label="Earnings by month">'+d.chart.map(function(c){
       var pct=Math.max(3,Math.round(100*c.amountMinor/max));var on=c.month===d.month;var ok=d.months.indexOf(c.month)>=0;
       return '<button class="bar'+(on?' on':'')+'" '+(ok?'data-m="'+c.month+'"':'disabled')+' aria-label="'+mlabel(c.month)+': '+naira(c.amountMinor)+'"><i style="height:'+pct+'%"></i><span>'+mlabel(c.month).slice(0,1)+'</span></button>'}).join('')+'</div></section>';
  // breakdown + lines
  h+='<section class="card"><div class="pad"><h2>'+esc(d.monthLabel)+', every naira</h2><p class="lede">Your share is worked out from what Hoolam earned on each completed order.</p></div>'+
     '<div class="split"><div><small>From sellers</small><b>'+naira(s.fromSellers)+'</b></div><div><small>From buyers</small><b>'+naira(s.fromBuyers)+'</b></div><div><small>Seller bonuses</small><b>'+naira(s.bonuses)+'</b></div><div><small>New people</small><b>'+(s.newSellers+s.newBuyers)+'</b></div></div>'+
     (d.lines.length?'<ul class="list">'+d.lines.map(function(l){
        var bonus=l.kind==='BONUS';
        var maths=bonus?d.bonus.orders+'-order seller bonus':(l.percent)+'% of '+naira(l.revenueMinor)+' Hoolam earned';
        var tag=l.status==='HELD'?'<span class="tag held">On hold: '+esc(l.holdReason)+'</span>':l.status==='VOID'?'<span class="tag void">Cancelled after review</span>':l.paid?'<span class="tag paid">Paid</span>':'';
        return '<li><span class="dot '+(bonus?'gold':l.side==='SELLER'?'':'green')+'">'+(bonus?I.gift:l.side==='SELLER'?I.store:I.bag)+'</span><span class="main"><b>'+esc(l.who)+'</b><small>'+short(l.at)+' · '+esc(l.code)+' · '+(l.side==='SELLER'?'seller':'buyer')+'<br>'+esc(maths)+'</small>'+tag+'</span><span class="amt">'+naira(l.amountMinor)+'</span></li>'}).join('')+'</ul>'
      :'<p class="empty">No earnings in '+esc(d.monthLabel)+' yet. They show here as soon as an order from your people is complete.</p>')+
     '</section>';
  // people
  var ppl=tab==='sellers'?d.people.sellers:d.people.buyers;
  h+='<section class="card"><div class="pad" style="padding-bottom:0"><h2>Your people</h2><p class="lede">'+d.people.sellers.length+' seller'+(d.people.sellers.length===1?'':'s')+' ('+d.people.activeSellers+' active) · '+d.people.buyers.length+' buyer'+(d.people.buyers.length===1?'':'s')+' · '+d.taps+' link tap'+(d.taps===1?'':'s')+'</p></div>'+
     '<div class="seg" role="tablist"><button role="tab" data-tab="sellers" class="'+(tab==='sellers'?'on':'')+'">Sellers</button><button role="tab" data-tab="buyers" class="'+(tab==='buyers'?'on':'')+'">Buyers</button></div>'+
     (ppl.length?'<ul class="list">'+ppl.map(function(p){
        var sub=p.orders+' completed order'+(p.orders===1?'':'s')+' · '+(p.active?'active':'not active lately')+' · joined '+short(p.joinedAt);
        var prog='';if(tab==='sellers'&&D.bonus.amountMinor){var done=Math.min(D.bonus.orders,p.orders);prog=p.bonus?'<span class="tag paid">'+naira(D.bonus.amountMinor)+' bonus earned</span>':'<div class="prog" aria-label="'+done+' of '+D.bonus.orders+' orders for your bonus"><i style="width:'+Math.round(100*done/D.bonus.orders)+'%"></i></div><small>'+done+' of '+D.bonus.orders+' orders for your '+naira(D.bonus.amountMinor)+' bonus</small>'}
        return '<li><span class="dot '+(p.active?'green':'')+'">'+(tab==='sellers'?I.store:I.bag)+'</span><span class="main"><b>'+esc(p.name)+'</b><small>'+sub+'</small>'+prog+'</span></li>'}).join('')+'</ul>'
      :'<p class="empty">'+(tab==='sellers'?'No sellers yet. Share your link with people who sell on Instagram, WhatsApp and TikTok: they bring the most orders.':'No buyers yet. Share your link on your status and in your groups.')+'</p>')+
     '</section>';
  // share
  if(d.link&&d.status==='ACTIVE'){
    h+='<section class="card pad"><h2>Share your link</h2><p class="lede">People who join with your link are yours for good.</p>'+
       '<div class="linkrow"><b>'+esc(d.linkText)+'</b><button class="btn soft sm" data-copy="'+esc(d.link)+'">Copy</button></div>'+
       '<img class="share-img" src="/ambassador/api/card.jpg?v='+esc(d.photoVersion||'0')+'" alt="Your share picture: your photo, your name and your link" loading="lazy">'+
       '<div class="btns"><a class="btn main" href="https://wa.me/?text='+encodeURIComponent(d.share||d.link)+'" target="_blank" rel="noopener">'+I.whatsapp+'Share on WhatsApp</a>'+
       '<a class="btn soft" href="/ambassador/api/card.jpg?download=1">Download picture</a><a class="btn soft" href="/ambassador/api/qr.png">Download QR code</a>'+
       '<button class="btn soft" data-copy-text="1">Copy message</button></div></section>';
  }
  // account
  h+='<section class="card"><div class="pad" style="padding-bottom:6px"><h2>Your account</h2></div>'+
     '<div class="row"><span class="avatar" style="width:48px;height:48px;font-size:18px;box-shadow:0 0 0 2px #fff,0 0 0 3px var(--gold)">'+(d.photo?'<img src="'+esc(d.photo)+'" alt="">':esc(initial))+'</span><span class="txt"><b>Your photo</b><small>Shows on your link with your first name.</small></span>'+
       (d.status!=='ENDED'?'<label class="btn soft sm" style="cursor:pointer">'+(d.photo?'Change':'Add photo')+'<input type="file" accept="image/*" id="photo" hidden></label>'+(d.photo?'<button class="btn soft sm" data-act="rmphoto">Remove</button>':''):'')+'</div>'+
     (d.term?'<div class="row"><span class="txt"><b>Term: '+d.term+' months</b><small>'+(d.status==='ENDED'?'Ended':'Renews by itself on '+day(d.termEnds)+(d.nextTerm?', then '+d.nextTerm+' months':'')+'. We remind you '+d.noticeDays+' days before.')+'</small></span>'+
       (d.status!=='ENDED'?'<select id="term" aria-label="Next term">'+d.terms.map(function(n){var cur=(d.nextTerm||d.term)===n;return '<option value="'+n+'"'+(cur?' selected':'')+'>'+n+' months</option>'}).join('')+'</select>':'')+'</div>':'')+
     '<div class="row"><span class="txt"><b>Your share</b><small>'+d.pct.seller+'% on sellers you bring · '+d.pct.buyer+'% on buyers'+(d.bonus.amountMinor?' · '+naira(d.bonus.amountMinor)+' per new seller after '+d.bonus.orders+' orders':'')+'</small></span></div>'+
     '<div class="row"><span class="txt"><b>Payout account</b><small>'+(d.bank?esc(d.bank.name)+' ••••'+esc(d.bank.last4)+'. To change it, open <b>Payout account</b> in the WhatsApp menu.':'Not set yet. Add it in WhatsApp.')+'</small></span></div>'+
     (d.status!=='ENDED'?'<div class="row"><span class="txt"><b>End your term</b><small>You stop earning. Everything you earned is paid, whatever the amount.</small></span><button class="btn danger sm" data-act="end">End now</button></div>':'')+
     '<p class="note">Your term is just how often you renew. Whatever term you pick, your share grows when you bring more active sellers and buyers.</p></section>';
  // payouts
  h+='<section class="card"><div class="pad" style="padding-bottom:6px"><h2>Payouts</h2><p class="lede">On the '+ord(d.payoutDay)+' of every month, for the month before. From '+naira(d.next.minMinor)+'; anything less waits for the next month.</p></div>'+
     (d.payouts.length?'<ul class="list">'+d.payouts.map(function(p){return '<li><span class="dot '+(p.status==='PAID'?'green':'')+'">'+I.wallet+'</span><span class="main"><b>'+mlabel(p.month)+(p.final?' (final)':'')+'</b><small>'+(p.status==='PAID'?'Paid '+day(p.paidAt)+(p.reference?' · Ref '+esc(p.reference):''):'Being paid')+'</small></span><span class="amt">'+naira(p.amountMinor)+'<small><span class="tag '+(p.status==='PAID'?'paid':'due')+'">'+(p.status==='PAID'?'Paid':'Due')+'</span></small></span></li>'}).join('')+'</ul>':'<p class="empty">No payouts yet.</p>')+
     '</section>';
  // how it works
  h+='<section class="card"><div class="pad" style="padding-bottom:10px"><h2>How it works</h2></div><ul class="rules">'+
     '<li>'+I.check+'<span><b>You earn on completed orders.</b> When an order from your people is complete (the buyer is happy, or the time to report a problem has passed), you get your share of what Hoolam earned on it.</span></li>'+
     '<li>'+I.check+'<span><b>'+d.pct.seller+'% on sellers, '+d.pct.buyer+'% on buyers</b> you bring, for as long as you are an ambassador.'+(d.bonus.amountMinor?' Plus <b>'+naira(d.bonus.amountMinor)+'</b> for each new seller once they complete '+d.bonus.orders+' orders.':'')+'</span></li>'+
     '<li>'+I.check+'<span><b>Only new people count.</b> Someone who already used Hoolam can\\'t be linked to you. Each person is linked to one ambassador, for good.</span></li>'+
     '<li>'+I.check+'<span><b>Refunds and cancelled orders don\\'t earn.</b> Anything that looks wrong (your own orders, the same ID or bank account) waits for our team to check.</span></li>'+
     '<li>'+I.check+'<span><b>Paid monthly</b> on the '+ord(d.payoutDay)+', to your bank account in your name.</span></li>'+
     '<li class="warn">'+I.info+'<span><b>Never collect money for Hoolam</b> or ask anyone for a PIN, OTP or password. All money goes through Hoolam only.</span></li>'+
     '</ul><p class="note">Full rules: <a href="https://hoolam.com/legal/ambassadors/" target="_blank" rel="noopener">Ambassador agreement</a></p></section>';
  app.innerHTML=h;
  bind();
}
function ord(n){return n+([11,12,13].indexOf(n%100)>=0?'th':(['th','st','nd','rd'][n%10]||'th'))}
function bind(){
  app.querySelectorAll('[data-m]').forEach(function(b){b.onclick=function(){var m=b.getAttribute('data-m');if(m)load(m)}});
  var sel=document.getElementById('msel');if(sel)sel.onchange=function(){load(sel.value)};
  app.querySelectorAll('[data-tab]').forEach(function(b){b.onclick=function(){tab=b.getAttribute('data-tab');render()}});
  app.querySelectorAll('[data-copy]').forEach(function(b){b.onclick=function(){copy(b.getAttribute('data-copy'),'Link copied')}});
  app.querySelectorAll('[data-copy-text]').forEach(function(b){b.onclick=function(){copy(D.share||D.link,'Message copied')}});
  var ph=document.getElementById('photo');if(ph)ph.onchange=function(){var f=ph.files&&ph.files[0];if(!f)return;if(f.size>8e6){toast('That photo is too big. Use one under 8 MB.');return}
    confirmBox('Use this photo?','Your photo and first name will show on your link.','Use photo').then(function(ok){if(!ok)return;toast('Uploading…');api('photo',{method:'POST',body:f,type:f.type||'image/jpeg'}).then(function(){toast('Photo saved. Your link shows it in about 2 minutes.');load()}).catch(function(x){toast(x.message)})})};
  var term=document.getElementById('term');if(term)term.onchange=function(){api('term',{method:'POST',json:{action:'switch',months:Number(term.value)}}).then(function(){toast(Number(term.value)===D.term?'You\\'ll stay on '+D.term+' months':'From your next term: '+term.value+' months');load()}).catch(function(x){toast(x.message)})};
  app.querySelectorAll('[data-act]').forEach(function(b){b.onclick=function(){var a=b.getAttribute('data-act');
    if(a==='rmphoto')confirmBox('Remove your photo?','Your link will show your first initial instead.','Remove').then(function(ok){if(ok)api('photo',{method:'DELETE'}).then(function(){toast('Photo removed');load()})});
    if(a==='end')confirmBox('End your ambassador term now?','You stop earning from today. Everything you earned is paid to your account, whatever the amount.','Yes, end it').then(function(ok){if(ok)api('term',{method:'POST',json:{action:'end'}}).then(function(){toast('Your term has ended');load()}).catch(function(x){toast(x.message)})});
  }});
}
function copy(text,done){(navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).then(function(){toast(done)}).catch(function(){var t=document.createElement('textarea');t.value=text;document.body.appendChild(t);t.select();try{document.execCommand('copy');toast(done)}catch(e){}t.remove()})}
// the account menu
var mb=document.getElementById('menu-btn'),mp=document.getElementById('menu-pop');
mb.onclick=function(e){e.stopPropagation();var open=!mp.classList.contains('open');mp.classList.toggle('open',open);mb.setAttribute('aria-expanded',open?'true':'false')};
document.addEventListener('click',function(){mp.classList.remove('open');mb.setAttribute('aria-expanded','false')});
mp.querySelectorAll('[data-act]').forEach(function(b){b.onclick=function(){var a=b.getAttribute('data-act');
  if(a==='signout')api('signout',{method:'POST'}).then(function(){signin('phone')});
  if(a==='signout-all')confirmBox('Sign out everywhere?','Every phone and computer signed in to your dashboard is signed out, this one too.','Sign out everywhere').then(function(ok){if(ok)api('signout-all',{method:'POST'}).then(function(){signin('phone','', '')})})}});
load();
})();
</script></body></html>`;
}
