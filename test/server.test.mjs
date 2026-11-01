import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

async function freePort() {
  return await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
}

test('HTTP MVP workflow creates an event and records tasks, vendors, quotes, guests and expenses', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'eventpilot-test-'));
  const port = await freePort();
  const child = spawn(process.execPath,['server.mjs'],{cwd:path.resolve('.'),env:{...process.env,PORT:String(port),EVENTPILOT_DATA_DIR:dir,EVENTPILOT_AI_PROVIDER:'none',GEMINI_API_KEY:''},stdio:'ignore'});
  t.after(async()=>{child.kill('SIGTERM');await rm(dir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${port}`;
  let healthPayload;
  let ready = false;
  for(let i=0;i<50;i++){try{const r=await fetch(`${base}/api/health`);if(r.ok){healthPayload=await r.json();ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.equal(ready,true,'server should start');assert.ok(['local_model_ready','remote_model_ready','runtime_unavailable','model_missing','no_credentials'].includes(healthPayload.ai.status));assert.equal(healthPayload.fallbackAvailable,true);
  const home=await fetch(base);assert.equal(home.status,200);assert.match(await home.text(),/EventPilot AI/);assert.match(home.headers.get('content-security-policy')||'',/default-src 'self'/);
  const appScript=await fetch(`${base}/app.js`);assert.equal(appScript.status,200);assert.match(await appScript.text(),/renderOverview/);
  const post = async(url,data)=>{const r=await fetch(`${base}${url}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const json=await r.json();assert.ok(r.ok,json.error);return json;};
  const planResponse=await fetch(`${base}/api/plan`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Plan test',type:'community',city:'Kolkata',guests:80,budget:100000})});const plan=await planResponse.json();assert.equal(planResponse.status,200);assert.ok(['rules-fallback','local-ollama'].includes(plan.mode));assert.ok(plan.tasks.length>0);
  // With no AI provider the plan must stay deterministic and still populate every section.
  assert.equal(plan.mode,'rules-fallback');assert.equal(plan.aiGenerated,false);assert.equal(plan.aiStatus,'no_credentials');
  assert.ok(plan.strategy.overview.length>10&&plan.strategy.priorities.length>0);assert.ok(plan.risks.length>0);assert.ok(plan.vendorRequirements.length>0&&plan.vendorRequirements[0].why);
  assert.equal(plan.categories.reduce((sum,c)=>sum+Math.round(c.allocation*100),0),10000000);
  const blocked=await fetch(`${base}/api/events`,{method:'POST',headers:{'content-type':'application/json','origin':'https://attacker.invalid'},body:JSON.stringify({name:'Should not save',type:'wedding',city:'Kolkata',guests:1,budget:100})});assert.equal(blocked.status,403);
  const [event,parallelEvent]=await Promise.all([
    post('/api/events',{name:'Test wedding',type:'wedding',city:'Kolkata',date:'2027-02-01',guests:100,budget:500000}),
    post('/api/events',{name:'Parallel birthday',type:'birthday',city:'Kolkata',date:'2027-03-01',guests:20,budget:50000})
  ]);
  assert.equal(event.currency,'INR');assert.equal(event.guestsCount,100);assert.equal(event.categories.reduce((a,c)=>a+c.allocation,0),500000);
  const task=await post(`/api/events/${event.id}/tasks`,{title:'Book photographer',priority:'high'});assert.equal(task.tasks.length,event.tasks.length+1);const invalidTask=await fetch(`${base}/api/events/${event.id}/tasks`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Invalid date',dueDate:'2027-02-31'})});assert.equal(invalidTask.status,400);
  const category=await post(`/api/events/${event.id}/categories`,{name:'Transport',allocation:15000});assert.ok(category.categories.some(c=>c.name==='Transport'));const categoryId=category.categories.find(c=>c.name==='Transport').id;const categoryEdit=await fetch(`${base}/api/events/${event.id}/categories`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:categoryId,name:'Guest transport',allocation:18000})}).then(r=>r.json());assert.ok(categoryEdit.categories.some(c=>c.name==='Guest transport'&&c.allocation===18000));const categoryDelete=await fetch(`${base}/api/events/${event.id}/categories`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:categoryId})});assert.equal(categoryDelete.status,200);
  const vendor=await post(`/api/events/${event.id}/vendors`,{name:'Sample Caterer',category:'Catering'});assert.equal(vendor.vendors.length,1);
  const pdfData=`data:application/pdf;base64,${Buffer.from('%PDF-1.4\n').toString('base64')}`;const quote=await post(`/api/events/${event.id}/quotations`,{vendorId:vendor.vendors[0].id,amount:25000,note:'Per plate and service',fileData:pdfData});assert.equal(quote.quotations.length,1);assert.equal(quote.quotations[0].file.size,9);const uploads=await readdir(path.join(dir,'private-uploads'));assert.equal(uploads.length,1);
  const badFile=await fetch(`${base}/api/events/${event.id}/quotations`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({vendorId:vendor.vendors[0].id,amount:10,fileData:'data:application/pdf;base64,SGVsbG8='})});assert.equal(badFile.status,400);
  const expenseKey='9b8c7d6e-5f4a-4321-9876-123456789abc';const expense=await post(`/api/events/${event.id}/expenses`,{description:'Venue advance',amount:10000,categoryId:event.categories[0].id,idempotencyKey:expenseKey});assert.equal(expense.summary.spent,10000);const protectedCategoryDelete=await fetch(`${base}/api/events/${event.id}/categories`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:event.categories[0].id})});assert.equal(protectedCategoryDelete.status,409);const duplicate=await post(`/api/events/${event.id}/expenses`,{description:'Venue advance',amount:10000,categoryId:event.categories[0].id,idempotencyKey:expenseKey});assert.equal(duplicate.expenses.length,1);assert.equal(duplicate.summary.spent,10000);const keyConflict=await fetch(`${base}/api/events/${event.id}/expenses`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({description:'Different expense',amount:500,categoryId:event.categories[0].id,idempotencyKey:expenseKey})});assert.equal(keyConflict.status,409);
  const guest=await post(`/api/events/${event.id}/guests`,{name:'Guest One',contact:'not-a-real-contact'});assert.equal(guest.guests.length,1);
  const list=await fetch(`${base}/api/events`).then(r=>r.json());assert.equal(list.length,2);assert.ok(list.some(x=>x.id===parallelEvent.id));
  const invalid=await fetch(`${base}/api/events/${event.id}/expenses`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({description:'Bad category',amount:10,categoryId:'not-owned'})});assert.equal(invalid.status,400);
  const oversized=await fetch(`${base}/api/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({padding:'x'.repeat(8*1024*1024)})});assert.equal(oversized.status,413);
});

test('AI proposal is server-bound, event-bound, single-use and cannot be spoofed by clients', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'eventpilot-ai-token-'));
  const ollamaPort = await freePort();
  const ollama = spawn(process.execPath,['-e',`const http=require('node:http');const server=http.createServer(async(req,res)=>{if(req.url==='/api/tags'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({models:[{name:'qwen2.5:3b'}]}));}if(req.url==='/api/chat'){let raw='';for await(const c of req)raw+=c;const proposal=${JSON.stringify({assumptions:[],missingInformation:[],budgetCategories:[{name:'Venue',sharePercent:60,rationale:'Space'},{name:'Food',sharePercent:40,rationale:'Meals'}],tasks:[{title:'Confirm venue',description:'Review venue options',relativeDeadlineDays:14,priority:'high',rationale:'Lead time'}],ideas:[{title:'Theme',description:'Use a coherent visual theme',personalizationReason:'Event type'}],vendorChecklist:[{category:'Catering',whatToVerify:['Menu','Tax']}],risks:[{risk:'Rain',mitigation:'Indoor backup'}]})};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'qwen2.5:3b',message:{content:JSON.stringify(proposal)}}));return;}res.writeHead(404);res.end();});server.listen(${ollamaPort},'127.0.0.1');process.on('SIGTERM',()=>server.close());`],{stdio:'ignore'});
  const port = await freePort();
  const app = spawn(process.execPath,['server.mjs'],{cwd:path.resolve('.'),env:{...process.env,PORT:String(port),EVENTPILOT_DATA_DIR:dir,EVENTPILOT_AI_PROVIDER:'ollama',GEMINI_API_KEY:'',OLLAMA_URL:`http://127.0.0.1:${ollamaPort}`,OLLAMA_MODEL:'qwen2.5:3b'},stdio:'ignore'});
  t.after(async()=>{app.kill('SIGTERM');ollama.kill('SIGTERM');await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<60;i++){try{const r=await fetch(`${base}/api/health`);if(r.ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.equal(ready,true,'app and mock Ollama should start');
  const input={name:'AI proposal test',type:'birthday',city:'Kolkata',date:'2027-05-01',guests:80,budget:100000};
  const planResponse=await fetch(`${base}/api/plan`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  const plan=await planResponse.json();assert.equal(plan.mode,'local-ollama');assert.ok(plan.proposalId);assert.equal(plan.aiProposal.budgetCategories.length,2);
  const postEvent=async payload=>fetch(`${base}/api/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const mismatch=await postEvent({...input,proposalId:plan.proposalId,name:'Changed after generation'});assert.equal(mismatch.status,409);
  const savedResponse=await postEvent({...input,proposalId:plan.proposalId});assert.equal(savedResponse.status,201);
  const saved=await savedResponse.json();assert.equal(saved.planSource,'ai-suggestion');assert.equal(saved.aiModel,'qwen2.5:3b');assert.deepEqual(saved.categories.map(c=>c.name),['Venue','Food']);assert.equal(saved.tasks[0].source,'ai-suggestion');
  const replay=await postEvent({...input,proposalId:plan.proposalId});assert.equal(replay.status,410);
  const spoof=await postEvent({...input,aiProposal:plan.aiProposal,aiModel:'fake-model'});assert.equal(spoof.status,201);const spoofed=await spoof.json();assert.equal(spoofed.planSource,'template');assert.equal(spoofed.aiModel,null);
});
