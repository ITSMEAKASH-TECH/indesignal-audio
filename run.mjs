import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ORIGIN='https://indesignal.vividtoad4096.chatgpt.site';
export const AUDIENCE=ORIGIN+'/api/editorial/narration';
const MAX_AUDIO=5*1024*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=text=>String(text).replace(/\s+/gu,' ').trim();
class JobError extends Error {constructor(code,fatal=false){super(code);this.code=code;this.fatal=fatal;}}

async function readBounded(response,limit){
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>limit)throw new JobError('RESPONSE_TOO_LARGE');
  if(!response.body)throw new JobError('EMPTY_RESPONSE');
  const reader=response.body.getReader(),parts=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new JobError('RESPONSE_TOO_LARGE');}parts.push(value);}
  return Buffer.concat(parts,length);
}
async function readJson(response,limit=600*1024){
  try{return JSON.parse((await readBounded(response,limit)).toString('utf8'));}
  catch(error){if(error instanceof JobError)throw error;throw new JobError('INVALID_JSON');}
}
export function validateJobs(data){
  if(!data||!Array.isArray(data.jobs)||data.jobs.length>40)throw new JobError('INVALID_JOBS');
  const seen=new Set();
  const jobs=data.jobs.map(job=>{
    if(!job||typeof job.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(job.id)||seen.has(job.id)||typeof job.text!=='string'||!job.text||job.text.length>12000||canonical(job.text)!==job.text||typeof job.hash!=='string'||!/^[a-f0-9]{64}$/.test(job.hash)||sha(job.text)!==job.hash)throw new JobError('INVALID_JOB');
    seen.add(job.id);return {id:job.id,text:job.text,hash:job.hash};
  });
  return jobs.sort((a,b)=>Number(b.id==='brief')-Number(a.id==='brief'));
}
function validMp3(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<128||bytes.byteLength>MAX_AUDIO)return false;
  let frame=0;
  if(bytes[0]===73&&bytes[1]===68&&bytes[2]===51){if(bytes.byteLength<10||bytes.slice(6,10).some(v=>v>127))return false;frame=10+((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9])+((bytes[5]&16)?10:0);}
  return frame+4<=bytes.length&&bytes[frame]===255&&(bytes[frame+1]&224)===224&&(bytes[frame+1]&24)!==8&&(bytes[frame+1]&6)!==0&&(bytes[frame+2]&240)!==0&&(bytes[frame+2]&240)!==240&&(bytes[frame+2]&12)!==12;
}
export function createClient({env=process.env,fetchImpl=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  async function request(url,options={},retry=true){
    if(!String(url).startsWith(ORIGIN+'/'))throw new JobError('UNSUPPORTED_SITE_ORIGIN',true);
    for(let attempt=0;attempt<(retry?3:1);attempt++){
      let response;
      try{response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{if(attempt===(retry?2:0))throw new JobError('SITE_CONNECTION_FAILED');await sleep(1000*2**attempt);continue;}
      if(retry&&(response.status===429||response.status>=500)&&attempt<2){await response.body?.cancel();await sleep(1000*2**attempt);continue;}
      return response;
    }
  }
  async function oidc(){
    let url;try{url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);}catch{throw new JobError('MISSING_GITHUB_OIDC',true);}
    if(url.protocol!=='https:'||!url.hostname.endsWith('.actions.githubusercontent.com')||url.username||url.password)throw new JobError('INVALID_GITHUB_OIDC_URL',true);
    const requestToken=env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if(typeof requestToken!=='string'||!requestToken||/[\r\n\0]/.test(requestToken))throw new JobError('MISSING_GITHUB_OIDC',true);
    url.searchParams.set('audience',AUDIENCE);
    let response;try{response=await fetchImpl(url.href,{headers:{Authorization:'Bearer '+requestToken},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new JobError('GITHUB_OIDC_CONNECTION_FAILED',true);}
    if(!response.ok)throw new JobError('GITHUB_OIDC_DENIED',true);
    const data=await readJson(response,16000);
    if(typeof data.value!=='string'||data.value.length>14000||data.value.split('.').length!==3||/[\r\n\0]/.test(data.value))throw new JobError('INVALID_GITHUB_OIDC_TOKEN',true);
    return data.value;
  }
  const headers=async()=>({Authorization:'Bearer '+await oidc(),'User-Agent':'Indesignal-Audio-Publisher/1.0'});
  async function jobs(){
    const response=await request(ORIGIN+'/api/editorial/narration/jobs',{headers:await headers()});
    if(!response.ok)throw new JobError(response.status===401||response.status===403?'NARRATION_AUTH_DENIED':'JOBS_UNAVAILABLE',response.status===401||response.status===403);
    return validateJobs(await readJson(response));
  }
  async function upload(job,audio){
    if(!validMp3(audio))throw new JobError('INVALID_GENERATED_MP3');
    // Refresh after generation: a full story can outlast the five-minute JWT.
    const response=await request(ORIGIN+'/api/editorial/narration/'+encodeURIComponent(job.id),{method:'POST',headers:{...await headers(),'Content-Type':'audio/mpeg','X-Narration-Hash':job.hash},body:audio});
    if(response.status===409){await response.body?.cancel();return 'stale';}
    if(!response.ok)throw new JobError(response.status===401||response.status===403?'NARRATION_AUTH_DENIED':'UPLOAD_FAILED',response.status===401||response.status===403);
    const result=await readJson(response,16000);if(result.code!=='AUDIO_READY')throw new JobError('UPLOAD_NOT_READY');
    const publicUrl=ORIGIN+'/api/narration/'+encodeURIComponent(job.id)+'.mp3?v='+job.hash;
    const publicHeaders={'User-Agent':'Indesignal-Audio-Publisher/1.0'};
    const head=await request(publicUrl,{method:'HEAD',headers:publicHeaders});
    if(!head.ok||head.headers.get('content-type')?.split(';')[0]!=='audio/mpeg'||Number(head.headers.get('content-length'))!==audio.byteLength)throw new JobError('AUDIO_HEAD_MISMATCH');
    const read=await request(publicUrl,{headers:publicHeaders});
    if(!read.ok||sha(await readBounded(read,MAX_AUDIO))!==sha(audio))throw new JobError('AUDIO_READBACK_MISMATCH');
    return 'ready';
  }
  return {jobs,upload};
}
export async function run({client,synthesize,log=event=>process.stdout.write(JSON.stringify(event)+'\n')}={}){
  if(!client)client=createClient();
  let queue=await client.jobs(),uploaded=0,stale=0,failed=0,rechecked=false;
  const seen=new Set();let synth=synthesize;
  log({event:'pending',count:queue.length});
  while(queue.length){
    const job=queue.shift(),key=job.id+':'+job.hash;if(seen.has(key))continue;seen.add(key);
    try{
      if(!synth){try{const {createSynthesizer}=await import('./engine.mjs');synth=await createSynthesizer();}catch{throw new JobError('VOICE_ENGINE_UNAVAILABLE',true);}}
      const audio=await synth(job);
      const result=await client.upload(job,audio);
      if(result==='stale'){
        stale++;log({event:'superseded',id:job.id});
        if(!rechecked){rechecked=true;const fresh=await client.jobs();const additional=fresh.filter(next=>!seen.has(next.id+':'+next.hash));queue=additional.concat(queue);}
      }else{uploaded++;log({event:'published',id:job.id,bytes:audio.byteLength});}
    }catch(error){if(error?.fatal)throw error;failed++;log({event:'failed',id:job.id,code:error instanceof JobError?error.code:'GENERATION_FAILED'});}
  }
  const result={event:'complete',uploaded,stale,failed};log(result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  run().then(result=>{if(result.failed)process.exitCode=1;}).catch(error=>{process.stderr.write(JSON.stringify({event:'failed',code:error instanceof JobError?error.code:'AUDIO_JOB_FAILED'})+'\n');process.exitCode=1;});
}
