import { puppeteer } from '/Users/macmini2/.npm/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp/out/Default/gen/src/third_party/index.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const out='.img2threejs/evidence/integration-gsap';
await mkdir(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
  userDataDir:'/private/tmp/nossaarte-chrome-test',args:['--no-first-run','--no-default-browser-check']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const results=[];
async function check(name,fn){await fn();results.push({name,passed:true});console.log('PASS',name);}
async function pageReady(options={}) {
  const page=await browser.newPage();
  await page.setViewport(options.mobile?{width:390,height:844,deviceScaleFactor:3,isMobile:true,hasTouch:true}:{width:1440,height:1000,deviceScaleFactor:1});
  await page.evaluateOnNewDocument(()=>document.addEventListener('logo:ready',e=>{window.logo=e.detail;window.logoFrameCount=0;
    const render=logo.renderer.render.bind(logo.renderer);logo.renderer.render=(...args)=>{window.logoFrameCount++;return render(...args);};},true));
  return page;
}
async function ready(page){await page.goto('http://127.0.0.1:8080/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('.hero-visual').dataset.logoState==='ready');await delay(1600);}
const offsets=page=>page.evaluate(()=>logo.model.parts.map(p=>p.position.clone().sub(p.userData.restPosition).toArray()));
const isRest=values=>values.every(v=>v.every(x=>Math.abs(x)<1e-7));
try {
  const page=await pageReady();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});await ready(page);
  await check('Initial exploded state and active control, transparent canvas and four actual meshes',async()=>{
    assert.equal((await offsets(page))[3][2],1.3);
    assert.equal(await page.$eval('#layers-toggle',e=>e.getAttribute('aria-pressed')),'true');
    assert.equal(await page.$eval('.hero-visual',e=>e.querySelectorAll('canvas').length),1);
    const data=await page.evaluate(()=>({alpha:logo.renderer.getContext().getContextAttributes().alpha,parts:logo.model.parts.length,
      triangles:logo.renderer.info.render.triangles,calls:logo.renderer.info.render.calls}));
    assert(data.alpha);assert.equal(data.parts,4);assert(data.triangles<20000);assert(data.calls<=12);results.push({metrics:data});
    assert.equal(await page.evaluate(()=>logo.animation.duration()),.55);
    assert.equal(await page.evaluate(()=>logo.animation.progress()),1);
  });
  await page.screenshot({path:out+'/desktop.png'});
  const box=await (await page.$('.hero-visual')).boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.move(20,20);await delay(650);
  await check('Hover interpolates, separates all four layers, keeps geometry inside canvas',async()=>{
    await page.mouse.move(box.x+box.width*.7,box.y+box.height*.4);await delay(180);
    const partial=await offsets(page);assert(Math.abs(partial[0][2])>0.03 && Math.abs(partial[0][2])<1.04);
    assert(Math.abs(partial[0][2])/1.05 > partial[3][2]/1.3, 'GSAP stagger separates the outer ring before the monogram');
    await delay(500);const full=await offsets(page);assert(Math.abs(full[0][2]+1.05)<1e-6);assert(Math.abs(full[3][2]-1.3)<1e-6);
    const fits=await page.evaluate(()=>{
      logo.model.root.updateMatrixWorld(true);const v=logo.model.root.position.clone();let max=0;
      logo.model.root.traverse(o=>{if(!o.geometry)return;const a=o.geometry.attributes.position;
        for(let i=0;i<a.count;i++){v.fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld).project(logo.camera);max=Math.max(max,Math.abs(v.x),Math.abs(v.y));}});return max;
    });assert(fits<.98);results.push({maxProjectedExtent:fits});
    await (await page.$('.hero-visual')).screenshot({path:out+'/hover.png'});
  });
  await check('Mouse leave and interrupted transitions reassemble without drift',async()=>{
    for(let i=0;i<4;i++){await page.mouse.move(20,20);await delay(60);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await delay(60);}
    await page.mouse.move(20,20);await delay(700);assert(isRest(await offsets(page)));
  });
  await check('Keyboard Enter toggles layers and Escape closes them',async()=>{
    await page.focus('#layers-toggle');await page.keyboard.press('Enter');await delay(650);assert(!isRest(await offsets(page)));
    await page.keyboard.press('Escape');await delay(650);assert(isRest(await offsets(page)));
  });
  await check('Pause stops frames but keeps layer controls usable',async()=>{
    await page.$eval('#motion-toggle',e=>e.click());await delay(100);const n=await page.evaluate(()=>logoFrameCount);await delay(180);assert.equal(await page.evaluate(()=>logoFrameCount),n);
    await page.$eval('#layers-toggle',e=>e.click());await delay(100);assert(!isRest(await offsets(page)));
    await page.$eval('#layers-toggle',e=>e.click());await page.$eval('#motion-toggle',e=>e.click());
  });
  await check('Rendering suspends offscreen and resumes when visible',async()=>{
    await page.evaluate(()=>{document.activeElement.blur();window.scrollTo(0,document.body.scrollHeight);});await delay(300);
    const n=await page.evaluate(()=>logoFrameCount);await delay(200);assert.equal(await page.evaluate(()=>logoFrameCount),n);
    assert(await page.evaluate(()=>logo.animation.paused()));
    await page.evaluate(()=>window.scrollTo(0,0));await delay(300);assert(await page.evaluate(()=>logoFrameCount)>n);
  });
  await check('Reduced motion disables idle and uses instant layer changes',async()=>{
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await delay(300);
    await page.waitForFunction(()=>document.querySelector('#motion-toggle').hidden,{timeout:5000});
    const n=await page.evaluate(()=>logoFrameCount);await delay(200);assert.equal(await page.evaluate(()=>logoFrameCount),n);
    assert(await page.$eval('#motion-toggle',e=>e.hidden));await page.$eval('#layers-toggle',e=>e.click());await delay(80);
    assert.equal((await offsets(page))[3][2],1.3);
  });
  await check('Returning to normal motion resumes the ticker and reversible timeline',async()=>{
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);await delay(250);
    const n=await page.evaluate(()=>logoFrameCount);await delay(150);assert(await page.evaluate(()=>logoFrameCount)>n);
    assert.equal(await page.$eval('#motion-toggle',e=>e.hidden),false);
    await page.$eval('#layers-toggle',e=>e.click());await delay(650);assert(isRest(await offsets(page)));
  });
  await check('Context loss restores readable fallback and hides inactive controls',async()=>{
    await page.evaluate(()=>logo.renderer.getContext().getExtension('WEBGL_lose_context').loseContext());
    await page.waitForFunction(()=>document.querySelector('.hero-visual').dataset.logoState==='fallback');
    assert(await page.$eval('.scene-controls',e=>e.hidden));
    assert(await page.evaluate(()=>logo.animation.parent===null));
    const n=await page.evaluate(()=>logoFrameCount);await delay(150);assert.equal(await page.evaluate(()=>logoFrameCount),n);
  });
  const mobile=await pageReady({mobile:true});await ready(mobile);
  await mobile.$eval('.hero-visual',e=>e.scrollIntoView({block:'center'}));await delay(500);
  await check('Mobile touch toggles layers and DPR is capped at 2',async()=>{
    assert.equal(await mobile.evaluate(()=>logo.renderer.getPixelRatio()),2);
    assert.equal((await offsets(mobile))[3][2],1.3);
    await mobile.tap('#layers-toggle');await delay(650);assert(isRest(await offsets(mobile)));
    await mobile.tap('#layers-toggle');await delay(650);assert.equal((await offsets(mobile))[3][2],1.3);
    await (await mobile.$('.hero-visual')).screenshot({path:out+'/mobile-hover.png'});
    await mobile.tap('#layers-toggle');await delay(650);assert(isRest(await offsets(mobile)));
    assert(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await (await mobile.$('.hero-visual')).screenshot({path:out+'/mobile.png'});
  });
  await check('ResizeObserver resizes canvas after a container-only resize',async()=>{
    await mobile.$eval('.hero-visual',e=>{e.style.width='300px';e.style.height='320px';});await delay(150);
    assert.deepEqual(await mobile.$eval('canvas',e=>[e.width,e.height]),[600,640]);
  });
  await mobile.close();
  await check('No WebGL retains the PNG and CSS fallback',async()=>{
    const p=await pageReady();await p.evaluateOnNewDocument(()=>{const original=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:original.call(this,type,...args);};});
    await p.goto('http://127.0.0.1:8080/',{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>document.querySelector('.hero-visual').dataset.logoState==='fallback');await delay(1500);
    assert(await p.$eval('.scene-controls',e=>e.hidden));await (await p.$('.hero-visual')).screenshot({path:out+'/fallback.png'});await p.close();
  });
  await check('CDN failure falls back without a blank hero',async()=>{
    const p=await pageReady();await p.setRequestInterception(true);p.on('request',r=>r.url().includes('/three@')?r.abort():r.continue());
    await p.goto('http://127.0.0.1:8080/',{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>document.querySelector('.hero-visual').dataset.logoState==='fallback');await p.close();
  });
  await check('Missing GSAP retains the native hover and touch controls',async()=>{
    const p=await pageReady();await p.setRequestInterception(true);
    p.on('request',r=>r.url().includes('/gsap@')?r.abort():r.continue());await ready(p);
    assert(await p.evaluate(()=>!window.gsap && !logo.animation));
    await p.$eval('#layers-toggle',e=>e.click());await delay(650);assert(isRest(await offsets(p)));
    await p.$eval('#layers-toggle',e=>e.click());await delay(650);assert.equal((await offsets(p))[3][2],1.3);
    await p.close();
  });
  await check('A delayed PNG does not block procedural rendering',async()=>{
    const p=await pageReady();await p.setRequestInterception(true);p.on('request',r=>{if(!r.url().endsWith('/img/logo.png'))r.continue();});
    await ready(p);assert.equal(await p.$eval('.hero-visual',e=>e.dataset.logoState),'ready');await p.close();
  });
  await check('No browser JavaScript errors',async()=>assert.deepEqual(errors,[]));
} finally {
  await writeFile(out+'/results.json',JSON.stringify(results,null,2));await browser.close();
}
