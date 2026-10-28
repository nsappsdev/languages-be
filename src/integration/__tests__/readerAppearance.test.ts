import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { startTestServer, createTestAdminUser, prisma, config, TestServer } from './helpers/authoringTestApp';
import { inspectFont } from '../../lib/readerFonts';

const bytes=fs.readFileSync(path.resolve('src/integration/__tests__/fixtures/NotoSansArmenian.ttf'));
describe('reader font library and global lesson appearance',()=>{
  let server:TestServer,token:string,learnerToken:string,fontId:string;
  before(async()=>{
    server=await startTestServer();token=(await createTestAdminUser()).token;
    const learner=await prisma.user.create({data:{email:`font-${crypto.randomUUID()}@example.test`,name:'Font reader',role:'learner'}});
    learnerToken=jwt.sign({sub:learner.id},config.jwtSecret,{expiresIn:'1h'});
  });
  after(async()=>{await prisma.appSettings.updateMany({where:{id:'global'},data:{mainTextFontId:null,translationFontId:null,translationFontMinSize:8,translationFontMaxSize:15,translationFontSize:12,translationLetterSpacingMin:-0.2,translationLetterSpacingMax:0.8}});await server.close();await prisma.$disconnect();});
  async function api(endpoint:string,method='GET',body?:unknown,auth=token){
    const response=await fetch(server.baseUrl+'/api'+endpoint,{method,headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json().catch(()=>null) as any};
  }
  const upload=(auth?:string)=>api('/admin/reader-fonts','POST',{label:'Noto Armenian — Regular',fileName:'NotoSansArmenian.ttf',base64:bytes.toString('base64')},auth);
  it('validates actual font contents and both alphabets, rejecting disguised or corrupt files',()=>{
    assert.equal(inspectFont(bytes,'font.ttf').supportsArmenian,true);
    assert.equal(inspectFont(bytes,'font.ttf').supportsEnglish,true);
    assert.throws(()=>inspectFont(bytes,'font.otf'));
    assert.throws(()=>inspectFont(Buffer.from('not a font'),'font.ttf'));
    const bad=Buffer.alloc(512);bad.writeUInt32BE(0x10000);assert.throws(()=>inspectFont(bad,'font.ttf'));
    assert.throws(()=>inspectFont(Buffer.alloc(3*1024*1024+1),'font.ttf'));
  });
  it('restricts uploads and catalog changes to admins, deduplicates files and serves authenticated immutable bytes',async()=>{
    assert.equal((await upload('')).status,401);assert.equal((await upload(learnerToken)).status,403);
    const uploaded=await upload();assert.equal(uploaded.status,201);fontId=uploaded.body.font.id;
    assert.equal(uploaded.body.font.supportsArmenian,true);assert.equal(uploaded.body.font.available,true);
    assert.equal((await upload()).body.font.id,fontId);
    assert.equal((await api('/admin/reader-fonts','GET',undefined,learnerToken)).status,403);
    assert.equal((await api('/admin/reader-fonts')).body.fonts.some((f:any)=>f.id===fontId),true);
    const url=server.baseUrl+`/api/reader-fonts/${fontId}/content`;
    assert.equal((await fetch(url)).status,401);
    const download=await fetch(url,{headers:{authorization:`Bearer ${learnerToken}`}});
    assert.equal(download.status,200);assert.match(download.headers.get('content-type')!,/font\/ttf/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    assert.equal((await fetch(url,{headers:{authorization:`Bearer ${learnerToken}`,'If-None-Match':download.headers.get('etag')!}})).status,304);
    assert.equal((await api(`/admin/reader-fonts/${fontId}`,'PATCH',{archived:false})).status,200);
  });
  it('saves only appearance fields, preserves playback settings and keeps legacy clients on a system fallback',async()=>{
    const current=(await api('/settings')).body.settings;
    assert.equal((await api('/settings','PATCH',{mainTextFontId:fontId,translationFontId:fontId,mainTextLineHeight:1.6,translationLineHeight:1.4,translationGap:8,readingRowGap:14,expectedUpdatedAt:current.updatedAt},learnerToken)).status,403);
    const result=await api('/settings','PATCH',{mainTextFontId:fontId,translationFontId:fontId,mainTextLineHeight:1.6,translationLineHeight:1.4,translationGap:8,readingRowGap:14,expectedUpdatedAt:current.updatedAt});
    assert.equal(result.status,200);
    assert.deepEqual(result.body.settings.readingModes,current.readingModes);assert.equal(result.body.settings.wordRepetitionPauseMs,current.wordRepetitionPauseMs);
    assert.equal(result.body.settings.mainTextFontFamily,'System');assert.equal(result.body.settings.translationFontFamily,'System');
    const read=(await api('/settings','GET',undefined,learnerToken)).body.settings;
    assert.equal(read.readerFonts.mainText.id,fontId);assert.equal(read.readerFonts.translation.id,fontId);assert.equal(read.translationGap,8);assert.equal(read.readingRowGap,14);
    assert.equal((await api('/settings','PATCH',{readingRowGap:20,expectedUpdatedAt:current.updatedAt})).status,409);
    assert.equal((await api(`/admin/reader-fonts/${fontId}`,'PATCH',{archived:true})).status,409);
    assert.equal((await api('/settings','PATCH',{mainTextFontId:'not-a-font'})).status,400);
    assert.equal((await api('/settings','PATCH',{translationGap:-1})).status,400);
  });
  it('validates partial changes against saved bounds and accepts the minimum translation size exposed by admin',async()=>{
    assert.equal((await api('/settings','PATCH',{translationFontMinSize:6,translationFontMaxSize:6,translationFontSize:6})).status,200);
    assert.equal((await api('/settings','PATCH',{translationFontMinSize:7})).status,400);
    assert.equal((await api('/settings','PATCH',{translationLetterSpacingMin:0,translationLetterSpacingMax:0.5})).status,200);
    assert.equal((await api('/settings','PATCH',{translationLetterSpacingMax:-1})).status,400);
    assert.equal((await api('/settings')).body.settings.translationFontMinSize,6);
  });
  it('renames and archives unused fonts, preserves cached-download URLs, and rejects archived selections',async()=>{
    assert.equal((await api('/settings','PATCH',{mainTextFontId:null,translationFontId:null})).status,200);
    assert.equal((await api(`/admin/reader-fonts/${fontId}`,'PATCH',{label:'Updated Armenian face',archived:true})).status,200);
    assert.equal((await api('/settings','PATCH',{translationFontId:fontId})).status,400);
    const response=await fetch(server.baseUrl+`/api/reader-fonts/${fontId}/content`,{headers:{authorization:`Bearer ${learnerToken}`}});
    assert.equal(response.status,200,'an already-open reader can still download its selected immutable font');
    assert.equal((await api(`/admin/reader-fonts/${fontId}`,'PATCH',{archived:false})).body.font.label,'Updated Armenian face');
  });
  it('serializes font assignment and archive so an archived font is never left selected',async()=>{
    await api('/settings','PATCH',{mainTextFontId:null,translationFontId:null});
    const [selection,archive]=await Promise.all([api('/settings','PATCH',{translationFontId:fontId}),api(`/admin/reader-fonts/${fontId}`,'PATCH',{archived:true})]);
    assert.ok((selection.status===200&&archive.status===409)||(selection.status===400&&archive.status===200));
    const [font,settings]=await Promise.all([prisma.readerFont.findUniqueOrThrow({where:{id:fontId}}),prisma.appSettings.findUniqueOrThrow({where:{id:'global'}})]);
    assert.ok(!(font.archivedAt&&settings.translationFontId===fontId));
  });
});
