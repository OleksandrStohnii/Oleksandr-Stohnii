// ---------- Telegram: вход, общий сервер и оплата звёздами ----------
const TG=window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.initData?window.Telegram.WebApp:null;
let API='';try{API=new URLSearchParams(location.search).get('api')||localStorage.getItem('shr_api')||'';if(API)localStorage.setItem('shr_api',API)}catch(e){}
let PAIDF=false;const t0=t;t=function(k,...a){return k==='nostars'&&PAIDF?'⭐':t0(k,...a)};

// Общая база: каждый запрос подписан данными Telegram, подделать нельзя
if(TG&&API){
  SRV={post:(path,data)=>fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({initData:TG.initData},data||{}))}).then(r=>r.json())};
  const u=TG.initDataUnsafe&&TG.initDataUnsafe.user;SRVID=u?u.id:0;
  // Человек пришёл по ссылке-приглашению: код прячется в адресе, передаём его
  // серверу вместе с первым запросом — так приглашение становится настоящим.
  try{
    const sp=String((TG.initDataUnsafe&&TG.initDataUnsafe.start_param)||'');
    const m=sp.match(/^ref([A-Za-z0-9]{4,10})$/);
    if(m)REFCODE=m[1].toUpperCase();
  }catch(e){}
  srvPull();srvClans('');srvTop();
  // Личные переписки нужны сразу: Hub — первая страница, и список чатов
  // на ней не должен ждать 30 секунд до первого обновления
  try{pullPms()}catch(e){}
  // Истории других людей тоже нужны сразу, а не после перехода на другую вкладку
  try{storiesPull()}catch(e){}
  setInterval(()=>{try{if(live()&&S.ch==='chats'&&!document.hidden)storiesPull()}catch(e){}},60000);
  // Звонок, из которого вышли, закрыв Telegram, — предлагаем вернуться
  setTimeout(()=>{try{if(!new URLSearchParams(location.search).get('call'))callResumeAsk()}catch(e){}},1500);
  // Кнопка «Ответить в SHRhub» в письме бота открывает приложение сразу в
  // нужной переписке: номер собеседника приходит в адресе.
  try{
    const who=Number(new URLSearchParams(location.search).get('pm')
      ||(TG.initDataUnsafe&&TG.initDataUnsafe.start_param)||0);
    if(who&&who!==SRVID)setTimeout(()=>openPm(who),300);
  }catch(e){}
  // Приглашение в клан из бота
  try{const ci=Number(new URLSearchParams(location.search).get('clan')||0);if(ci)setTimeout(()=>clanFromLink(ci),900)}catch(e){}
  // «Хочет подписаться» из бота: открываем заявки
  try{if(new URLSearchParams(location.search).get('reqs'))setTimeout(()=>go('foll'),700)}catch(e){}
  // Курсы — через свой сервер, раз он теперь известен
  try{pullFiat()}catch(e){}
  // «Тебя отметили» из бота: открываем свои отметки и саму публикацию
  try{
    const tv=Number(new URLSearchParams(location.search).get('tag')||0);
    if(tv)setTimeout(()=>{go('me');PTAB='tag';tagsPull(SRVID,()=>{const i=(TAGV[SRVID]||[]).findIndex(x=>x.id===tv);
      if(i>=0)postOpen(tv,1);else storyOpen((STORIES||[]).find(g=>g.items.some(x=>x.id===tv))?.id||0)})},700);
  }catch(e){}
  // Кнопка «Ответить» в сообщении бота о звонке
  try{
    const cid=String(new URLSearchParams(location.search).get('call')||'').replace(/[^a-z0-9]/gi,'');
    if(cid)setTimeout(()=>callFromLink(cid),600);
    else setTimeout(()=>callRingTick(1),1500);
  }catch(e){}
  // Закрыли приложение посреди звонка — сразу говорим серверу, что ушли,
  // чтобы у собеседника звонок не висел
  // Закрыли Telegram посреди звонка — трубку НЕ кладём: собеседник подождёт
  // до полутора минут, а при следующем открытии приложение предложит
  // вернуться в разговор. Положить трубку — только кнопкой «Завершить».
  window.addEventListener('pagehide',()=>{try{callSave()}catch(e){}});
}

