import { readFile, mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { importBtw } from '../server/btw.js';
import { compileProject, closeRenderer } from '../server/render.js';

const imported=importBtw(await readFile('research-artifacts/btw/mail-core.btw'),'mail-core.btw');
if(!imported.project)throw new Error(JSON.stringify(imported.diagnostics));
const directory='research-artifacts/zpl/btw-core-comparison';
await mkdir(directory,{recursive:true});
const reference=await sharp('research-artifacts/btw/mail-core-preview.png').extract({left:0,top:219,width:876,height:438}).png().toBuffer();
await writeFile(`${directory}/bartender-label-thumbnail.png`,reference);
const metrics:unknown[]=[];
try {
  for(const dotsPerMm of [8,12]) {
    const result=await compileProject(imported.project,imported.project.templates[0].id,{}, {dotsPerMm,widthDots:104*dotsPerMm},'research-artifacts');
    if(!result.zpl)throw new Error(JSON.stringify(result.diagnostics));
    const own=Buffer.from(result.previewBase64,'base64');
    await writeFile(`${directory}/${dotsPerMm}dpm.png`,own);
    await writeFile(`${directory}/${dotsPerMm}dpm.zpl`,result.zpl);
    const refScaled=await sharp(reference).resize(result.widthDots,result.heightDots,{kernel:'nearest'}).flatten({background:'#fff'}).greyscale().threshold(128).raw().toBuffer();
    const ownPixels=await sharp(own).greyscale().raw().toBuffer();
    const bbox=(pixels:Buffer,left:number,top:number,right:number,bottom:number)=> {
      let x0=right,y0=bottom,x1=-1,y1=-1;
      for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(pixels[y*result.widthDots+x]<128) {x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
      return {left:x0,top:y0,right:x1,bottom:y1};
    };
    const margin=Math.round(2*dotsPerMm);
    metrics.push({dotsPerMm,widthDots:result.widthDots,heightDots:result.heightDots,
      referenceText:bbox(refScaled,margin,Math.floor(result.heightDots*.4),Math.floor(result.widthDots*.49),Math.floor(result.heightDots*.8)),
      applicationText:bbox(ownPixels,margin,Math.floor(result.heightDots*.4),Math.floor(result.widthDots*.49),Math.floor(result.heightDots*.8)),
      referenceBox:bbox(refScaled,Math.floor(result.widthDots*.45),margin,Math.floor(result.widthDots*.85),Math.floor(result.heightDots*.4)),
      applicationBox:bbox(ownPixels,Math.floor(result.widthDots*.45),margin,Math.floor(result.widthDots*.85),Math.floor(result.heightDots*.4))});
    await writeFile(`${directory}/${dotsPerMm}dpm-comparison.png`,await sharp({create:{width:result.widthDots*2,height:result.heightDots,channels:3,background:'#fff'}}).composite([{input:await sharp(reference).resize(result.widthDots,result.heightDots).png().toBuffer(),left:0,top:0},{input:own,left:result.widthDots,top:0}]).png().toBuffer());
  }
  await writeFile(`${directory}/metrics.json`,JSON.stringify({warning:'Comparison uses embedded BarTender thumbnail, not printer-resolution reference ZPL. Bounds reflect thumbnail resampling and cannot establish physical or ZPL parity.',metrics},null,2));
  console.log(JSON.stringify(metrics,null,2));
}finally{await closeRenderer();}
