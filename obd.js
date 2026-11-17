"use strict";
/* ---------- OBD-II (SAE J1979) decoding and scanner links ---------- */
const u16=(a,b)=>a*256+b;
// key:[pid, data bytes, name, unit, decimals, decode]
const P={
 load:["04",1,"Engine load","%",0,a=>a/2.55], coolant:["05",1,"Coolant temperature","°C",0,a=>a-40],
 stft:["06",1,"Short fuel trim B1","%",1,a=>(a-128)/1.28], ltft:["07",1,"Long fuel trim B1","%",1,a=>(a-128)/1.28],
 stft2:["08",1,"Short fuel trim B2","%",1,a=>(a-128)/1.28], ltft2:["09",1,"Long fuel trim B2","%",1,a=>(a-128)/1.28],
 fuelp:["0A",1,"Fuel pressure","kPa",0,a=>a*3], map:["0B",1,"Manifold pressure","kPa",0,a=>a],
 rpm:["0C",2,"Engine speed","rpm",0,(a,b)=>u16(a,b)/4], speed:["0D",1,"Vehicle speed","km/h",0,a=>a],
 timing:["0E",1,"Ignition advance","°",1,a=>a/2-64], iat:["0F",1,"Intake air temperature","°C",0,a=>a-40],
 maf:["10",2,"Mass air flow","g/s",2,(a,b)=>u16(a,b)/100], tps:["11",1,"Throttle position","%",0,a=>a/2.55],
 o2s1:["14",2,"O2 sensor B1S1","V",3,a=>a/200], o2s2:["15",2,"O2 sensor B1S2","V",3,a=>a/200],
 runtime:["1F",2,"Run time","s",0,u16], railp:["23",2,"Fuel rail pressure","kPa",0,(a,b)=>u16(a,b)*10],
 lam1:["24",4,"Lambda B1S1","λ",3,(a,b)=>u16(a,b)/32768], egr:["2C",1,"Commanded EGR","%",0,a=>a/2.55],
 purge:["2E",1,"EVAP purge","%",0,a=>a/2.55], fuel:["2F",1,"Fuel level","%",0,a=>a/2.55],
 warmups:["30",1,"Warm-ups since clear","",0,a=>a], distclr:["31",2,"Distance since clear","km",0,u16],
 baro:["33",1,"Barometric pressure","kPa",0,a=>a], lam1c:["34",4,"Lambda B1S1 wideband","λ",3,(a,b)=>u16(a,b)/32768],
 cat1:["3C",2,"Catalyst temp B1S1","°C",0,(a,b)=>u16(a,b)/10-40], volt:["42",2,"Module voltage","V",2,(a,b)=>u16(a,b)/1000],
 absload:["43",2,"Absolute load","%",0,(a,b)=>u16(a,b)/2.55], lamcmd:["44",2,"Commanded lambda","λ",3,(a,b)=>u16(a,b)/32768],
 reltps:["45",1,"Relative throttle","%",0,a=>a/2.55], ambient:["46",1,"Ambient temperature","°C",0,a=>a-40],
 tpsb:["47",1,"Throttle position B","%",0,a=>a/2.55], appd:["49",1,"Accelerator pedal D","%",0,a=>a/2.55],
 appe:["4A",1,"Accelerator pedal E","%",0,a=>a/2.55], tac:["4C",1,"Commanded throttle","%",0,a=>a/2.55],
 ethanol:["52",1,"Ethanol content","%",0,a=>a/2.55], oil:["5C",1,"Oil temperature","°C",0,a=>a-40],
 injt:["5D",2,"Injection timing","°",1,(a,b)=>u16(a,b)/128-210], rate:["5E",2,"Fuel rate","L/h",2,(a,b)=>u16(a,b)/20],
 tqdem:["61",1,"Driver demand torque","%",0,a=>a-125], tqact:["62",1,"Actual engine torque","%",0,a=>a-125],
 tqref:["63",2,"Reference torque","Nm",0,u16], odo:["A6",4,"Odometer","km",1,(a,b,c,d)=>(a*16777216+b*65536+c*256+d)/10]
};
const BYPID={};for(const k in P)BYPID[P[k][0]]=k;
const TIER1=["rpm","speed","map","maf","tps","load","timing","rate","tqact"];
const h2=n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).toUpperCase().padStart(2,"0"),h4=n=>Math.max(0,Math.min(65535,Math.round(n))).toString(16).toUpperCase().padStart(4,"0");
const lines=r=>r.replace(/SEARCHING\.\.\./g,"").split(/[\r\n]+/).map(s=>s.replace(/\s+/g,"").toUpperCase()).filter(Boolean);
function payloads(resp){
  const ls=lines(resp).filter(l=>!/^(NODATA|OK|\?|STOPPED|UNABLETOCONNECT|CANERROR|BUSINIT.*|.*ERROR.*)$/.test(l));
  if(ls.some(l=>/^[0-9A-F]:/.test(l)))return [ls.filter(l=>/^[0-9A-F]:/.test(l)).map(l=>l.slice(2)).join("")];
  return ls}
