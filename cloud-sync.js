/* ETS TOEIC cloud sync. Browser-side Supabase Auth + REST, no CDN required.
   The publishable key is public by design; NEVER use a secret/service_role key here.
   Personal learning records stay in Supabase, and are never embedded in this source file. */
(function () {
  'use strict';
  const API_BASE = 'https://vqjzdvojngrndexgylnz.supabase.co';
  const API_KEY = 'sb_publishable_4SpXyArZpQ7tz2dnDKaqpg_j8pMnNWq';
  const LOGIN_KEY = 'ets-toeic-supabase-login-v1';
  const SYNC_KEY = 'ets-toeic-supabase-sync-v1';
  const PARTS = ['ets_progress', 'personal_words'];
  const initialMeta = () => ({uid:null, established:false,
    version:{ets_progress:null,personal_words:null},
    dirty:{ets_progress:false,personal_words:false}});
  const $cloud = id => document.getElementById(id);
  const jsonClone = x => JSON.parse(JSON.stringify(x));

  function readLocal(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch (_) { return null; }
  }
  let session = readLocal(LOGIN_KEY);
  if (!session || !session.access_token || !session.refresh_token || !session.user || !session.user.id) session = null;
  const cached = readLocal(SYNC_KEY);
  let meta = Object.assign(initialMeta(), cached || {});
  meta.version = Object.assign(initialMeta().version, meta.version || {});
  meta.dirty = Object.assign(initialMeta().dirty, meta.dirty || {});
  let linked = false, busy = false, conflict = false, timer = null;
  let lastError = false, downloadArmed = false;
  let revisions = {ets_progress:0, personal_words:0};

  function say(text) { const el=$cloud('cloudMessage'); if(el) el.textContent=text; }
  function saveMeta() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(meta)); }
    catch (_) { say('기기 저장이 불가능합니다. 전체 백업을 보관하세요.'); }
  }
  function saveLogin() {
    try {
      if(session) localStorage.setItem(LOGIN_KEY, JSON.stringify(session));
      else localStorage.removeItem(LOGIN_KEY);
    } catch (_) { say('로그인 유지에 실패했습니다. 브라우저 저장 설정을 확인하세요.'); }
  }
  function serverError(data, defaultText) {
    return (data && (data.msg || data.message || data.error_description || data.error)) || defaultText;
  }
  async function authRequest(path, data) {
    const response = await fetch(API_BASE + '/auth/v1/' + path, {
      method:'POST', headers:{apikey:API_KEY, 'Content-Type':'application/json'},
      body:JSON.stringify(data)
    });
    const value = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(serverError(value, '로그인 서버 오류 ('+response.status+')'));
    return value;
  }
  async function accessToken() {
    if(!session) throw new Error('로그인해 주세요.');
    if(!session.expiresAt || Date.now() > session.expiresAt-60000) {
      const renewed = await authRequest('token?grant_type=refresh_token', {refresh_token:session.refresh_token});
      session = Object.assign({}, renewed, {expiresAt:Date.now() + (renewed.expires_in || 3600)*1000});
      saveLogin();
    }
    return session.access_token;
  }
  async function rest(path, method='GET', body) {
    const token = await accessToken();
    const options = {method, headers:{apikey:API_KEY, Authorization:'Bearer '+token}};
    if(body !== undefined) {
      options.headers['Content-Type']='application/json';
      options.headers.Prefer='return=representation';
      options.body=JSON.stringify(body);
    }
    const response = await fetch(API_BASE+'/rest/v1/vocab_sync'+path, options);
    const value = await response.json().catch(() => null);
    if(!response.ok) {
      const err = new Error(serverError(value, 'DB 접속 오류 ('+response.status+')'));
      err.isConflict = response.status === 409 || response.status === 412;
      throw err;
    }
    return value;
  }
  async function fetchRows() {
    const rows = await rest('?select=section,payload,updated_at&user_id=eq.' + encodeURIComponent(session.user.id));
    return Object.fromEntries((rows || []).map(row => [row.section,row]));
  }
  function payload(section) {
    return section === 'ets_progress' ? jsonClone(state) : jsonClone(personalWords);
  }
  function hasLocalStudy() {
    return Object.keys(state.records || {}).length > 0 || state.history.length > 0 ||
      JSON.stringify(personalWords) !== JSON.stringify(PERSONAL_SEED);
  }
  function applyRemote(rows, force=false) {
    // Avoid re-rendering unchanged rows during a background sync.
    const updateProgress=!!rows.ets_progress && (force || rows.ets_progress.updated_at!==meta.version.ets_progress);
    const updatePersonal=!!rows.personal_words && (force || rows.personal_words.updated_at!==meta.version.personal_words);
    if(!updateProgress && !updatePersonal) return;
    // Validate both sections before changing either local record.
    const progress=updateProgress ? validate(rows.ets_progress.payload) : null;
    const personal=updatePersonal ? validatePersonal(rows.personal_words.payload) : null;
    if(progress) { state=progress; originalSave(); applySettings(); }
    if(personal) {
      personalWords=personal;
      if(personalSession) {
        // Preserve the current card and selected order, even if another device deleted a word.
        const oldIds=personalSession.ids;
        const remainingIds=new Set(personalWords.map(word=>word.id));
        const nextId=oldIds.slice(personalSession.index).find(id=>remainingIds.has(id));
        const keptIds=oldIds.filter(id=>remainingIds.has(id));
        personalSession.ids=keptIds;
        personalSession.index=nextId ? keptIds.indexOf(nextId) : keptIds.length;
      }
      originalSavePersonal();
    }
    render();
  }
  function refreshBadge() {
    const button=$cloud('cloudOpen');
    if(!button) return;
    button.textContent = !session ? '☁ 로그인' : busy ? '☁ 동기화 중…' :
      conflict ? '☁ 기록 선택 필요' : lastError ? '☁ 오류 확인' : !linked ? '☁ 연결 확인 중' :
      PARTS.some(p=>meta.dirty[p]) ? '☁ 저장 대기' : '☁ 동기화 완료';
    $cloud('cloudLogin').hidden=!!session;
    $cloud('cloudAccount').hidden=!session;
    $cloud('cloudAccountEmail').textContent = session?.user?.email || '';
  }
  function signalConflict(message) {
    conflict=true;linked=false;
    $cloud('cloudChoices').hidden=false;
    say(message);refreshBadge();
    if(!$cloud('cloudDialog').open) $cloud('cloudDialog').showModal();
  }
  function fail(error) {
    if(error?.isConflict) {
      signalConflict('다른 기기의 학습기록과 충돌했습니다. 자동 덮어쓰기를 중단했습니다.');
    } else {
      lastError = true;
      say('동기화 오류: '+(error?.message || '네트워크 오류')+' (기기 기록은 보관됨)');
      if(!$cloud('cloudDialog').open) $cloud('cloudDialog').showModal();
    }
    refreshBadge();
  }

  // The original app continues saving into localStorage, even without internet.
  const originalSave = save;
  const originalSavePersonal = savePersonal;
  function markDirty(part) {
    revisions[part]++;
    meta.dirty[part]=true;
    saveMeta();refreshBadge();
    if(session && linked && !conflict) {
      clearTimeout(timer);
      timer=setTimeout(sync,1000);
    }
  }
  save = function () { originalSave(); markDirty('ets_progress'); };
  savePersonal = function () {
    const ok=originalSavePersonal();
    if(ok) markDirty('personal_words');
    return ok;
  };

  function fullBackup(data, prefix='ETS_TOEIC_full_backup') {
    const blob=new Blob([JSON.stringify(data, null, 2)],{type:'application/json'});
    const address=URL.createObjectURL(blob);
    const anchor=document.createElement('a');
    anchor.href=address; anchor.download=prefix+'_'+today()+'.json';
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(address),5000);
  }
  function backupLocal() {
    fullBackup({app:'ETS_TOEIC_CloudBackup',version:1,createdAt:new Date().toISOString(),
      ets_progress:payload('ets_progress'),personal_words:payload('personal_words')});
  }
  function backupCloud(rows) {
    fullBackup({app:'ETS_TOEIC_CloudBackup',version:1,createdAt:new Date().toISOString(),
      ets_progress:rows.ets_progress?.payload || null,
      personal_words:rows.personal_words?.payload || null},'ETS_TOEIC_previous_cloud');
  }
  function setBaseline(rows) {
    meta.uid=session.user.id;meta.established=true;
    PARTS.forEach(part => meta.version[part]=rows[part]?.updated_at || null);
    saveMeta();
  }
  async function writePart(part, remoteVersion, force=false) {
    const revision=revisions[part];
    const data={user_id:session.user.id,section:part,payload:payload(part),updated_at:new Date().toISOString()};
    const where='?user_id=eq.'+encodeURIComponent(session.user.id)+'&section=eq.'+encodeURIComponent(part);
    const condition=remoteVersion && !force ? '&updated_at=eq.'+encodeURIComponent(remoteVersion) : '';
    const saved=await rest(remoteVersion ? where+condition : '', remoteVersion ? 'PATCH' : 'POST', data);
    if(!Array.isArray(saved) || saved.length !== 1) {
      const err=new Error('다른 기기에서 먼저 기록을 수정했습니다.');err.isConflict=true;throw err;
    }
    meta.version[part]=saved[0].updated_at;
    meta.dirty[part]=revisions[part]!==revision;
    saveMeta();
  }
  async function pushLocalToCloud() {
    const existing=await fetchRows();
    if(PARTS.some(part=>existing[part])) backupCloud(existing);
    for(const part of PARTS) await writePart(part, existing[part]?.updated_at || null, true);
    meta.uid=session.user.id;meta.established=true;
    saveMeta(); linked=true;conflict=false;lastError=false;
    $cloud('cloudChoices').hidden=true;
    say('이 기기의 학습기록을 클라우드에 저장했습니다.');refreshBadge();
  }
  async function pullFromCloud() {
    const current=await fetchRows();
    if(!PARTS.every(part=>current[part])) throw new Error('클라우드 데이터가 일부 누락되어 가져올 수 없습니다.');
    applyRemote(current, true);
    setBaseline(current);
    PARTS.forEach(part=>meta.dirty[part]=false);
    saveMeta();linked=true;conflict=false;lastError=false;
    $cloud('cloudChoices').hidden=true;
    say('클라우드의 학습기록을 불러왔습니다.');refreshBadge();
  }
  async function sync() {
    if(!session || busy || conflict) return;
    busy=true;refreshBadge();
    let completed=false;
    try {
      const cloud=await fetchRows();
      if(PARTS.every(part=>!cloud[part])) {
        if(meta.established && meta.uid===session.user.id) {
          signalConflict('원래 저장된 클라우드 기록이 보이지 않습니다. 서버 상태를 확인해 주세요.');
        } else {
          signalConflict('클라우드가 비어 있어요. 이 기기에서 공부한 기록을 최초 업로드할지 선택해 주세요.');
        }
        return;
      }
      if(!meta.established || meta.uid!==session.user.id) {
        if(hasLocalStudy()) {
          signalConflict('이 기기와 클라우드에 각각 기록이 있습니다. 백업 후 사용할 쪽을 선택해 주세요.');
        } else {
          await pullFromCloud();
        }
        completed=true;
        return;
      }
      for(const part of PARTS) {
        const version=cloud[part]?.updated_at || null;
        if(meta.dirty[part] && version!==meta.version[part]) {
          signalConflict('오프라인 변경과 다른 기기의 변경이 겹쳤습니다. 먼저 기록을 백업해 주세요.');
          return;
        }
        if(meta.version[part] && !version) {
          signalConflict('클라우드에 있어야 할 데이터 일부가 없습니다.');return;
        }
      }
      for(const part of PARTS.filter(p=>meta.dirty[p])) {
        await writePart(part,cloud[part]?.updated_at || null);
      }
      if(PARTS.every(part=>!meta.dirty[part])) {
        // Reload after writes. A newer remote snapshot never overwrites unsaved changes.
        const newest=await fetchRows();
        if(PARTS.every(part=>newest[part]) && PARTS.every(part=>!meta.dirty[part])) {
          applyRemote(newest);
          setBaseline(newest);
        }
      }
      linked=true;
      completed=true;
      lastError=false;
      say('최신 학습기록과 동기화됐습니다.');
    } catch(error) { fail(error); }
    finally {
      busy=false;refreshBadge();
      if(completed && linked && !conflict && PARTS.some(part=>meta.dirty[part])) {
        clearTimeout(timer);timer=setTimeout(sync,1500);
      }
    }
  }

  const loginButton=document.createElement('button');
  loginButton.type='button';loginButton.id='cloudOpen';
  const theme=document.getElementById('themeButton');
  if(theme) theme.insertAdjacentElement('beforebegin',loginButton);
  else document.querySelector('header')?.append(loginButton);
  const dialog=document.createElement('dialog');dialog.id='cloudDialog';
  dialog.style.cssText='max-width:460px;width:calc(100% - 24px);border-radius:18px;border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:24px;box-shadow:0 16px 42px #0003';
  dialog.innerHTML=[
    '<div class="row between"><h2 style="margin:0">☁ 학습기록 동기화</h2><button type="button" id="cloudClose">✕</button></div>',
    '<p class="small muted" id="cloudMessage" role="status">Supabase에 생성한 이메일 계정으로 로그인하세요.</p>',
    '<form id="cloudLogin" class="stack">',
    '<label>이메일<input id="cloudEmail" type="email" autocomplete="username" required style="width:100%;display:block"></label>',
    '<label>비밀번호<input id="cloudPassword" type="password" autocomplete="current-password" required style="width:100%;display:block"></label>',
    '<button class="primary" type="submit">로그인</button></form>',
    '<section id="cloudAccount" hidden><p class="small">계정: <b id="cloudAccountEmail"></b></p>',
    '<div class="row" style="flex-wrap:wrap"><button id="cloudRefresh" type="button" class="primary">지금 동기화</button>',
    '<button id="cloudLogout" type="button">로그아웃</button></div></section>',
    '<section id="cloudChoices" hidden style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px">',
    '<h3>사용할 기록 선택</h3><p class="small">진행 전에 전체 백업 파일을 내려받으세요. 선택하지 않은 쪽 기록은 교체됩니다.</p>',
    '<div class="stack"><button id="cloudDownload" type="button" class="primary">클라우드 기록을 이 기기로 가져오기</button>',
    '<button id="cloudUpload" type="button">이 기기 기록으로 클라우드 덮어쓰기</button>',
    '<button id="cloudLater" type="button">나중에 결정</button></div></section>',
    '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">',
    '<button type="button" id="cloudBackup">이 기기 전체 백업 (.json)</button>',
    '<p class="small muted">인터넷이 끊기면 임시로 기기에 저장합니다. 기기 간 충돌은 자동 덮어쓰지 않습니다.</p>'
  ].join('');
  document.body.append(dialog);
  $cloud('cloudClose').onclick=()=>dialog.close();
  loginButton.onclick=()=>{refreshBadge();if(!dialog.open)dialog.showModal();};
  $cloud('cloudBackup').onclick=()=>{
    try { backupLocal(); say('백업 다운로드를 요청했습니다. 파일 앱의 다운로드 폴더를 확인해 주세요.'); }
    catch(error) { say('백업 오류: '+error.message+' 다른 기기나 기존 JSON 백업을 먼저 확인해 주세요.'); }
  };
  $cloud('cloudLater').onclick=()=>dialog.close();
  $cloud('cloudRefresh').onclick=()=>{
    if(conflict) {
      $cloud('cloudChoices').hidden=false;
      say('기록 충돌 중에는 자동 동기화가 중지됩니다. 먼저 현재 기기 기록을 백업하고 가져올 기록을 선택해 주세요.');
      return;
    }
    say('동기화 요청 중입니다…');sync();
  };
  $cloud('cloudLogin').onsubmit=async event=>{
    event.preventDefault();
    const button=event.currentTarget.querySelector('button[type="submit"]');
    button.disabled=true;
    try {
      const user=await authRequest('token?grant_type=password', {
        email:$cloud('cloudEmail').value.trim(), password:$cloud('cloudPassword').value
      });
      session=Object.assign({},user,{expiresAt:Date.now()+(user.expires_in||3600)*1000});
      $cloud('cloudPassword').value='';saveLogin();
      linked=false;conflict=false;
      dialog.close();await sync();
    } catch(error) { say('로그인 오류: '+error.message); }
    finally { button.disabled=false;refreshBadge(); }
  };
  $cloud('cloudLogout').onclick=()=>{
    if(!confirm('로그아웃할까요? 이 기기의 기록은 계속 남습니다.'))return;
    session=null;linked=false;conflict=false;clearTimeout(timer);saveLogin();
    $cloud('cloudChoices').hidden=true;
    say('로그아웃했습니다. 이 기기의 기록은 유지됩니다.');refreshBadge();
  };
  $cloud('cloudDownload').onclick=async()=>{
    const button=$cloud('cloudDownload');
    if(!downloadArmed) {
      downloadArmed=true;
      button.textContent='확인 후 가져오기 (한 번 더 누르기)';
      say('아이패드 기록이 클라우드 기록으로 교체됩니다. 위의 전체 백업 버튼으로 현재 기기 기록을 저장한 뒤, 이 버튼을 한 번 더 누르세요.');
      return;
    }
    button.disabled=true;
    say('Supabase에서 기록을 불러오는 중입니다…');
    try { await pullFromCloud(); dialog.close(); }
    catch(error) { fail(error); }
    finally {
      downloadArmed=false;button.disabled=false;
      button.textContent='클라우드 기록을 이 기기로 가져오기';
    }
  };
  $cloud('cloudUpload').onclick=async()=>{
    if(!confirm('이 기기의 기록으로 클라우드 기록을 덮어쓸까요? 다른 기기의 학습기록이 사라질 수 있습니다.'))return;
    backupLocal();
    try { await pushLocalToCloud();dialog.close(); }
    catch(error) { fail(error); }
  };
  window.addEventListener('online',sync);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
  setInterval(()=>{if(!document.hidden)sync();},45000);
  refreshBadge();
  if(session)sync();
})();
