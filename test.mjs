import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createClient,checkPending,run,validateJobs,ORIGIN,AUDIENCE} from './run.mjs';
import {chunksFor} from './engine.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const job=(id,text='A new AI update. The facts are reviewed.')=>({id,text,hash:hash(text)});
const mp3=new Uint8Array(256);mp3.set([255,251,144,100]);
const secret='private-site-service-token-never-print';
const requestSecret='private-github-request-token-never-print';
const env={ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/idtoken?api-version=1',ACTIONS_ID_TOKEN_REQUEST_TOKEN:requestSecret};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fakeApi({lists=[[job('article'),job('brief')]],uploadStatus=200,readback=mp3,failFirstGet=false,portalOrigin=ORIGIN}={}){
  const calls=[],tokens=[];let listIndex=0,failedGet=false;
  const fetchImpl=async(url,options={})=>{
    url=String(url);const headers=new Headers(options.headers);calls.push({url,options,headers});
    if(url.startsWith('https://pipelines.actions.githubusercontent.com/')){
      assert.equal(options.redirect,'error','GitHub identity requests must not follow redirects');
      assert.equal(headers.get('authorization'),'Bearer '+requestSecret);assert.equal(new URL(url).searchParams.get('audience'),AUDIENCE);
      const value='header'+(tokens.length+1)+'.payload.signature';tokens.push(value);return json({value});
    }
    assert.equal(new URL(url).origin,portalOrigin);assert.equal(options.redirect,'manual');
    assert.equal(headers.get('OAI-Sites-Authorization'),null,'public portal needs no permanent service credential');assert.equal(headers.get('User-Agent'),'Indesignal-Audio-Publisher/1.0');
    if(url.endsWith('/api/editorial/narration/jobs')){
      assert.equal(headers.get('Authorization'),'Bearer '+tokens.at(-1));
      if(failFirstGet&&!failedGet){failedGet=true;return json({},503);}
      const jobs=lists[Math.min(listIndex++,lists.length-1)];return json({jobs});
    }
    if(options.method==='POST'){
      assert.equal(headers.get('Authorization'),'Bearer '+tokens.at(-1));assert.equal(headers.get('Content-Type'),'audio/mpeg');
      return json({code:uploadStatus===409?'TEXT_VERSION_MISMATCH':'AUDIO_READY'},uploadStatus);
    }
    assert.equal(headers.get('Authorization'),null,'public byte verification does not send GitHub OIDC');
    if(options.method==='HEAD')return new Response(null,{headers:{'Content-Type':'audio/mpeg','Content-Length':String(mp3.byteLength)}});
    return new Response(readback,{headers:{'Content-Type':'audio/mpeg'}});
  };
  return {fetchImpl,calls,tokens};
}

assert.deepEqual(validateJobs({jobs:[job('article'),job('brief')]}).map(j=>j.id),['brief','article']);
for(const invalid of [{jobs:[job('one'),job('one')]},{jobs:[{...job('one'),hash:'0'.repeat(64)}]},{jobs:[job('../unsafe')]},{jobs:[job('one',' Double  spaces. ')]},{jobs:Array.from({length:41},(_,i)=>job('id'+i))}])assert.throws(()=>validateJobs(invalid));
assert.equal(chunksFor('A short sentence. Another short sentence.').length,1);
assert.ok(chunksFor('A word '.repeat(100)).every(text=>text.length<=280));

const api=fakeApi(),events=[],order=[];
const client=createClient({env,fetchImpl:api.fetchImpl,sleep:async()=>{}});
const result=await run({client,synthesize:async next=>{order.push(next.id);return mp3;},log:event=>events.push(event)});
assert.deepEqual(order,['brief','article']);assert.deepEqual(result,{event:'complete',uploaded:2,stale:0,failed:0});
assert.equal(api.tokens.length,3,'each upload obtains fresh OIDC after synthesis');
assert.equal(api.calls.filter(call=>call.options.method==='HEAD').length,2);
assert.equal(api.calls.filter(call=>call.url.includes('.mp3')&&call.options.method!=='HEAD').length,2);
assert.ok(api.calls.filter(call=>call.options.method==='POST').every(call=>call.headers.get('X-Narration-Hash')===hash('A new AI update. The facts are reviewed.')));
assert.doesNotMatch(JSON.stringify(events),/private-|header\d|The facts|reviewed/);

let synthCalls=0;
const quietApi=fakeApi({lists:[[]]});await run({client:createClient({env,fetchImpl:quietApi.fetchImpl}),synthesize:async()=>{synthCalls++;return mp3;},log:()=>{}});assert.equal(synthCalls,0,'no jobs means no model load or synthesis');