// Своя кнопка «назад» есть у окна Telegram — рядом с заголовком. Включаем её
// на тех же экранах, где показываем стрелку внутри приложения: на айфоне руке
// ближе именно она.
if(TG&&TG.BackButton){
  try{
    TG.BackButton.onClick(()=>back());
    window.tgBack=function(on){
      try{on?TG.BackButton.show():TG.BackButton.hide()}catch(e){}
    };
  }catch(e){}
}

function pay(product,ok,arg){
  if(!TG||!API){ok();return} // вне Telegram игра остаётся демо
  fetch(API+'/invoice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:TG.initData,product,arg:arg||''})})
    .then(r=>r.json()).then(j=>{if(!j.link)throw 0;TG.openInvoice(j.link,st=>{if(st==='paid'){
      PAIDF=true;try{ok()}finally{PAIDF=false}
      // покупку выдаёт сервер после подтверждения Telegram, поэтому перечитываем профиль
      setTimeout(srvPull,1500);setTimeout(srvPull,6000);
    }})})
    .catch(()=>toast('⭐ '+['Оплата сейчас недоступна','Оплата зараз недоступна','Payment is unavailable right now'][S.lang<3?S.lang:2]))}
{const w=(name,fn)=>{const o=window[name];window[name]=function(...a){return fn(o,...a)}};
  w('setTier',(o,i)=>i>0?pay('tier'+i,()=>o(i)):o(i));
  w('buyOne',(o,x)=>pay('coin',()=>o(x),x));
  w('buy',(o,id)=>{const it=ITEMS.find(x=>x.id===id),ok=it.ok?it.ok():true;if(ok!==true){toast(ok);return}id==='gift'?o(id):pay(id,()=>o(id))});
  w('buyItem',(o,x)=>pay(x,()=>o(x)));
  w('buyPass',o=>pay('pass',()=>o()));
  w('bigBuy',o=>pay('bigcall',()=>o()));
  w('buyBanner',o=>{if(!S.clan){toast(t('need_clan'));return}pay('banner',()=>o())});
  w('buySkin',o=>pay('rbskin',()=>o()));
  w('buyFelt',o=>pay('felt',()=>o()));
  w('buyShovel',o=>pay('shovel',()=>o()));
  w('restore',(o,how)=>how==='pay'?pay('save',()=>o(how)):o(how));
  w('buySpot',(o,kind)=>{if(kind==='cspot'&&!S.clan){toast(t('need_clan'));return}
    pay(kind,()=>{toast('⭐');setTimeout(srvTop,1500);setTimeout(srvTop,6000)},kind==='cspot'?String((S.clan&&S.clan.id)||''):'')});
  w('buyVoice',()=>pay('chat',()=>{CHATOK=true;toast('🎙');render()}));
  // Загрузка ролика: шлём файл сырым телом, подпись Telegram — в заголовке.
  // XMLHttpRequest, а не fetch, ради процента отправки: человеку надо видеть, что идёт.
  w('vidUp',()=>{
    if(!TG||!API||!VFILE){toast(t('vd_demo'));return}
    if(VUP>=0)return; // уже идёт
    const ttl=(VTITLE||'').trim().slice(0,80);
    const send=(f,mime)=>{
      VSTAGE='up';VUP=0;vidUpBar();
      const x=new XMLHttpRequest();
      const k=typeof VKIND!=='undefined'?VKIND:'reel';
      x.open('POST',API+'/vup?kind='+k+'&title='+encodeURIComponent(ttl)
        +(k==='story'?'&media='+VSMEDIA+(VAD?'&ad=1':''):'')
        +(VTAGS.length?'&tags='+VTAGS.map(x=>x.id).join(','):'')+(VLINKS.length?'&links='+encodeURIComponent(VLINKS.join(',')):'')
        +'&mime='+encodeURIComponent(mime||f.type||'video/mp4')+(VCUT?'&dur='+Math.round(VCUT):''));
      x.setRequestHeader('x-init',encodeURIComponent(TG.initData));
      x.setRequestHeader('Content-Type','application/octet-stream');
      x.upload.onprogress=e=>{if(e.lengthComputable){VUP=Math.round(e.loaded/e.total*100);vidUpBar()}};
      x.onload=()=>{let j={};try{j=JSON.parse(x.responseText)}catch(e){}
        const ok=x.status===200&&j.ok;
        // Своё хранилище не делает обложку само — снимаем кадр и досылаем
        if(ok&&j.id&&k!=='photo'&&!(k==='story'&&VSMEDIA==='photo'))vidPosterUp(j.id);
        vidUpDone(ok?'':(j.error||('http '+x.status)),j.detail)};
      x.onerror=()=>vidUpDone('fail');
      x.ontimeout=()=>vidUpDone('fail');
      x.timeout=180000;
      x.send(f);
    };
    // Тяжёлый или длинный ролик сначала сжимаем. Запуск — прямо из нажатия:
    // айфон разрешает воспроизведение со звуком только так.
    if(VNEED){
      VSTAGE='shrink';VUP=0;vidUpBar();
      vidShrink(p=>{VUP=Math.round(p*100);vidUpBar()},1)
        .then(b=>{
          // Без своего хранилища Telegram покажет только файл до 20 МБ —
          // если вышло тяжелее, сжимаем ещё раз, мельче
          if(b.size<=VDIRECT||SRVMEDIA)return b;
          VSTAGE='shrink2';VUP=0;vidUpBar();
          return vidShrink(p=>{VUP=Math.round(p*100);vidUpBar()},2).then(b2=>b2.size<b.size?b2:b);
        })
        .then(b=>{VSTAGE='';send(b,b.type)})
        .catch(e=>vidUpDone(e==='play'?'play':'shrink'));
    }else send(VFILE,VFILE.type);
  });
  // Обложка ролика: кадр с начала видео, отправляем после загрузки
  w('vidPosterUp',(o,id)=>{
    if(!SRVMEDIA||!VPREP||!VPREP.v)return;
    try{
      const v=VPREP.v,c=document.createElement('canvas'),k=Math.min(1,720/Math.max(v.videoWidth||720,v.videoHeight||720));
      c.width=Math.round((v.videoWidth||720)*k);c.height=Math.round((v.videoHeight||1280)*k);
      c.getContext('2d').drawImage(v,0,0,c.width,c.height);
      c.toBlob(b=>{if(!b)return;const x=new XMLHttpRequest();x.open('POST',API+'/vthumb?id='+id);
        x.setRequestHeader('x-init',encodeURIComponent(TG.initData));x.setRequestHeader('Content-Type','application/octet-stream');
        x.onload=()=>{try{postsPull(SRVID);vidsPull();storiesPull()}catch(e){}};x.send(b)},'image/jpeg',0.8);
    }catch(e){}
  });
  // Вложение в переписку: тот же путь, что у ролика в ленту
  w('pmFile',(o,f,kind,mime,secs)=>{
    if(!TG||!API||!f||!PMID){toast(t('vd_demo'));return}
    PMUP=0;renderPm();
    const cap=(($('pmtx')&&$('pmtx').value)||'').trim().slice(0,300);
    if($('pmtx'))$('pmtx').value='';
    const x=new XMLHttpRequest();
    x.open('POST',API+'/pmup?with='+PMID+'&kind='+kind
      +(mime?'&mime='+encodeURIComponent(mime):'')+(secs?'&dur='+secs:'')
      +'&caption='+encodeURIComponent(cap));
    x.setRequestHeader('x-init',encodeURIComponent(TG.initData));
    x.setRequestHeader('Content-Type','application/octet-stream');
    x.upload.onprogress=e=>{if(e.lengthComputable){PMUP=Math.round(e.loaded/e.total*100);renderPm()}};
    x.onload=()=>{let j={};try{j=JSON.parse(x.responseText)}catch(e){}
      pmUpDone(x.status===200&&j.ok?'':(j.error||('http '+x.status)),j.detail)};
    x.onerror=()=>pmUpDone('fail');
    x.ontimeout=()=>pmUpDone('fail');
    x.timeout=180000;
    x.send(f);
  });
  // Подарок: счёт выписывает сервер, он же знает цену и комиссию
  // Номер спрашивает сам Telegram своим окном. Мы его не вводим и не видим,
  // пока человек не согласится — тогда он придёт боту отдельным сообщением.
  w('cardPhoneAsk',()=>{
    if(!TG||!TG.requestContact){toast(t('vd_demo'));return}
    try{TG.requestContact(ok=>{if(ok){toast(t('cd_ph_wait'));setTimeout(pullCard,2000);setTimeout(pullCard,6000)}})}
    catch(e){toast(t('vd_demo'))}
  });
  // Делимся ссылкой через сам Telegram: он покажет список контактов человека,
  // и мы этот список не видим — выбор остаётся у него.
  w('shareRef',(o,link,text)=>{
    if(!TG||!TG.openTelegramLink){o(link,text);return}
    try{TG.openTelegramLink('https://t.me/share/url?url='+encodeURIComponent(link)
      +'&text='+encodeURIComponent(text||''))}
    catch(e){o(link,text)}
  });
  w('presBuy',(o,id,note)=>{
    if(!TG||!API||!PRESTO){toast(t('vd_demo'));return}
    if(PRESBUSY)return;PRESBUSY=1;
    fetch(API+'/gifts',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({initData:TG.initData,act:'buy',id:id,to:PRESTO,text:note||''})})
      .then(r=>r.json()).then(j=>{
        PRESBUSY=0;
        if(!j.link)throw 0;
        TG.openInvoice(j.link,st=>{if(st==='paid'){
          toast(t('pr_gift_sent'));setTimeout(()=>{pullPres();pullPms()},2000);
        }});
      }).catch(()=>{PRESBUSY=0;toast(t('vd_fail'))});
  });
  w('buyBoost',(o,id)=>pay('boost',()=>{toast(t('vd_bst_done'));setTimeout(vidsPull,1500);setTimeout(vidsPull,6000)},String(id)));
  w('toggleGm',o=>!S.gm&&S.gmFree<=0&&TG&&API?pay('gm',()=>{S.gmFree++;o()}):o());}
