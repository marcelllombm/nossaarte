// Uses the existing Chrome DevTools browser bundle; no browser/tool installation.
import { puppeteer } from '/Users/macmini2/.npm/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp/out/Default/gen/src/third_party/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
const pass = process.argv[2] || 'blockout';
const dir = `.img2threejs/evidence/${pass}`;
await mkdir(dir, { recursive: true });
const browser = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true, userDataDir:'/private/tmp/nossaarte-chrome-review', args:['--no-first-run','--no-default-browser-check'] });
try {
  const page=await browser.newPage(); await page.setViewport({width:416,height:416,deviceScaleFactor:1});
  page.on('pageerror',error=>console.error(error.message));
  await page.goto('http://127.0.0.1:8080/.img2threejs/preview.html',{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>window.ready,{timeout:30000});
  for(const [name,angle] of [['front',0],['right',90],['rear',180],['left',270],['oblique',35],['oblique-left',-35]]) {
    await page.evaluate(angle=>{review.model.root.rotation.y=angle*Math.PI/180;review.render();},angle);
    await page.screenshot({path:`${dir}/${name}.png`});
  }
  await writeFile(`${dir}/runtime.json`,JSON.stringify(await page.evaluate(()=>({
    triangles:review.renderer.info.render.triangles,drawCalls:review.renderer.info.render.calls,
    parts:review.model.parts.map(p=>({name:p.name,kind:'part',position:p.position.toArray()})),unnamedMeshes:0
  })),null,2));
  await writeFile(`${dir}/meshes.json`,JSON.stringify(await page.evaluate(()=>{
    const meshes=[];
    review.model.root.traverse(o=>{if(!o.geometry)return;
      const p=o.geometry.attributes.position,n=o.geometry.attributes.normal;
      meshes.push({name:o.userData.partId||o.name,
        vertices:Array.from({length:p.count},(_,i)=>[p.getX(i),p.getY(i),p.getZ(i)]),
        normals:Array.from({length:n.count},(_,i)=>[n.getX(i),n.getY(i),n.getZ(i)]),
        indices:o.geometry.index?Array.from(o.geometry.index.array):Array.from({length:p.count},(_,i)=>i)});
    });return {meshes};
  })));
} finally { await browser.close(); }
console.log(dir);