// The preflight uses real client authentication/validation, but cannot synthesize
// or upload. An empty queue produces a fixed false output and no heavy requests.
for(const jobs of [[],[job('brief')]]){
  const checkApi=fakeApi({lists:[jobs]}),outputs=[],checkEvents=[];
  const checked=await checkPending({client:createClient({env,fetchImpl:checkApi.fetchImpl}),outputPath:'workflow-output',writeOutput:async(...args)=>outputs.push(args),log:e=>checkEvents.push(e)});
  assert.deepEqual(checked,{hasJobs:jobs.length>0,count:jobs.length});
  assert.deepEqual(outputs,[['workflow-output','has_jobs='+String(jobs.length>0)+'\n','utf8']]);
  assert.equal(checkApi.calls.length,2,'only identity and pending jobs are requested');
  assert.equal(checkApi.calls.filter(c=>c.options.method==='POST'||c.url.includes('.mp3')).length,0);
  assert.doesNotMatch(JSON.stringify({outputs,checkEvents}),/private-|header\d|The facts|reviewed/);
}
let wroteInvalid=false;
await assert.rejects(checkPending({client:{jobs:async()=>[{...job('brief'),hash:'0'.repeat(64)}]},outputPath:'workflow-output',writeOutput:async()=>{wroteInvalid=true;},log:()=>{}}),/INVALID_JOB/);
assert.equal(wroteInvalid,false,'invalid jobs never enable installation');
const deniedCheck=createClient({env,fetchImpl:async(url,options)=>String(url).startsWith('https://pipelines.')?json({value:'header.payload.signature'}):json({},401)});
await assert.rejects(checkPending({client:deniedCheck,outputPath:'workflow-output',writeOutput:async()=>{wroteInvalid=true;},log:()=>{}}),/NARRATION_AUTH_DENIED/);
assert.equal(wroteInvalid,false,'failed authentication never enables installation');
await assert.rejects(checkPending({client:{jobs:async()=>[]},outputPath:'',log:()=>{}}),/MISSING_WORKFLOW_OUTPUT/);

const old=job('brief','The earlier version.'),fresh=job('brief','The revised version.');let first=true,rechecks=0;
const staleClient={jobs:async()=>{rechecks++;return rechecks===1?[old]:[fresh];},upload:async()=>{if(first){first=false;return 'stale';}return 'ready';}};
const staleEvents=[];const staleResult=await run({client:staleClient,synthesize:async()=>mp3,log:event=>staleEvents.push(event)});
assert.equal(rechecks,2);assert.equal(staleResult.stale,1);assert.equal(staleResult.uploaded,1);

const conflict=fakeApi({uploadStatus:409});const conflictClient=createClient({env,fetchImpl:conflict.fetchImpl});
assert.equal(await conflictClient.upload(job('brief'),mp3),'stale');assert.equal(conflict.calls.filter(c=>c.url.includes('.mp3')).length,0);
const mismatched=fakeApi({readback:new Uint8Array(256)});await assert.rejects(createClient({env,fetchImpl:mismatched.fetchImpl}).upload(job('brief'),mp3),/AUDIO_READBACK_MISMATCH/);
const denied=fakeApi({uploadStatus:403});await assert.rejects(createClient({env,fetchImpl:denied.fetchImpl}).upload(job('brief'),mp3),/NARRATION_AUTH_DENIED/);
await assert.rejects(client.upload(job('brief'),new Uint8Array(256)),/INVALID_GENERATED_MP3/);
const retryApi=fakeApi({failFirstGet:true});assert.equal((await createClient({env,fetchImpl:retryApi.fetchImpl,sleep:async()=>{}}).jobs()).length,2);