const bytesOf=h=>{const b=[];for(let j=0;j+1<h.length;j+=2)b.push(parseInt(h.substr(j,2),16));return b};
/* decode a Mode 01 answer holding one or several PIDs → {key:value} */
function parse01(resp){
  const out={};
  for(const p of payloads(resp)){let i=p.indexOf("41");if(i<0||i>6)continue;i+=2;
    while(i+2<=p.length){const k=BYPID[p.substr(i,2)];if(!k)break;const n=P[k][1],b=bytesOf(p.substr(i+2,n*2));if(b.length<n||b.some(isNaN))break;out[k]=P[k][5](...b);i+=2+n*2}}
  return out}
function parseBits(resp,mode,base){const hdr=(0x40+mode).toString(16).toUpperCase()+h2(base);const out=[];
  for(const p of payloads(resp)){const i=p.indexOf(hdr);if(i<0||i>6)continue;const b=bytesOf(p.substr(i+4,8));if(b.length<4)continue;for(let j=0;j<32;j++)if(b[j>>3]&(0x80>>(j&7)))out.push(base+j+1)}
  return [...new Set(out)]}
function parseDtcs(resp,mode,can){
  const out=[],hdr=(0x40+mode).toString(16).toUpperCase();
  for(const p of payloads(resp)){if(!p.startsWith(hdr))continue;let d=p.slice(2);if(can)d=d.slice(2);
    for(let k=0;k+3<d.length;k+=4){const w=d.substr(k,4);if(w==="0000")continue;out.push(dtcName(w))}}
  return [...new Set(out)]}
const dtcName=w=>{const n=parseInt(w[0],16);return "PCBU"[n>>2]+(n&3)+w.slice(1)};
function parseAscii(resp,sid){const p=payloads(resp).join("");const i=p.indexOf("49"+sid);if(i<0)return null;let s="";for(const c of bytesOf(p.slice(i+6)))if(c>=32&&c<127)s+=String.fromCharCode(c);return s.trim()||null}
const parseVin=r=>{const s=(parseAscii(r,"02")||"").replace(/[^A-Z0-9]/g,"");return s.length>=17?s.slice(-17):null};
function parseReadiness(resp){const p=payloads(resp).find(x=>x.startsWith("4101"));if(!p)return null;const [a,b,c,d]=bytesOf(p.slice(4));
  const mons=[["Misfire",b&1,b&16],["Fuel system",b&2,b&32],["Components",b&4,b&64]];
  if(!(b&8))[["Catalyst",1],["Heated catalyst",2],["EVAP system",4],["Secondary air",8],["O2 sensor",32],["O2 sensor heater",64],["EGR / VVT",128]].forEach(([n,m])=>mons.push([n,c&m,d&m]));
  return {mil:!!(a&0x80),count:a&0x7F,monitors:mons.filter(m=>m[1]).map(m=>({name:m[0],ready:!m[2]}))}}
/* Mode 06 on CAN: records of MID TID UAS value min max */
const MID_NAME={0x01:"O2 sensor B1S1",0x02:"O2 sensor B1S2",0x21:"Catalyst B1",0x31:"EGR",0x35:"VVT B1",0x39:"EVAP (cap off)",0x3A:"EVAP 0.090\"",0x3B:"EVAP 0.040\"",0x3C:"EVAP 0.020\"",0x3D:"EVAP purge flow",0x41:"O2 heater B1S1",0x42:"O2 heater B1S2",0x81:"Fuel system B1",0xA1:"Misfire general",0xA2:"Misfire cylinder 1",0xA3:"Misfire cylinder 2",0xA4:"Misfire cylinder 3",0xA5:"Misfire cylinder 4"};
function parse06(resp){const out=[];for(const p of payloads(resp)){if(!p.startsWith("46"))continue;const b=bytesOf(p.slice(2));
    for(let i=0;i+8<b.length;i+=9){const [mid,tid,uas]=b.slice(i,i+3);if(!mid&&!tid)continue;const sg=uas>=0x80,s=v=>sg&&v>32767?v-65536:v;
      const v=s(u16(b[i+3],b[i+4])),mn=s(u16(b[i+5],b[i+6])),mx=s(u16(b[i+7],b[i+8]));
      out.push({mid,tid,uas,v,mn,mx,pass:v>=mn&&v<=mx,name:(MID_NAME[mid]||"Monitor $"+h2(mid))+(mid>=0xA1&&tid===0x0B?" · avg last 10 cycles":mid>=0xA1&&tid===0x0C?" · this cycle":" · test $"+h2(tid))})}}
  return out}

