"use strict";
/* ---------- settings, storage, trip maths, learning ---------- */
const S=Object.assign({tank:47,disp:2.0,mass:1380,cda:0.62,crr:0.010,eta:0.88,geo:15},JSON.parse(localStorage.getItem("cp-settings")||"{}"));
const saveS=()=>localStorage.setItem("cp-settings",JSON.stringify(S));
const RHO=1.2,G=9.81,E_FUEL=32.6e6,CO2=2.29; // air kg/m3, m/s2, J per litre (E10), kg CO2 per litre
const BANDS=[[0,30],[30,60],[60,90],[90,110],[110,999]],RB=500,NR=13,NL=10; // rpm bins 500..7000, load bins 10 %

const openDb=()=>new Promise((res,rej)=>{const r=indexedDB.open("carpulse",2);r.onupgradeneeded=()=>{const d=r.result;for(const s of ["trips","raw","fills"])if(!d.objectStoreNames.contains(s))d.createObjectStore(s,{keyPath:"id"})};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const dbDo=async(st,mode,fn)=>{const d=await openDb();return new Promise((res,rej)=>{const t=d.transaction(st,mode),rq=fn(t.objectStore(st));t.oncomplete=()=>res(rq&&rq.result);t.onerror=()=>rej(t.error)})};
const Store=st=>({all:()=>dbDo(st,"readonly",s=>s.getAll()),get:id=>dbDo(st,"readonly",s=>s.get(id)),put:o=>dbDo(st,"readwrite",s=>s.put(o)),del:id=>dbDo(st,"readwrite",s=>s.delete(id))});
const Trips=Store("trips"),Raw=Store("raw"),Fills=Store("fills");

const median=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2};
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const sd=a=>{if(a.length<3)return null;const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))};
/* air flow from manifold pressure (speed-density) when there is no air-flow sensor */
const mafFromMap=(rpm,map,iatC,disp)=>rpm*map/(iatC+273.15)/120*0.85*disp*28.97/8.314;
const lphRaw=d=>d.rate!=null?d.rate:d.maf!=null?d.maf*3600/(14.7*745):(d.rpm!=null&&d.map!=null)?mafFromMap(d.rpm,d.map,d.iat??25,S.disp)*3600/(14.7*745):null;

