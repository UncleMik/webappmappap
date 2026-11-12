import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playbackSampler, prepareCourseEmbed } from '../Фронт/course-embed-points.js?v=20261112-stars';

test('provider media sampling counts only observed playback, excludes seeks, repeats, ads and hidden media',()=>{
 globalThis.window={frameElement:null}; globalThis.document={hidden:false};
 const frame={isConnected:true,closest:()=>null};
 const sampler=playbackSampler(frame),events=[];
 sampler.media.addEventListener('playing',()=>events.push('play'));
 sampler.state('playing');sampler.sample(0,0);sampler.sample(1,1000);sampler.sample(2,2000);
 sampler.sample(100,3000);sampler.sample(101,4000); // Seek jump excluded, new observed second included.
 sampler.state('paused');sampler.sample(102,5000);sampler.state('playing');sampler.sample(0,6000);sampler.sample(1,7000); // Repeated first second merges.
 sampler.advertising(true);sampler.sample(2,8000);sampler.sample(3,9000);sampler.advertising(false);
 sampler.sample(10,10000);sampler.sample(11,11000);
 document.hidden=true;sampler.sample(12,12000);document.hidden=false;sampler.sample(30,13000);sampler.sample(31,14000);
 frame.closest=()=>({hidden:true});sampler.sample(32,15000);frame.closest=()=>null;
 const played=sampler.media.played,values=Array.from({length:played.length},(_,i)=>[played.start(i),played.end(i)]);
 assert.deepEqual(values,[[0,2],[10,11],[30,31],[100,101]]);
 assert.equal(values.reduce((sum,[a,b])=>sum+b-a,0),5);assert.equal(events.length,2);
 sampler.state('ended');assert.equal(sampler.media.ended,true);assert.equal(sampler.media.paused,true);
});
test('YouTube enables documented JS API with origin, Rutube preserves private URL parameters',()=>{
 globalThis.location={href:'https://app.legkie-rody.ru/article.html',origin:'https://app.legkie-rody.ru'};
 const youtube=new URL(prepareCourseEmbed({provider:'youtube',url:'https://www.youtube.com/embed/abcdef'}));
 assert.equal(youtube.searchParams.get('enablejsapi'),'1');assert.equal(youtube.searchParams.get('origin'),location.origin);
 const rutube=prepareCourseEmbed({provider:'rutube',url:'https://rutube.ru/play/embed/123?p=private'});assert.equal(new URL(rutube).searchParams.get('p'),'private');
});
