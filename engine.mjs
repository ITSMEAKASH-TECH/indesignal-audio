import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {availableParallelism} from 'node:os';
import {spawn} from 'node:child_process';

const HERE=dirname(fileURLToPath(import.meta.url));
const MODEL='onnx-community/Kokoro-82M-v1.0-ONNX';
const RATE=24000;
export function chunksFor(text,max=280){
  const chunks=[];
  for(const {segment} of new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)){
    let next='';
    for(const word of segment.trim().split(/\s+/u)){
      if(word.length>max)throw new Error('Narration contains a token too long to synthesize');
      if(next&&next.length+word.length+1>max){chunks.push(next);next=word;}else next=next?next+' '+word:word;
    }
    if(next)chunks.push(next);
  }
  const packed=[];for(const chunk of chunks){const last=packed.at(-1);if(last&&last.length+chunk.length+1<=max)packed[packed.length-1]+=' '+chunk;else packed.push(chunk);}return packed;
}
function wavHeader(samples){
  const buffer=Buffer.alloc(44);buffer.write('RIFF');buffer.writeUInt32LE(36+samples*2,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(RATE,24);buffer.writeUInt32LE(RATE*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);return buffer;
}
async function encode(wavPath,mp3Path){
  await new Promise((yes,no)=>{
    const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-y','-i',wavPath,'-map_metadata','-1','-ac','1','-ar','24000','-c:a','libmp3lame','-b:a','64k',mp3Path],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    // Do not print raw child errors, paths, narration or inherited environment.
    child.stderr.resume();child.once('error',()=>no(new Error('Audio encoding could not start')));child.once('exit',code=>code===0?yes():no(new Error('Audio encoding failed')));
  });
}
export async function createSynthesizer(){
  const [{KokoroTTS,env},transformers]=await Promise.all([import('kokoro-js'),import('@huggingface/transformers')]);
  const cache=join(HERE,'model-cache'),temporary=join(HERE,'.tmp');await mkdir(cache,{recursive:true});await mkdir(temporary,{recursive:true});env.cacheDir=cache;transformers.env.cacheDir=cache;
  const threads=Math.min(4,availableParallelism());
  const [model,tokenizer]=await Promise.all([
    transformers.StyleTextToSpeech2Model.from_pretrained(MODEL,{dtype:'q8',device:'cpu',cache_dir:cache,session_options:{intraOpNumThreads:threads,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all'}}),
    transformers.AutoTokenizer.from_pretrained(MODEL,{cache_dir:cache})
  ]);
  const tts=new KokoroTTS(model,tokenizer);
  return async job=>{
    const wav=join(temporary,job.hash+'.wav'),mp3=join(temporary,job.hash+'.mp3');
    try{
      const chunks=chunksFor(job.text),segments=[];let total=0;
      for(let index=0;index<chunks.length;index++){
        const result=await tts.generate(chunks[index],{voice:'af_heart',speed:1});
        if(result.sampling_rate!==RATE||!(result.audio instanceof Float32Array)||!result.audio.length)throw new Error('Invalid voice output');
        const pcm=Buffer.alloc(result.audio.length*2);let energy=0;
        for(let i=0;i<result.audio.length;i++){const sample=result.audio[i];if(!Number.isFinite(sample))throw new Error('Invalid voice output');energy+=sample*sample;const clipped=Math.max(-1,Math.min(1,sample));pcm.writeInt16LE(Math.round(clipped<0?clipped*32768:clipped*32767),i*2);}
        if(!energy)throw new Error('Empty voice output');segments.push(pcm);total+=result.audio.length;
        if(index<chunks.length-1){const silence=Buffer.alloc(Math.round(RATE*.07)*2);segments.push(silence);total+=silence.length/2;}
        if(total>RATE*600)throw new Error('Narration exceeds ten minutes');
      }
      await writeFile(wav,Buffer.concat([wavHeader(total),...segments]));await encode(wav,mp3);const bytes=await readFile(mp3);if(bytes.length>5*1024*1024)throw new Error('Encoded narration exceeds upload limit');return bytes;
    }finally{await Promise.all([wav,mp3].map(file=>unlink(file).catch(()=>{})));}
  };
}