class Trip{
  constructor(start,src){Object.assign(this,{id:start,start,src,dist:0,fuel:0,dur:0,idle:0,dfco:0,maxV:0,maxR:0,maxC:null,brakes:0,accels:0,eAero:0,eRoll:0,eBrake:0,idleFuel:0,
      bands:BANDS.map(()=>[0,0]),grid:{},s:{t:[],v:[],r:[],c:[],f:[],p:[]},perf:{},pull:null,startC:null,amb:null,tWarm:null,restV:null,crankMin:null,odo0:null,odo1:null});
    this._={h:[],lt:null,lv:null,ls:-9,le:-9,lr:-9,a:0,warm:[],chg:[],idleR:[],lt2:[],pull:null,z0:null,zok:false,t80:null,keys:null,rows:[],pk:0}}
  add(t,d){const _=this._;
    const v=d.speed??0,ms=v/3.6;
    if(d.coolant!=null){if(this.startC==null)this.startC=d.coolant;if(this.tWarm==null&&d.coolant>=80)this.tWarm=t;if(this.maxC==null||d.coolant>this.maxC)this.maxC=d.coolant}
    if(d.ambient!=null&&this.amb==null)this.amb=d.ambient;
    if(d.odo!=null){if(this.odo0==null)this.odo0=d.odo;this.odo1=d.odo}
    if(d.volt!=null){if((d.rpm??0)<50)this.restV=d.volt;else if(d.rpm<600&&t<20)this.crankMin=Math.min(this.crankMin??99,d.volt);else if(d.rpm>1000)_.chg.push(d.volt)}
    if(_.lt!=null){const dt=t-_.lt;if(dt<0.15)return;
      if(dt<30){
        // acceleration over a ~1 s window: speed arrives in 1 km/h steps, so sample-to-sample differences are noise
        _.h.push([t,ms]);while(_.h.length>2&&t-_.h[0][0]>1.2)_.h.shift();const sp=t-_.h[0][0];if(sp>=0.45)_.a=(ms-_.h[0][1])/sp;
        // fuel cut on overrun: no injection, so the air-flow estimate would over-read
        let lph=d.lph;if(lph!=null&&d.rate==null&&d.rpm>1150&&v>15&&_.a<-0.25&&(d.load??50)<16){lph=0;this.dfco+=dt}
        d.lphEff=lph;const dd=v*dt/3600,df=lph!=null?lph*dt/3600:0;
        this.dist+=dd;this.dur+=dt;this.fuel+=df;if(v<1&&(d.rpm??0)>300){this.idle+=dt;this.idleFuel+=df}
        const b=BANDS.findIndex(x=>v>=x[0]&&v<x[1]);if(b>=0&&v>=1){this.bands[b][0]+=dd;this.bands[b][1]+=df}
        const pA=.5*RHO*S.cda*ms**3,pR=S.mass*G*S.crr*ms,pW=pA+pR+S.mass*1.04*_.a*ms;d.kw=Math.max(0,pW)/S.eta/1000;
        this.eAero+=pA*dt;this.eRoll+=pR*dt;if(pW<0)this.eBrake+=-pW*dt;
        if(t-_.le>3){if(_.a<-3.0){this.brakes++;_.le=t}else if(_.a>2.5){this.accels++;_.le=t}}
        if(d.rpm>300&&d.load!=null){const k=Math.min(NR-1,Math.floor(d.rpm/RB))*NL+Math.min(NL-1,Math.floor(d.load/10)),c=this.grid[k]||(this.grid[k]=[0,0,0,0,0,0,0]);
          c[0]+=dt;if(d.timing!=null){c[1]+=d.timing*dt;c[5]+=dt}if(d.ltft!=null){c[2]+=(d.ltft+(d.stft||0))*dt;c[6]+=dt}if(lph!=null&&d.kw>4&&_.a>-0.1){c[3]+=lph*dt;c[4]+=d.kw*dt}}
        // full-throttle pull → power curve
        const wot=(d.tps??d.appd??0)>=80||(d.load??0)>=88;
        if(wot&&d.rpm>1500&&_.a>0.3&&v>8){(_.pull||(_.pull=[])).push([Math.round(d.rpm),Math.round(d.kw*10)/10])}
        else if(_.pull){const p=_.pull;_.pull=null;const rs=p.map(x=>x[0]);if(p.length>=4&&Math.max(...rs)-Math.min(...rs)>=1000){p.sort((x,y)=>x[0]-y[0]);const pk=Math.max(...p.map(x=>x[1]));if(pk>_.pk){_.pk=pk;this.pull={pts:p,peak:pk}}}}
        // 0–100 and 80–120 timers, crossing times interpolated
        const cross=(lim)=>_.lv<lim&&v>=lim?_.lt+dt*(lim-_.lv)/(v-_.lv||1):null;
        if(v<=1){_.z0=t;_.zok=true}else if(v<_.lv-3)_.zok=false;
        const c100=cross(100);if(c100!=null&&_.zok&&_.z0!=null&&c100-_.z0<40){const z=c100-_.z0;if(!this.perf.z100||z<this.perf.z100)this.perf.z100=Math.round(z*10)/10;_.zok=false}
        const c80=cross(80);if(c80!=null)_.t80=c80;if(v<_.lv-3)_.t80=null;
        const c120=cross(120);if(c120!=null&&_.t80!=null){const r=c120-_.t80;if(r<40&&(!this.perf.r80||r<this.perf.r80))this.perf.r80=Math.round(r*10)/10;_.t80=null}
        if(v<1&&d.rpm>400&&d.coolant>75)_.idleR.push(d.rpm);
        if(d.coolant>80){_.warm.push(d.coolant);if(d.ltft!=null)_.lt2.push(d.ltft)}
      }}
    _.lt=t;_.lv=v;if(v>this.maxV)this.maxV=v;if(d.rpm>this.maxR)this.maxR=d.rpm;
    const r1=x=>x==null?null:Math.round(x*10)/10;
    if(t-_.ls>=2){_.ls=t;const s=this.s;s.t.push(Math.round(t));s.v.push(r1(d.speed));s.r.push(d.rpm==null?null:Math.round(d.rpm));s.c.push(r1(d.coolant));s.f.push(r1(d.lphEff??d.lph));s.p.push(r1(d.kw))}
    if(t-_.lr>=1&&_.rows.length<20000){_.lr=t;if(!_.keys)_.keys=[];for(const k in d)if(typeof d[k]==="number"&&!_.keys.includes(k))_.keys.push(k);_.rows.push([Math.round(t*10)/10,..._.keys.map(k=>d[k]==null?null:Math.round(d[k]*1000)/1000)])}}
  get avg(){return this.dist>0.3&&this.fuel>0?this.fuel/this.dist*100:null}
  data(){const o={},_=this._;for(const k of Object.keys(this))if(k!=="_")o[k]=this[k];
    Object.assign(o,{avg:this.avg,score:score(this),warmC:median(_.warm),chargeV:median(_.chg),idleMean:mean(_.idleR),idleSd:_.idleR.length>15?sd(_.idleR):null,ltft:median(_.lt2)});return o}
  raw(){return {id:this.id,keys:["t",...(this._.keys||[])],rows:this._.rows}}
}
const score=t=>{const per10=(t.brakes+t.accels)/Math.max(t.dist/10,1),idlePct=t.dur?t.idle/t.dur*100:0;return Math.max(0,Math.min(100,Math.round(100-6*per10-Math.max(0,idlePct-20)*0.5)))};

