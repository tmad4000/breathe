import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const script=new URL('../scripts/stamp-version.sh',import.meta.url).pathname;
function sandbox(fn){const dir=mkdtempSync(join(tmpdir(),'breathe-stamp-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
const run=(cwd,cmd,args,extra={})=>execFileSync(cmd,args,{cwd,encoding:'utf8',env:{...process.env,APP_VERSION:'',GIT_AUTHOR_NAME:'Stamp Test',GIT_COMMITTER_NAME:'Stamp Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_EMAIL:'test@example.invalid',...extra}}).trim();
test('clean deploy metadata names exact commit and committer date; dirty tree uses build time',()=>sandbox(dir=>{
 run(dir,'git',['init','-q']);writeFileSync(join(dir,'package.json'),'{"version":"2.3.4"}');run(dir,'git',['add','package.json']);run(dir,'git',['commit','-qm','fixture'],{GIT_AUTHOR_DATE:'2026-10-01T12:00:00Z',GIT_COMMITTER_DATE:'2026-10-03T14:00:00Z'});
 const a=JSON.parse(run(dir,'sh',[script,'stamp.json']));assert.equal(a.version,'2.3.4');assert.equal(a.commit,run(dir,'git',['rev-parse','HEAD']));assert.equal(Date.parse(a.commitTime),Date.parse('2026-10-03T14:00:00Z'));assert.equal(a.committerTime,a.commitTime);assert.equal(a.event,'commit');assert.ok(Number.isFinite(Date.parse(a.buildTime)));
 rmSync(join(dir,'stamp.json'));writeFileSync(join(dir,'untracked-runtime.js'),'// not in HEAD');const loose=JSON.parse(run(dir,'sh',[script,'stamp.json']));assert.equal(loose.event,'build','untracked runtime cannot claim clean commit');rmSync(join(dir,'untracked-runtime.js'));
 writeFileSync(join(dir,'package.json'),'{"version":"2.3.5"}');const b=JSON.parse(run(dir,'sh',[script,'stamp.json']));assert.equal(b.event,'build');assert.equal(b.version,'2.3.5');assert.match(b.commit,/-dirty$/);assert.ok(Number.isFinite(Date.parse(b.buildTime)));
}));
test('without Git metadata uses actual build timestamp and package version',()=>sandbox(dir=>{
 writeFileSync(join(dir,'package.json'),'{"version":"1.2.3"}');const now=Date.now(),a=JSON.parse(run(dir,'sh',[script,'version.json']));assert.equal(a.event,'build');assert.equal(a.commit,'');assert.equal(a.commitTime,'');assert.equal(a.version,'1.2.3');assert.ok(Math.abs(Date.parse(a.buildTime)-now)<3000);
}));