// Deployments can redirect the original public alias to this explicitly pinned
// canonical route. Exercise every real audio operation through that route.
const routedOrigin='https://indesignal.pewerboy7.chatgpt.site';
function routedApi({api=fakeApi({portalOrigin:routedOrigin,lists:[[job('brief')]]}),failPostOnce=false,failNetworkOnce=false}={}){
  const calls=[];let failedPost=false,failedNetwork=false;
  const fetchImpl=async(url,options={})=>{
    const u=new URL(url);calls.push({url:String(url),options,headers:new Headers(options.headers)});
    if(u.origin===ORIGIN)return new Response(null,{status:options.method==='POST'?308:307,headers:{Location:routedOrigin+u.pathname+u.search}});
    if(u.origin===routedOrigin&&failNetworkOnce&&!failedNetwork){failedNetwork=true;throw Error('temporary network failure');}
    if(u.origin===routedOrigin&&options.method==='POST'&&failPostOnce&&!failedPost){failedPost=true;return json({},503);}
    return api.fetchImpl(url,options);
  };
  return {fetchImpl,calls,api};
}
const routed=routedApi(),routedClient=createClient({env,fetchImpl:routed.fetchImpl,sleep:async()=>{}}),uploadBytes=Buffer.from(mp3);
assert.equal((await routedClient.jobs())[0].id,'brief');
assert.equal(await routedClient.upload(job('brief'),uploadBytes),'ready');
const routedCalls=routed.calls.filter(c=>!c.url.startsWith('https://pipelines.'));
assert.equal(routedCalls.length,8,'jobs, upload, HEAD and byte readback each use one validated redirect');
for(const [i,method] of ['GET','POST','HEAD','GET'].entries()){
  const initial=routedCalls[i*2],destination=routedCalls[i*2+1];
  assert.equal(new URL(initial.url).origin,ORIGIN);assert.equal(new URL(destination.url).origin,routedOrigin);
  assert.equal(new URL(initial.url).pathname+new URL(initial.url).search,new URL(destination.url).pathname+new URL(destination.url).search);
  assert.equal(initial.options.method||'GET',method);assert.equal(destination.options.method||'GET',method);
  assert.equal(initial.options.redirect,'manual');assert.equal(destination.options.redirect,'manual');
  assert.equal(initial.headers.get('Authorization'),destination.headers.get('Authorization'));
  assert.equal(initial.options.body,destination.options.body);
}
assert.ok(routedCalls.filter(c=>c.options.method==='POST').every(c=>c.options.body===uploadBytes),'the identical replayable MP3 buffer is forwarded unchanged');
assert.ok(routedCalls.filter(c=>c.url.includes('.mp3')).every(c=>c.headers.get('Authorization')===null),'public verification never receives the upload token');
assert.equal(AUDIENCE,ORIGIN+'/api/editorial/narration','canonical transport does not change the stable OIDC audience');

for(const mode of ['http','network']){
  const retryRoute=routedApi({api:fakeApi({portalOrigin:routedOrigin,failFirstGet:mode==='http'}),failNetworkOnce:mode==='network'}),sleeps=[];
  assert.equal((await createClient({env,fetchImpl:retryRoute.fetchImpl,sleep:async ms=>sleeps.push(ms)}).jobs()).length,2);
  assert.deepEqual(sleeps,[1000]);
  assert.equal(retryRoute.calls.filter(c=>!c.url.startsWith('https://pipelines.')).length,4,'a transient failure retries the full validated route');
}
const postRetry=routedApi({failPostOnce:true}),postSleeps=[];
assert.equal(await createClient({env,fetchImpl:postRetry.fetchImpl,sleep:async ms=>postSleeps.push(ms)}).upload(job('brief'),uploadBytes),'ready');
assert.deepEqual(postSleeps,[1000]);
assert.equal(postRetry.calls.filter(c=>c.options.method==='POST').length,4);
assert.ok(postRetry.calls.filter(c=>c.options.method==='POST').every(c=>c.options.body===uploadBytes),'retries also retain exact MP3 bytes');

const jobsPath='/api/editorial/narration/jobs';
for(const [status,location] of [
  [301,routedOrigin+jobsPath],[302,routedOrigin+jobsPath],[303,routedOrigin+jobsPath],
  [307,'https://attacker.example'+jobsPath],[307,'https://indesignal.other.chatgpt.site'+jobsPath],
  [307,routedOrigin+'/login'],[307,routedOrigin+jobsPath+'/extra'],[307,routedOrigin+jobsPath+'?changed=1'],
  [307,routedOrigin+jobsPath+'#fragment'],[307,routedOrigin.replace('https:','http:')+jobsPath],
  [307,routedOrigin.replace('https://','https://user:password@')+jobsPath],
  [307,routedOrigin+':8443'+jobsPath],[307,'http://[invalid'],[307,undefined]
]){
  const siteCalls=[];
  const unsafeClient=createClient({env,sleep:async()=>{throw Error('unsafe redirects must not retry');},fetchImpl:async(url,options)=>{
    if(String(url).startsWith('https://pipelines.')){assert.equal(options.redirect,'error');return json({value:'header.payload.signature'});}
    siteCalls.push({url:String(url),options});return new Response(null,{status,headers:location===undefined?{}:{Location:location}});
  }});
  await assert.rejects(unsafeClient.jobs(),error=>error.code==='SITE_REDIRECT_DENIED'&&error.fatal===true);
  assert.equal(siteCalls.length,1,'invalid destinations never receive a second request or bearer token');
  assert.equal(new URL(siteCalls[0].url).origin,ORIGIN);
}
const loopCalls=[];
const loopClient=createClient({env,sleep:async()=>{throw Error('redirect loops must not retry');},fetchImpl:async(url,options)=>{
  if(String(url).startsWith('https://pipelines.'))return json({value:'header.payload.signature'});
  const u=new URL(url);loopCalls.push(String(url));return new Response(null,{status:307,headers:{Location:(u.origin===ORIGIN?routedOrigin:ORIGIN)+u.pathname+u.search}});
}});
await assert.rejects(loopClient.jobs(),error=>error.code==='SITE_REDIRECT_LOOP'&&error.fatal===true);
assert.equal(loopCalls.length,2,'a cycle stops at the second pinned origin without retrying or exceeding the hop bound');