// Иконка мини-приложения на экране телефона: вход и покупки остаются телеграмовскими
let HS='';
function paintHome(){
  const e=document.getElementById('homeadd');if(!e)return;
  e.innerHTML=(HS==='missed'||HS==='unknown')
    ?`<div class="card"><div class="muted">${t('home_d')}</div><button class="btn g" onclick="askHome()">${t('home_add')}</button></div>`:'';
}
function askHome(){try{TG.addToHomeScreen()}catch(e){}}
if(TG&&typeof TG.checkHomeScreenStatus==='function'){
  try{
    TG.checkHomeScreenStatus(st=>{HS=st||'';paintHome()});
    ['homeScreenAdded','home_screen_added'].forEach(n=>TG.onEvent(n,()=>{HS='added';paintHome();toast(t('home_ok'))}));
    ['homeScreenChecked','home_screen_checked'].forEach(n=>TG.onEvent(n,e=>{if(e&&e.status){HS=e.status;paintHome()}}));
  }catch(e){}
  const r0=render;render=function(){r0.apply(this,arguments);paintHome()};
}
// Полный экран: Telegram убирает свою шапку, но тогда её место занимает наш
// заголовок — поэтому сверху добавляем отступ, который Telegram сам же и называет.
let FULL=false;
function fullOk(){try{return !!(TG&&TG.isVersionAtLeast&&TG.isVersionAtLeast('8.0')&&TG.requestFullscreen)}catch(e){return false}}
function fullPad(){
  try{
    const a=(TG&&TG.safeAreaInset)||{},b=(TG&&TG.contentSafeAreaInset)||{};
    const top=(a.top||0)+(b.top||0);
    document.documentElement.style.setProperty('--tgtop',(FULL?top:0)+'px');
  }catch(e){}
}
// На компьютере Telegram не всегда умеет «полный экран» для мини-приложений —
// тогда просим об этом сам браузер внутри окна
function docFull(){
  const d=document,el=d.documentElement;
  try{
    if(d.fullscreenElement||d.webkitFullscreenElement){(d.exitFullscreen||d.webkitExitFullscreen).call(d);return true}
    const f=el.requestFullscreen||el.webkitRequestFullscreen;if(!f)return false;
    const p=f.call(el);if(p&&p.catch)p.catch(()=>toast(t('full_win')));return true;
  }catch(e){return false}
}
function toggleFull(){
  if(!fullOk()){if(!docFull())toast(t('full_win'));return}
  try{FULL?TG.exitFullscreen():TG.requestFullscreen()}catch(e){if(!docFull())toast(t('full_win'))}
}
if(fullOk()||document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen){
  try{
    FULL=!!(TG&&TG.isFullscreen);
    ['fullscreenChanged','fullscreen_changed'].forEach(n=>TG.onEvent(n,()=>{FULL=!!TG.isFullscreen;fullPad();render()}));
    ['safeAreaChanged','contentSafeAreaChanged'].forEach(n=>TG.onEvent(n,fullPad));
    TG.onEvent('fullscreenFailed',()=>{FULL=false;fullPad();render();if(!docFull())toast(t('full_win'))});
    fullPad();
  }catch(e){}
  ['fullscreenchange','webkitfullscreenchange'].forEach(n=>document.addEventListener(n,()=>{
    if(!fullOk()||!(TG&&TG.isFullscreen)){FULL=!!(document.fullscreenElement||document.webkitFullscreenElement);render()}}));
  // Кнопка живёт в шапке рядом с темой
  const paintFull=()=>{
    const h=document.querySelector('.chh');if(!h)return;
    let b=document.getElementById('fsb');
    if(!b){b=document.createElement('button');b.id='fsb';b.className='ib';b.onclick=toggleFull;
      const th=document.getElementById('thb');if(th&&th.parentNode)th.parentNode.insertBefore(b,th);else h.appendChild(b)}
    b.textContent=FULL?'⤡':'⤢';b.title=FULL?t('full_off'):t('full_on');
  };
  const r1=render;render=function(){r1.apply(this,arguments);paintFull()};
}
try{
  const u=TG&&TG.initDataUnsafe&&TG.initDataUnsafe.user;
  if(u&&u.photo_url&&!S.avImg&&!S.avOwn){S.avImg=u.photo_url;save()}
  // Фото из Telegram отдаём серверу, чтобы остальные видели лицо, а не шляпу
  if(u&&u.photo_url)PHOTOURL=u.photo_url;
}catch(e){}
if(TG&&API)window.__support=txt=>{fetch(API+'/support',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:TG.initData,text:txt})}).catch(()=>{})};
if(TG){try{TG.ready();TG.expand();const u=TG.initDataUnsafe&&TG.initDataUnsafe.user;
  if(u){if(!S.nick&&u.first_name)S.nick=String(u.first_name).slice(0,16);
    if(!S.ok18){const i=LOC.indexOf(String(u.language_code||'').slice(0,2));if(i>=0)S.lang=i}}
  document.documentElement.lang=LOC[S.lang];save();render();if(!S.ok18)rules()}catch(e){}}
</script>
</body>
</html>
