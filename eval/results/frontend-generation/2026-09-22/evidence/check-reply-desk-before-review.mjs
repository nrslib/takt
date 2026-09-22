import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const [url,adapterPath,outputDirectory]=process.argv.slice(2);
if(!url||!adapterPath||!outputDirectory)throw new Error('Usage: node check-reply-desk.mjs URL ADAPTER_JSON OUTPUT_DIR');
const a=JSON.parse(await readFile(adapterPath,'utf8'));
await mkdir(outputDirectory,{recursive:true});
const browser=await chromium.launch({headless:true});
const results=[];
const loc=(p,key)=>p.locator(a[key]);
const count=async p=>Number((await loc(p,'count').innerText()).match(/\d+/)?.[0]);
const selected=async p=>loc(p,'selected').innerText();
async function waitSaved(p,value){await loc(p,'rows').first().filter({hasText:value}).waitFor();}
async function notifySave(p){await loc(p,'draft').evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true})));}
async function check(name,run){
 const p=await browser.newPage({viewport:{width:1440,height:1100}});p.setDefaultTimeout(4500);
 const errors=[];p.on('pageerror',e=>errors.push(e.message));
 try{await p.goto(url);await run(p);assert.deepEqual(errors,[]);results.push({name,status:'PASS'});}
 catch(e){results.push({name,status:'FAIL',error:e.message});await p.screenshot({path:`${outputDirectory}/failure-${results.length}.png`,fullPage:true});}
 finally{await p.close();console.log(results.at(-1));}
}
await check('一覧と詳細の選択が一致し、対象の入力に切り替わる',async p=>{
 assert.ok(await loc(p,'rows').count()>=3);const before=await selected(p);const initial=await loc(p,'draft').inputValue();
 await loc(p,'rows').nth(1).click();assert.notEqual(await selected(p),before);assert.notEqual(await loc(p,'draft').inputValue(),initial);
 await loc(p,'rows').first().click();assert.equal(await selected(p),before);assert.equal(await loc(p,'draft').inputValue(),initial);
});
await check('ボタン保存は一覧と詳細を更新する',async p=>{
 await loc(p,'draft').fill('操作検証の返信');await loc(p,'save').click();await waitSaved(p,'操作検証の返信');assert.equal(await count(p),1);assert.equal(await loc(p,'draft').inputValue(),'操作検証の返信');
});
await check('通常Enterは改行、Ctrl+Enterで保存する',async p=>{
 await loc(p,'draft').fill('上の行');await loc(p,'draft').press('End');await loc(p,'draft').press('Enter');await loc(p,'draft').pressSequentially('下の行');
 assert.equal(await loc(p,'draft').inputValue(),'上の行\n下の行');assert.equal(await count(p),0);
 await loc(p,'draft').press('Control+Enter');await waitSaved(p,'上の行');assert.equal(await count(p),1);
});
await check('Command+Enterでも保存する',async p=>{
 await loc(p,'draft').fill('Commandの検証');await loc(p,'draft').press('Meta+Enter');await waitSaved(p,'Commandの検証');assert.equal(await count(p),1);
});
await check('空白だけの入力は保存せず、修正後は保存できる',async p=>{
 await loc(p,'draft').fill('  \n ');await loc(p,'save').click();assert.equal(await count(p),0);
 assert.equal(await loc(p,'draft').getAttribute('aria-invalid'),'true');
 const ids=(await loc(p,'draft').getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);
 assert.ok(ids.length>0);assert.ok(await p.evaluate(ids=>ids.some(id=>document.getElementById(id)?.textContent?.trim()),ids));
 await loc(p,'draft').fill('修正した返信');await loc(p,'save').click();await waitSaved(p,'修正した返信');assert.equal(await count(p),1);
});
await check('連打と同一タスク内の複数通知で二重保存しない',async p=>{
 await loc(p,'draft').fill('一度だけ保存');await loc(p,'draft').evaluate(el=>{for(let i=0;i<3;i++)el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));});
 assert.equal(await count(p),1);await notifySave(p);assert.equal(await count(p),1);await waitSaved(p,'一度だけ保存');assert.equal(await count(p),1);
});
await check('保存中の対象切替要求を拒否する',async p=>{
 const before=await selected(p);await loc(p,'draft').fill('対象を固定');await loc(p,'save').click();
 await loc(p,'rows').nth(1).evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));
 assert.equal(await selected(p),before);await waitSaved(p,'対象を固定');assert.equal(await count(p),1);
});
await check('失敗後に入力を保ち、再試行で一回だけ成功する',async p=>{
 await loc(p,'draft').fill('再試行する返信');await loc(p,'failure').click();await loc(p,'save').click();
 await loc(p,'status').filter({hasText:new RegExp(a.failureText)}).waitFor();
 assert.equal(await loc(p,'draft').inputValue(),'再試行する返信');assert.equal(await count(p),1);
 await loc(p,'draft').press('Control+Enter');await waitSaved(p,'再試行する返信');assert.equal(await count(p),2);
 assert.doesNotMatch(await loc(p,'status').innerText(),new RegExp(a.failureText));
});
await check('未保存切替を取り消すと、対象と下書きが残る',async p=>{
 const before=await selected(p);await loc(p,'draft').fill('残す下書き');await loc(p,'rows').nth(1).click();await loc(p,'cancel').click();
 assert.equal(await selected(p),before);assert.equal(await loc(p,'draft').inputValue(),'残す下書き');
 await loc(p,'save').click();await waitSaved(p,'残す下書き');assert.equal(await count(p),1);
});
await check('未保存を破棄して切り替えると別対象の入力を表示する',async p=>{
 const before=await selected(p);const initial=await loc(p,'draft').inputValue();await loc(p,'draft').fill('破棄する下書き');await loc(p,'rows').nth(1).click();await loc(p,'discard').click();
 assert.notEqual(await selected(p),before);assert.notEqual(await loc(p,'draft').inputValue(),'破棄する下書き');
 await loc(p,'rows').first().click();assert.equal(await loc(p,'draft').inputValue(),initial);assert.equal(await count(p),0);
});
await check('保存済みに戻し、検索の該当なしから復帰する',async p=>{
 const initial=await loc(p,'draft').inputValue();await loc(p,'draft').fill('破棄');await loc(p,'reset').click();assert.equal(await loc(p,'draft').inputValue(),initial);
 await loc(p,'search').fill('検索結果がない専用文字列');assert.equal(await loc(p,'rows').count(),0);assert.match(await p.locator('body').innerText(),new RegExp(a.emptyText));
 await loc(p,'search').fill('');assert.ok(await loc(p,'rows').count()>=3);
});
await check('二つのヘルプ入口は同じ説明を開き、閉じると元へ戻る',async p=>{
 let content;
 for(let i=0;i<2;i++){
  const trigger=loc(p,'help').nth(i);await trigger.click();const dialog=p.getByRole('dialog');assert.equal(await dialog.count(),1);
  const current=await dialog.innerText();if(i===0)content=current;else assert.equal(current,content);
  await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.ok(await trigger.evaluate(el=>el===document.activeElement));
 }
});
async function trapped(p){
 for(const key of ['Tab','Shift+Tab'])for(let i=0;i<12;i++){
  await p.keyboard.press(key);
  const active=await p.evaluate(()=>({inside:!!document.activeElement?.closest('dialog[open],[role="dialog"],[role="alertdialog"]'),tag:document.activeElement?.tagName,id:document.activeElement?.id}));
  assert.ok(active.inside || active.tag === 'BODY', JSON.stringify(active));
 }
}
await check('ヘルプのTab/Shift+Tabが背景へ抜けない',async p=>{await loc(p,'help').first().click();await trapped(p);});
await check('未保存確認のTab/Shift+Tabが背景へ抜けない',async p=>{
 await loc(p,'draft').fill('確認する編集');await loc(p,'rows').nth(1).click();await trapped(p);assert.equal(await count(p),0);
});
await check('確認待ちの保存通知を処理側でも拒否する',async p=>{
 // First prove this exact notification path works outside confirmation.
 await loc(p,'draft').fill('入口の動作確認');await notifySave(p);await waitSaved(p,'入口の動作確認');assert.equal(await count(p),1);
 const before=await selected(p);const savedText=await loc(p,'rows').first().innerText();await loc(p,'draft').fill('確認中の下書き');await loc(p,'rows').nth(1).click();
 await notifySave(p);assert.equal(await count(p),1);assert.equal(await selected(p),before);assert.equal(await loc(p,'draft').inputValue(),'確認中の下書き');assert.equal(await loc(p,'rows').first().innerText(),savedText);
 await loc(p,'cancel').click();await notifySave(p);await waitSaved(p,'確認中の下書き');assert.equal(await count(p),2);
});
await check('狭い画面で横にはみ出さず保存できる',async p=>{
 await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await loc(p,'draft').fill('狭い画面');await loc(p,'save').click();await waitSaved(p,'狭い画面');
});
await browser.close();
const report={url,adapter:a,results,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length};
await writeFile(`${outputDirectory}/results.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,failed:report.failed}));process.exitCode=report.failed?1:0;
