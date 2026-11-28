// Shared branding: labels work before JS and after a configured brand rename.
// Contrast is checked against the light header and dark footer surfaces.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=(() => { const dist = path.resolve(__dirname, '..', 'dist'); if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('website/dist not found. Run "npm --prefix website run build" first (tests run against the Astro build output).'); process.exit(1); } return dist; })();
function pages(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()&&!['tests','reference','dist-production'].includes(e.name)?pages(path.join(dir,e.name)):e.isFile()&&e.name==='index.html'?[path.join(dir,e.name)]:[]);}
let checks=0;function check(value,message){assert(value,message);checks++;}
const label='Every Real Estate Calculator Tools · Software · Guides, homepage';
const files=pages(root);check(files.length===30,'All thirty public pages checked'); // 30th page: resources/70-percent-rule (2026-11-28)
for(const file of files){
 const html=fs.readFileSync(file,'utf8');
 const links=Array.from(html.matchAll(/<a\b[^>]*class="brand"[^>]*>[\s\S]*?<\/a>/g),m=>m[0]);
 check(links.length===2,file+' has header and footer brand links');
 for(const link of links){
  check(link.includes('aria-label="'+label+'"'),file+' includes all visible brand text in the static name');
  check(/Every Real Estate Calculator<\/span>\s+<em>Tools/.test(link),file+' separates name and tagline in the text alternative');
  check(/<em>Tools (?:·|&middot;) Software (?:·|&middot;) Guides<\/em>/.test(link),file+' keeps the visible tagline');
  check(!/<(?:em|span)[^>]*aria-hidden="true"[^>]*>Tools/.test(link),file+' keeps tagline accessible');
 }
}
for(const tagline of ['Tools · Software · Guides','Tools & Guides','']){
 const brandNodes=[{},{}];
 const link={querySelector(){return tagline?{textContent:tagline}:null;},setAttribute(name,value){this[name]=value;}};
 const document={title:'About | Every Real Estate Calculator',querySelectorAll(selector){return selector==='[data-brand-name]'?brandNodes:selector==='.brand[aria-label]'?[link]:[];}};
 const config=fs.readFileSync(path.join(root,'assets/site-config.js'),'utf8').replace("brandName: 'Every Real Estate Calculator'","brandName: 'Configured Brand'");
 vm.runInNewContext(config,{window:{},document});
 check(brandNodes.every(n=>n.textContent==='Configured Brand'),'Configured visible name updated');
 check(link['aria-label']===['Configured Brand',tagline].filter(Boolean).join(' ')+', homepage','Accessible name includes configured brand and actual tagline');
 check(document.title==='About | Configured Brand','Configured page title preserved');
}
function luminance(hex){const rgb=hex.match(/\w\w/g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb.reduce((a,c,i)=>a+c*[.2126,.7152,.0722][i],0);}
function contrast(a,b){const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
const css=fs.readFileSync(path.join(root,'assets/theme.css'),'utf8');
const header=css.match(/\.brand-name em\s*\{[^}]*color:#([a-f0-9]{6})/i)[1];
const footer=css.match(/\.footer-top \.brand-name em\s*\{[^}]*color:#([a-f0-9]{6})/i)[1];
check(contrast(header,'FFFFFF')>=4.5,'Header small text meets AA contrast');
check(contrast(footer,'102131')>=4.5,'Footer small text meets AA contrast');
console.log(`PASS: ${checks} shared-brand assertions across 23 public pages; header ${contrast(header,'FFFFFF').toFixed(2)}:1, footer ${contrast(footer,'102131').toFixed(2)}:1; static names, configured names and visible tagline preserved.`);
