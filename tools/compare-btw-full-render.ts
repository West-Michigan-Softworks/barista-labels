import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { importBtw } from '../server/btw.js';
import { compileProject, closeRenderer } from '../server/render.js';
const imported=importBtw(await readFile('research-artifacts/btw/mail-core.btw'),'mail-core.btw');
if(!imported.project)throw new Error(JSON.stringify(imported.diagnostics));
const directory='research-artifacts/zpl/btw-core-full-resolution';
const measurements:unknown[]=[];
try {
  for(const dpi of [203,300]) {
    const dotsPerMm=dpi/25.4;
    const reference=await sharp(`${directory}/bartender-core-${dpi}dpi.png`).greyscale().raw().toBuffer({resolveWithObject:true});
    const source=structuredClone(imported.project);
    for(const mapping of ['imported','unexpanded-path-control']) {
      const project=structuredClone(source);
      // The verified importer now normalizes the original centered pen into
      // canonical outer bounds. Undo that mapping only in a research control.
      if(mapping==='unexpanded-path-control')for(const e of project.templates[0].elements)if(e.type==='rectangle') {e.xUm+=Math.round(e.strokeUm/2);e.yUm+=Math.round(e.strokeUm/2);e.widthUm-=e.strokeUm;e.heightUm-=e.strokeUm;}
      const result=await compileProject(project,project.templates[0].id,{}, {dotsPerMm,widthDots:Math.round(104*dotsPerMm)},'research-artifacts');
      if(!result.zpl)throw new Error(JSON.stringify(result.diagnostics));
      const png=Buffer.from(result.previewBase64,'base64');
      const appPixels=await sharp(png).greyscale().raw().toBuffer();
      const width=result.widthDots,height=result.heightDots;
      if(reference.info.width!==width || reference.info.height!==height)throw new Error('Reference dimensions differ.');
      const bbox=(pixels:Buffer,left:number,top:number,right:number,bottom:number)=>{let x0=right,y0=bottom,x1=-1,y1=-1;for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(pixels[y*width+x]<128) {x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}return {left:x0,top:y0,right:x1,bottom:y1};};
      const rectROI=[Math.floor(width*.45),0,Math.floor(width*.85),Math.floor(height*.4)] as const;
      const textROI=[0,Math.floor(height*.4),Math.floor(width*.49),Math.floor(height*.8)] as const;
      const rbox=bbox(reference.data,...rectROI),abox=bbox(appPixels,...rectROI),rtext=bbox(reference.data,...textROI),atext=bbox(appPixels,...textROI);
      let boxPixelDifferences=0;
      for(let y=rectROI[1];y<rectROI[3];y++)for(let x=rectROI[0];x<rectROI[2];x++)if(appPixels[y*width+x]!==reference.data[y*width+x])boxPixelDifferences++;
      measurements.push({dpi,dotsPerMm,mapping,width,height,referenceBox:rbox,applicationBox:abox,boxPixelDifferences,referenceText:rtext,applicationText:atext});
      const variant=mapping;
      await writeFile(`${directory}/application-${dpi}dpi-${variant}.png`,png);
      await writeFile(`${directory}/application-${dpi}dpi-${variant}.zpl`,result.zpl);
      await writeFile(`${directory}/comparison-${dpi}dpi-${variant}.png`,await sharp({create:{width:width*2,height,channels:3,background:'#fff'}}).composite([{input:`${directory}/bartender-core-${dpi}dpi.png`,left:0,top:0},{input:png,left:width,top:0}]).png().toBuffer());
    }
  }
  await writeFile(`${directory}/metrics.json`,JSON.stringify({notice:'Direct image export, not driver ZPL or physical-print validation. Unexpanded-path control adjusts only a research clone to demonstrate centered-stroke mapping; no importer logic is changed by this script.',measurements},null,2));
  console.log(JSON.stringify(measurements,null,2));
}finally{await closeRenderer();}