const changedHashApi=fakeApi({portalOrigin:routedOrigin}),changedHashCalls=[];
await assert.rejects(createClient({env,fetchImpl:async(url,options)=>{
  const u=new URL(url);changedHashCalls.push({url:String(url),options});
  if(u.origin===ORIGIN)return new Response(null,{status:307,headers:{Location:routedOrigin+u.pathname+(u.pathname.endsWith('.mp3')?'?v='+'0'.repeat(64):u.search)}});
  return changedHashApi.fetchImpl(url,options);
}}).upload(job('brief'),uploadBytes),error=>error.code==='SITE_REDIRECT_DENIED'&&error.fatal===true);
assert.equal(changedHashCalls.filter(c=>new URL(c.url).origin===routedOrigin&&c.options.method==='HEAD').length,0,'an altered MP3 version hash is rejected before the destination request');
const offlineCalls=[],offlineSleeps=[];
await assert.rejects(createClient({env,sleep:async ms=>offlineSleeps.push(ms),fetchImpl:async(url,options)=>{
  if(String(url).startsWith('https://pipelines.'))return json({value:'header.payload.signature'});
  const u=new URL(url);offlineCalls.push(String(url));
  if(u.origin===ORIGIN)return new Response(null,{status:307,headers:{Location:routedOrigin+u.pathname+u.search}});
  throw Error('offline');
}}).jobs(),/SITE_CONNECTION_FAILED/);
assert.equal(offlineCalls.length,6,'each of at most three attempts follows only one validated alias hop');assert.deepEqual(offlineSleeps,[1000,2000]);

assert.doesNotThrow(()=>createClient({env}),'GitHub OIDC is the only credential needed');
await assert.rejects(createClient({env:{...env,ACTIONS_ID_TOKEN_REQUEST_URL:'https://attacker.example/token'},fetchImpl:api.fetchImpl}).jobs(),/INVALID_GITHUB_OIDC_URL/);
const safeEvents=[];await run({client:{jobs:async()=>[job('brief')],upload:async()=>{throw Error(secret);}},synthesize:async()=>mp3,log:event=>safeEvents.push(event)});assert.doesNotMatch(JSON.stringify(safeEvents),/private-site-service/);

const workflow=await readFile(new URL('./.github/workflows/narration.yml',import.meta.url),'utf8');
assert.match(workflow,/id-token: write/);assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/pull_request|upload-artifact/);assert.match(workflow,/cancel-in-progress: false/);assert.match(workflow,/timeout-minutes: 120/);
assert.equal((workflow.match(/uses: actions\/[^@]+@[a-f0-9]{40}/g)||[]).length,3);
assert.match(workflow,/cron: '7,22,37,52 \* \* \* \*'/);
assert.ok(workflow.indexOf('run: node run.mjs --check')<workflow.indexOf('name: Install pinned package manager'));
for(const name of ['Install pinned package manager','Restore public model files','Install dependencies','Check audio encoder','Generate and publish missing audio']){
  const section=workflow.slice(workflow.indexOf('- name: '+name)).split(/\n      - name:/)[0];
  assert.match(section,/if: steps\.pending\.outputs\.has_jobs == 'true'/,name+' skips when no audio is missing');
}
console.log('PASS: canonical jobs, brief-first publication, fresh OIDC uploads, pinned same-path 307/308 transport, rejected redirects without token leakage, loop bounds, exact byte/body readback and replay, stale-text reread, bounded retries, secret-safe logs and restricted pinned workflow.');