/* everything the app has learned, rebuilt from saved trips and fill-ups */
const METRICS=[["ltft","Long fuel trim","%",1],["idleMean","Warm idle speed","rpm",0],["idleSd","Idle stability (σ)","rpm",0],["warmC","Running temperature","°C",0],["chargeV","Charging voltage","V",2],["restV","Battery at rest","V",2],["crankMin","Cranking voltage","V",2]];
function buildModel(trips,fills){
  const m={k:1,kN:0,grid:{},bands:BANDS.map(()=>[0,0]),dist:0,fuel:0,dur:0,idle:0,dfco:0,norm:{},alerts:[],best:{},warm:[],fillStats:{}};
  const ts=[...trips].sort((a,b)=>a.start-b.start),real=ts.filter(t=>t.src!=="demo"),use=real.length?real:ts;
  for(const t of use){m.dist+=t.dist;m.fuel+=t.fuel;m.dur+=t.dur;m.idle+=t.idle;m.dfco+=t.dfco||0;
    (t.bands||[]).forEach((b,i)=>{m.bands[i][0]+=b[0];m.bands[i][1]+=b[1]});
    for(const k in t.grid||{}){const c=m.grid[k]||(m.grid[k]=[0,0,0,0,0,0,0]);t.grid[k].forEach((x,i)=>c[i]+=x)}
    if(t.perf&&t.perf.z100&&(!m.best.z100||t.perf.z100<m.best.z100))m.best.z100=t.perf.z100;
    if(t.perf&&t.perf.r80&&(!m.best.r80||t.perf.r80<m.best.r80))m.best.r80=t.perf.r80;
    if(t.pull&&(!m.best.pull||t.pull.peak>m.best.pull.peak))m.best.pull=t.pull;
    if(t.tWarm!=null&&t.startC!=null&&t.startC<45)m.warm.push({amb:t.amb,start:t.startC,s:t.tWarm})}
  for(const [key,label,unit,dp] of METRICS){const vals=use.map(t=>t[key]).filter(x=>x!=null&&isFinite(x));if(vals.length<3)continue;
    const prev=vals.slice(0,-1),med=median(prev),mad=median(prev.map(x=>Math.abs(x-med)))*1.4826,floor={ltft:1.5,idleMean:25,idleSd:8,warmC:2,chargeV:.15,restV:.12,crankMin:.3}[key],w=Math.max(mad,floor),last=vals[vals.length-1];
    m.norm[key]={label,unit,dp,med,lo:med-2*w,hi:med+2*w,last,n:vals.length,series:vals.slice(-30)};
    if(prev.length>=5&&Math.abs(last-med)>3.5*w)m.alerts.push(`${label} was ${last.toFixed(dp)} ${unit} on the last trip; your usual is ${(med-2*w).toFixed(dp)} to ${(med+2*w).toFixed(dp)}.`)}
  // calibrate the sensor fuel estimate against what actually went into the tank
  const fs=[...fills].sort((a,b)=>a.ts-b.ts),ratios=[];
  for(let i=1;i<fs.length;i++){const a=fs[i-1],b=fs[i];if(!a.full||!b.full)continue;const tr=real.filter(t=>t.start>a.ts&&t.start<=b.ts),ef=tr.reduce((x,t)=>x+t.fuel,0),ed=tr.reduce((x,t)=>x+t.dist,0);
    let r=null;if(a.odo&&b.odo&&b.odo-a.odo>30){b.real=b.litres/(b.odo-a.odo)*100;if(ed>30&&ef>2)r=b.real/(ef/ed*100)}else if(ef>5){r=b.litres/ef;if(ed>30)b.real=b.litres/ed*100}
    if(r&&r>0.6&&r<1.6)ratios.push(r)}
  if(ratios.length){m.k=mean(ratios.slice(-3));m.kN=ratios.length}
  m.avg=m.dist>1&&m.fuel>0?m.fuel*m.k/m.dist*100:null;
  const spent=fs.reduce((x,f)=>x+f.litres*f.cents/100,0),lit=fs.reduce((x,f)=>x+f.litres,0);m.fillStats={spent,lit,avgCents:lit?spent/lit*100:null,last:fs[fs.length-1]||null,fills:fs};
  return m}
