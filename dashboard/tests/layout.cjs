const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs=require('fs'), assert=require('assert');
(async()=>{const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/opt/chromium/chrome',args:['--no-sandbox']}); const p=await b.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.route('**/*',r=>r.fulfill({body:JSON.stringify(r.request().url().includes('tasks/')?{log:[],usage:{total:1234,input:1000,output:234,cached:500}}:[]),contentType:'application/json'}));
await p.goto('http://hive.test');await p.setContent(fs.readFileSync('dashboard/index.html','utf8').replace(/start\(\);\s*<\/script>/,'</script>'));
await p.evaluate(async()=>{state={tasks:Array.from({length:30},(_,i)=>({id:30-i,agent_id:30-i,title:'Improve chat layout and verify mobile display '+i,status:i===4?'needs':i<8?'working':'done',why:'Waiting for input',need:'Connect the device',latest_message:i+1})),agents:[],nodes:[]};document.querySelector('#app').hidden=false;await render();await openChat(26);const box=document.querySelector('#chatlog');appendLogEntry(box,{who:'owner',text:'Please fix the dashboard',at:Date.now()});appendLogEntry(box,{who:'agent',text:'The compact layout is ready. Checking file uploads and task controls.',at:Date.now()});appendLogEntry(box,{who:'image',text:JSON.stringify({url:'api/files/42',tool:'Screenshot'}),at:Date.now()});document.querySelector('.screenshot img').src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#444"/></svg>');});
await p.evaluate(async()=>{
  state.tasks.push({id:100,agent_id:26,title:'Earlier task',status:'done'});
  updateSessions();
});
assert.equal(await p.locator('[data-session="100"]').count(),0);
await p.locator('#session-list summary').click();
assert.equal(await p.locator('[data-session="26"]').isVisible(),false);
await p.evaluate(()=>updateSessions());
assert.equal(await p.locator('[data-session="26"]').isVisible(),false);
await p.locator('#session-list summary').click();
assert.equal(await p.locator('#chat-task').getByRole('button',{name:'Drop task',exact:true}).count(),1);
await p.evaluate(async()=>{
  const original = api;
  api = async path => ({log: Array.from({length:100},(_,i)=>({id:i+1,who:'agent',text:'Message '+i+'\\n'.repeat(5)})),usage:null});
  chatAfter=0; followLatest(document.querySelector('#chatlog')); await loadChat(); api=original;
});
assert(await p.locator('#chatlog').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<2));
await p.evaluate(()=>{const el=document.querySelector('#chatlog');el.scrollTop=0;});
await p.waitForTimeout(50);
await p.evaluate(async()=>{const original=api;api=async()=>({log:[{id:101,who:'agent',text:'New message'}]});await loadChat();api=original;});
assert.equal(await p.locator('#chatlog').evaluate(el=>el.scrollTop),0);
for(const width of [320,390,768,1440]){await p.setViewportSize({width,height:850});assert.equal(await p.evaluate(()=>document.body.scrollWidth>innerWidth),false);assert((await p.locator('.screenshot img').boundingBox()).height<=260);assert((await p.locator('.composer').last().boundingBox()).y<850);await p.screenshot({path:`/tmp/hive-layout-chat-${width}.png`});}
assert.equal(await p.locator('[data-session]').first().getAttribute('data-session'),'26');assert((await p.locator('[data-session]').first().boundingBox()).height<=44);
await p.locator('.composer input[type=file]').last().setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('test')});assert.equal(await p.locator('.attachment').last().innerText(),'notes.txt\nRemove');await p.evaluate(()=>{tab='Tasks';return render()});assert.equal(await p.locator('.task-board section h2').first().innerText(),'Needs me 1');assert.equal(await p.locator('.task-row').count(),8);await p.getByRole('button',{name:'Done',exact:true}).click();assert.equal(await p.locator('.task-row').count(),23);await p.screenshot({path:'/tmp/hive-layout-tasks.png'});assert.deepEqual(errors,[]);console.log('Desktop/mobile bounds, compact priority, timestamps, document attachments and task filtering passed');await b.close();})();
