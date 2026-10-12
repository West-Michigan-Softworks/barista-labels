import { mkdir, writeFile } from 'node:fs/promises';
import { compileProject, closeRenderer } from '../server/render.js';
import type { Project } from '../shared/model.js';

// Original public-safe labels for compiler comparisons; these are not
// BarTender output and must not be presented as a BarTender parity corpus.
const project: Project = {
  schemaVersion:1,id:'render-reference',name:'Original renderer comparison label',
  templates:[{id:'reference',name:'4 x 2 inch',widthUm:101600,heightUm:50800,elements:[
    {id:'heading',name:'Heading',type:'text',xUm:5000,yUm:3000,widthUm:90000,heightUm:8000,rotation:0,locked:false,text:'BARISTA LABEL TEST',fontFamily:'Arial',fontSizeUm:5000,bold:false,align:'left'},
    {id:'line',name:'Divider',type:'line',xUm:5000,yUm:12000,widthUm:90000,heightUm:125,rotation:0,locked:false,strokeUm:125,fill:'none'},
    {id:'barcode',name:'Code 128',type:'barcode',xUm:5000,yUm:15000,widthUm:65000,heightUm:18000,rotation:0,locked:false,symbology:'code128',value:'LOCAL-123'},
    {id:'rectangle',name:'Native box',type:'rectangle',xUm:78000,yUm:15000,widthUm:16000,heightUm:18000,rotation:0,locked:false,strokeUm:250,fill:'none'},
    {id:'caption',name:'Caption',type:'text',xUm:5000,yUm:36000,widthUm:90000,heightUm:10000,rotation:0,locked:false,text:'Café • {{item}}',fontFamily:'Arial',fontSizeUm:3500,bold:false,align:'left'},
  ]}],variables:[{name:'item',defaultValue:'LOCAL-123'}],assets:[],importDiagnostics:[]
};
const directory='research-artifacts/zpl/standalone';
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/project.json`,JSON.stringify(project,null,2));
try {
  for(const dotsPerMm of [8,12,24]) {
    const profile={dotsPerMm,widthDots:104*dotsPerMm,offsetX:0,offsetY:0,media:'gap' as const};
    const compiled=await compileProject(project,'reference',{},profile,'research-artifacts');
    if(compiled.diagnostics.some(d=>d.severity==='error'))throw new Error(JSON.stringify(compiled.diagnostics));
    await writeFile(`${directory}/${dotsPerMm}dpm.zpl`,compiled.zpl);
    await writeFile(`${directory}/${dotsPerMm}dpm.png`,Buffer.from(compiled.previewBase64,'base64'));
    await writeFile(`${directory}/${dotsPerMm}dpm.json`,JSON.stringify({profile,widthDots:compiled.widthDots,heightDots:compiled.heightDots,diagnostics:compiled.diagnostics},null,2));
    console.log(`${dotsPerMm} dots/mm: ${compiled.widthDots} × ${compiled.heightDots}; ${compiled.zpl.length} ZPL characters`);
  }
}finally{await closeRenderer();}