let logSink=()=>{};const log=s=>logSink(s);
const SERVICES=[0xfff0,0xffe0,0x18f0,0xae30,0xabf0,"e7810a71-73ae-499d-8c15-faa9aef0c3f2","49535343-fe7d-4ae5-8fa9-9fafd205e455","6e400001-b5a3-f393-e0a9-e50e24dcca9e"];
class BleLink{
  constructor(){this.buf="";this.q=Promise.resolve();this.waiter=null;this.dec=new TextDecoder();this.enc=new TextEncoder()}
  async open(){
    this.dev=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:SERVICES});
    log("Device: "+(this.dev.name||"unnamed"));
    this.dev.addEventListener("gattserverdisconnected",()=>{log("Scanner disconnected");this.onclose&&this.onclose()});
    const srv=await this.dev.gatt.connect();const svcs=await srv.getPrimaryServices();
    for(const s of svcs){const cs=await s.getCharacteristics();log("Service "+s.uuid+" · "+cs.length+" channels");
      const n=cs.find(c=>c.properties.notify||c.properties.indicate),w=cs.find(c=>c.properties.writeWithoutResponse||c.properties.write);
      if(n&&w){this.n=n;this.w=w;break}}
    if(!this.n)throw new Error("This device did not offer a data channel the app recognises.");
    await this.n.startNotifications();
    this.n.addEventListener("characteristicvaluechanged",e=>{this.buf+=this.dec.decode(e.target.value);if(this.buf.includes(">")&&this.waiter){const r=this.buf.replace(/>/g,"").trim();this.buf="";const w=this.waiter;this.waiter=null;w(r)}});
  }
  cmd(c,ms=5000){const run=()=>new Promise(async res=>{this.buf="";const t=setTimeout(()=>{this.waiter=null;res("")},ms);this.waiter=r=>{clearTimeout(t);res(r)};
      try{const data=this.enc.encode(c+"\r");if(this.w.properties.writeWithoutResponse&&this.w.writeValueWithoutResponse)await this.w.writeValueWithoutResponse(data);else await this.w.writeValue(data)}catch(e){clearTimeout(t);this.waiter=null;res("")}});
    return this.q=this.q.then(run,run)}
  close(){try{this.dev&&this.dev.gatt.disconnect()}catch(e){}}
}
/* built-in simulated car, answers the same commands a real scanner does */
class DemoLink{
  constructor(){this.t0=Date.now();this.rate=1;this.codes=["P0420"];this.demo=true;
    this.sup=[0x04,0x05,0x06,0x07,0x0B,0x0C,0x0D,0x0E,0x0F,0x11,0x15,0x1F,0x2F,0x31,0x33,0x42,0x44,0x46,0x49,0xA6,0x20,0x40,0x60,0x80,0xA0]}
  async open(){}
  st(){const t=(Date.now()-this.t0)/1000*this.rate,c=t%120;let v,thr,load;
    if(c<10){v=0;thr=0;load=22}else if(c<20){v=(c-10)*10.4;thr=100;load=95}else if(c<60){v=104-2*Math.sin((c-20)/6);thr=22;load=42}
    else if(c<68){v=104-(c-60)*6.75;thr=0;load=9}else if(c<100){v=50+2*Math.sin(c/4);thr=13;load=30}else if(c<104){v=50-(c-100)*12.5;thr=0;load=8}else{v=0;thr=0;load=22}
    v=Math.max(0,v);const rpm=v<1?700+18*Math.sin(t*1.7):c>=10&&c<20?2400+(c-10)*380:Math.max(1100,1150+v*9.5);
    return {t,v,rpm,load,thr,map:18+load*.8,cool:Math.min(90,34+t/3.5),fuel:62-t/500,volt:v<1&&c>=104?14.0:14.1,iat:18,amb:6,tim:8+(100-load)*.28,stft:2*Math.sin(t/3),odo:12000+t/60}}
  val(pid,s){return ({"04":h2(s.load*2.55),"05":h2(s.cool+40),"06":h2(128+s.stft*1.28),"07":h2(128-3.2),"0B":h2(s.map),"0C":h4(s.rpm*4),"0D":h2(s.v),"0E":h2((s.tim+64)*2),"0F":h2(s.iat+40),"11":h2(s.thr*2.55),"15":h2(150)+"FF","1F":h4(s.t),"2F":h2(s.fuel*2.55),"31":h4(420),"33":h2(89),"42":h4(s.volt*1000),"44":h4(32768),"46":h2(s.amb+40),"49":h2(s.thr*2.55),"A6":h4(Math.floor(s.odo*10/65536))+h4(Math.round(s.odo*10)%65536)})[pid]}
  mask(base){const b=[0,0,0,0];for(const p of this.sup)if(p>base&&p<=base+32){const i=p-base-1;b[i>>3]|=0x80>>(i&7)}return b.map(h2).join("")}
  async cmd(c){c=c.trim().toUpperCase();const s=this.st();
    if(c.startsWith("AT"))return c==="ATRV"?s.volt.toFixed(1)+"V":c==="ATDPN"?"A6":c==="ATZ"||c==="ATI"?"ELM327 v1.5 (demo)":"OK";
    if(c==="03")return "43"+h2(this.codes.length)+this.codes.map(x=>h2(("PCBU".indexOf(x[0])<<6)|(+x[1]<<4)|parseInt(x[2],16))+x.slice(3)).join("");
    if(c==="07")return "4700";if(c==="0A")return "4A00";if(c==="04"){this.codes=[];return "44"}
    if(c==="0902")return "014\r0:490201444D4F\r1:43415250554C53\r2:45303030303031";
    if(c==="0904")return "013\r0:49040144454D4F\r1:43414C30303030\r2:30303030310000";
    if(c==="0906")return "4906011A2B3C4D";
    if(c==="0101")return "4101"+h2((this.codes.length?0x80:0)|this.codes.length)+"076500";
    if(c==="0600")return "4600C0000001";if(c==="0620")return "462080000001";if(c==="0640"||c==="0660"||c==="0680")return "46"+c.slice(2)+"00000001";if(c==="06A0")return "46A060000000";
    if(c==="0601")return "4601800B010000500200";if(c==="0602")return "4602030A006400000C80";if(c==="0621")return "4621800200A000000100";
    if(c==="06A2")return "46A20B2400000000FFFFA20C2400000000FFFF";if(c==="06A3")return "46A30B2400020000FFFFA30C2400000000FFFF";
    if(c.startsWith("02")&&c.length===6){const pid=c.substr(2,2);if(pid==="02")return this.codes.length?"4202000420":"4202000000";const v=this.val(pid,s);return v?"42"+pid+"00"+v:"NO DATA"}
    if(c.startsWith("01")){let q=c.slice(2);if(q.length%2)q=q.slice(0,-1);
      if(q.length===2&&["00","20","40","60","80","A0"].includes(q))return "41"+q+this.mask(parseInt(q,16));
      let d="41";for(let i=0;i<q.length;i+=2){const v=this.val(q.substr(i,2),s);if(v)d+=q.substr(i,2)+v}
      if(d.length<=2)return "NO DATA";if(d.length<=14)return d;
      const out=[(d.length/2).toString(16).toUpperCase().padStart(3,"0"),"0:"+d.slice(0,12)];for(let i=12,n=1;i<d.length;i+=14,n++)out.push((n%16).toString(16).toUpperCase()+":"+d.substr(i,14).padEnd(14,"0"));return out.join("\r")}
    return "NO DATA"}
  close(){}
}