/* coast-down fit: a = -(g·Crr + ρ·CdA·v²/2m) → least squares of deceleration against v² */
function fitCoast(pts,mass){ // pts: [t s, v km/h]
  const xs=[],ys=[];for(let i=3;i<pts.length;i++){const dt=pts[i][0]-pts[i-3][0];if(dt<=0)continue;const v=(pts[i][1]+pts[i-3][1])/2/3.6;xs.push(v*v);ys.push(-(pts[i][1]-pts[i-3][1])/3.6/dt)}
  if(xs.length<8)return null;const mx=mean(xs),my=mean(ys);let sxy=0,sxx=0;xs.forEach((x,i)=>{sxy+=(x-mx)*(ys[i]-my);sxx+=(x-mx)**2});if(!sxx)return null;
  const B=sxy/sxx,A=my-B*mx;return {crr:A/G,cda:2*mass*1.04*B/RHO,n:xs.length}}
/* Statistics Canada table 18-10-0001: monthly average retail price, regular unleaded, self service, cents per litre */
async function fetchPrices(){
  const r=await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify([{productId:18100001,coordinate:S.geo+".2.0.0.0.0.0.0.0.0",latestN:36}])});
  const j=await r.json();if(!j[0]||j[0].status!=="SUCCESS")throw new Error("no data");
  const o={};for(const p of j[0].object.vectorDataPoint)if(p.value!=null)o[p.refPer.slice(0,7)]=p.value;
  localStorage.setItem("cp-prices",JSON.stringify({at:Date.now(),geo:S.geo,o}));return o}
async function priceFor(dateStr){ // "YYYY-MM-DD" → {cents, month, exact}
  let c=JSON.parse(localStorage.getItem("cp-prices")||"null"),o=c&&c.geo===S.geo?c.o:null;
  if(!o||Date.now()-c.at>864e5){try{o=await fetchPrices()}catch(e){if(!o)return null}}
  const ym=dateStr.slice(0,7),months=Object.keys(o).sort();if(!months.length)return null;
  if(o[ym]!=null)return {cents:o[ym],month:ym,exact:true};
  const m=months.filter(x=>x<=ym).pop()||months[0];return {cents:o[m],month:m,exact:false}}
const GEO={20:"Canada",14:"Edmonton",15:"Calgary",16:"Vancouver",17:"Victoria",12:"Regina",13:"Saskatoon",11:"Winnipeg",9:"Toronto",8:"Ottawa",7:"Montréal",6:"Québec",4:"Halifax",5:"Saint John",2:"St. John's",3:"Charlottetown",10:"Thunder Bay",18:"Whitehorse",19:"Yellowknife"};
