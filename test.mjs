import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createClient,run,validateJobs,ORIGIN,AUDIENCE} from './run.mjs';
import {chunksFor} from './engine.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const job=(id,text='A new AI update. The facts are reviewed.')=>({id,text,hash:hash(text)});
const mp3=new Uint8Array(256);mp3.set([255,251,144,100]);
const secret='private-site-service-token-never-print';
const requestSecret='private-github-request-token-never-print';
const env={ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/idtoken?api-version=1',ACTIONS_ID_TOKEN_REQUEST_TOKEN:requestSecret};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fakeApi({lists=[[job('article'),job('brief')]],uploadStatus=200,readback=mp3,failFirstGet=false}={}){
  const calls=[],tokens=[];let listIndex=0,failedGet=false;
  const fetchImpl=async(url,options={})=>{
    url=String(url);const headers=new Headers(options.headers);calls.push({url,options,headers});
    if(url.startsWith('https://pipelines.actions.githubusercontent.com/')){
      assert.equal(headers.get('authorization'),'Bearer '+requestSecret);assert.equal(new URL(url).searchParams.get('audience'),AUDIENCE);
      const value='header'+(tokens.length+1)+'.payload.signature';tokens.push(value);return json({value});
    }
    assert.equal(new URL(url).origin,ORIGIN);assert.equal(options.redirect,'error');
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
assert.doesNotThrow(()=>createClient({env}),'GitHub OIDC is the only credential needed');
await assert.rejects(createClient({env:{...env,ACTIONS_ID_TOKEN_REQUEST_URL:'https://attacker.example/token'},fetchImpl:api.fetchImpl}).jobs(),/INVALID_GITHUB_OIDC_URL/);
const safeEvents=[];await run({client:{jobs:async()=>[job('brief')],upload:async()=>{throw Error(secret);}},synthesize:async()=>mp3,log:event=>safeEvents.push(event)});assert.doesNotMatch(JSON.stringify(safeEvents),/private-site-service/);

const workflow=await readFile(new URL('./.github/workflows/narration.yml',import.meta.url),'utf8');
assert.match(workflow,/id-token: write/);assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/pull_request|upload-artifact/);assert.match(workflow,/cancel-in-progress: false/);assert.match(workflow,/timeout-minutes: 120/);
assert.equal((workflow.match(/uses: actions\/[^@]+@[a-f0-9]{40}/g)||[]).length,3);
console.log('PASS: canonical jobs, brief-first publication, fresh OIDC uploads, exact byte readback, stale-text reread, bounded retries, secret-safe logs and restricted pinned workflow.');