/* bring the scanner up and find out what the car offers */
async function initLink(link){
  for(const c of ["ATZ","ATE0","ATL0","ATS0","ATH0","ATSP0"])log(c+" → "+(await link.cmd(c,c==="ATZ"?6000:3000)).replace(/[\r\n]+/g," "));
  const r0=await link.cmd("0100",12000);log("0100 → "+r0.replace(/[\r\n]+/g," "));
  let sup=parseBits(r0,1,0);if(!sup.length)throw new Error("The scanner answered but the car did not. Turn the ignition on and try again.");
  for(const base of [0x20,0x40,0x60,0x80,0xA0]){if(!sup.includes(base))break;sup=sup.concat(parseBits(await link.cmd("01"+h2(base)),1,base))}
  const pn=(await link.cmd("ATDPN")).replace(/[^0-9A-F]/gi,""),isCan=parseInt(pn.slice(-1),16)>=6;
  const keys=Object.keys(P).filter(k=>sup.includes(parseInt(P[k][0],16)));
  let batch=false,one="";
  if(isCan&&keys.includes("rpm")&&keys.includes("speed")){const t=parse01(await link.cmd("010C0D",2500));batch=t.rpm!=null&&t.speed!=null}
  if(parse01(await link.cmd("010C1",2500)).rpm!=null)one="1";
  log(`Protocol ${pn} · ${keys.length} sensors · multi-request ${batch?"yes":"no"} · fast single ${one?"yes":"no"}`);
  return {sup,isCan,keys,batch,one,proto:pn}}
